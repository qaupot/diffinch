use super::{file_history::validate_file_path, process::execute, GitError, Repo, Result};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Deserialize)]
pub struct EditorCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl Repo {
    fn editor_file(&self, file: &str) -> Result<PathBuf> {
        validate_file_path(file)?;
        let root = self
            .root()
            .canonicalize()
            .map_err(|error| GitError::new("gitIoFailed", error))?;
        let path = root.join(file);
        let resolved = path
            .canonicalize()
            .map_err(|error| GitError::new("editorFileUnavailable", error))?;
        // Do not let a repository symlink redirect an editor outside this checkout,
        // or into Git metadata. Existing regular files only.
        if resolved != path || !resolved.starts_with(&root) || !resolved.is_file() {
            return Err("editorFileUnavailable".into());
        }
        Ok(resolved)
    }

    pub(super) fn open_editor(&self, file: &str, editor: EditorCommand) -> Result<()> {
        let file = self.editor_file(file)?;
        if editor.program.trim().is_empty()
            || editor.program.contains(['\0', '\n', '\r'])
            || editor.args.len() > 64
            || editor
                .args
                .iter()
                .any(|arg| arg.len() > 8192 || arg.contains('\0'))
        {
            return Err("invalidEditorCommand".into());
        }
        // No shell expansion. Arguments are supplied separately, and the file is
        // always an absolute path, so a leading dash cannot become an option.
        let mut command = Command::new(editor_program(&editor.program)?);
        command
            .args(editor.args)
            .arg(file)
            .current_dir(self.root())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| GitError::new("editorStartFailed", error))?;
        // An editor can stay open for hours. Reap it independently of Git's gate.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    pub(super) fn merge_tool(&self, id: &str) -> Result<()> {
        let (file, paths) = self.file(id)?;
        if !file.conflict || file.submodule || paths.len() != 1 {
            return Err("staleConflict".into());
        }
        // Apply the same filesystem boundary as the built-in conflict editor.
        self.conflict_path(id)?;
        let gui = self.optional_config(&["--get", "merge.guitool"])?;
        let tool = if gui.is_empty() {
            self.optional_config(&["--get", "merge.tool"])?
        } else {
            gui
        };
        if tool.is_empty() {
            return Err("mergeToolNotConfigured".into());
        }
        // Git's interactive success prompt cannot work in a desktop process.
        // Require an explicit exit-status contract instead of guessing success.
        let trusted = self.optional_config(&[
            "--bool",
            "--get",
            &format!("mergetool.{tool}.trustExitCode"),
        ])?;
        if trusted != "true" {
            return Err("mergeToolNeedsExitCode".into());
        }
        let mut command = self.command();
        command
            .args(["--literal-pathspecs", "mergetool", "--no-prompt"])
            .arg(format!("--tool={tool}"))
            .arg("--")
            .args(paths);
        execute(command, &[], None)?;
        if self
            .status()?
            .files
            .iter()
            .any(|item| item.id == id && item.conflict)
        {
            return Err("mergeToolUnresolved".into());
        }
        Ok(())
    }
}

fn editor_program(program: &str) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        // Rust runs .cmd/.bat through cmd.exe, which would interpret characters
        // in a repository filename. Launch only a real executable on Windows.
        let path = Path::new(program);
        if path.is_absolute() {
            return if path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
            {
                Ok(path.to_path_buf())
            } else {
                Err("invalidEditorCommand".into())
            };
        }
        if path.components().count() != 1
            || path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| !extension.eq_ignore_ascii_case("exe"))
        {
            return Err("invalidEditorCommand".into());
        }
        let bundled = match program {
            "code" => Some("Microsoft VS Code/Code.exe"),
            "cursor" => Some("cursor/Cursor.exe"),
            "zed" => Some("Zed/zed.exe"),
            "subl" => Some("Sublime Text/subl.exe"),
            _ => None,
        };
        if let Some(relative) = bundled {
            let roots = [
                std::env::var_os("LOCALAPPDATA").map(|root| PathBuf::from(root).join("Programs")),
                std::env::var_os("ProgramFiles").map(PathBuf::from),
            ];
            for root in roots.into_iter().flatten() {
                let candidate = root.join(relative);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        let executable = if path.extension().is_some() {
            program.to_owned()
        } else {
            format!("{program}.exe")
        };
        for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
            let candidate = directory.join(&executable);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        return Err(GitError::new(
            "editorStartFailed",
            "Choose the editor's .exe file in External tools.",
        ));
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        if !Path::new(program).is_absolute() {
            let bundled = match program {
                "code" => {
                    Some("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
                }
                "cursor" => Some("/Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
                "zed" => Some("/Applications/Zed.app/Contents/MacOS/cli"),
                "subl" => Some("/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"),
                _ => None,
            };
            if let Some(path) = bundled.filter(|path| Path::new(path).is_file()) {
                return Ok(path.into());
            }
        }
        Ok(Path::new(program).to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        tests::{commit_file, repo},
        Action,
    };
    use super::*;

    #[test]
    fn rejects_missing_files_and_paths_outside_the_checkout() {
        let (_dir, repo) = repo();
        commit_file(&repo, "file.txt", "text", "Base");
        assert!(repo.editor_file("file.txt").is_ok());
        for path in ["../outside", ".git/config", "missing.txt", "/etc/passwd"] {
            assert!(repo.editor_file(path).is_err(), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(repo.root().join("file.txt"), repo.root().join("link.txt"))
                .unwrap();
            assert!(repo.editor_file("link.txt").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn passes_editor_arguments_literally_and_does_not_wait_for_the_editor() {
        use std::{
            fs,
            os::unix::fs::PermissionsExt,
            time::{Duration, Instant},
        };
        let (dir, repo) = repo();
        let file = "--name with spaces.txt";
        commit_file(&repo, file, "text", "Base");
        let script = dir.path().join("fake-editor");
        fs::write(&script, "#!/bin/sh\nprintf '%s\\n' \"$@\" > editor-args\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        repo.open_editor(
            file,
            EditorCommand {
                program: script.to_string_lossy().into(),
                args: vec!["$(touch should-not-exist)".into()],
            },
        )
        .unwrap();
        let start = Instant::now();
        while !dir.path().join("editor-args").exists() && start.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let args = fs::read_to_string(dir.path().join("editor-args")).unwrap();
        assert!(args.starts_with("$(touch should-not-exist)\n"));
        assert!(args.contains(repo.root().join(file).to_str().unwrap()));
        assert!(!dir.path().join("should-not-exist").exists());
    }

    #[test]
    fn configured_merge_tool_resolves_the_selected_conflict() {
        let (_dir, repo) = repo();
        commit_file(&repo, "conflict.txt", "base\n", "Base");
        repo.run(["checkout", "-b", "other"]).unwrap();
        commit_file(&repo, "conflict.txt", "other\n", "Other");
        repo.run(["checkout", "main"]).unwrap();
        commit_file(&repo, "conflict.txt", "main\n", "Main");
        assert!(repo.run(["merge", "other"]).is_err());
        let id = repo
            .status()
            .unwrap()
            .files
            .into_iter()
            .find(|file| file.conflict)
            .unwrap()
            .id;
        repo.run(["config", "merge.tool", "diffinch-test"]).unwrap();
        repo.run([
            "config",
            "mergetool.diffinch-test.cmd",
            "printf 'resolved\\n' > \"$MERGED\"",
        ])
        .unwrap();
        assert!(repo
            .merge_tool(&id)
            .is_err_and(|error| error.key == "mergeToolNeedsExitCode"));
        repo.run(["config", "mergetool.diffinch-test.trustExitCode", "true"])
            .unwrap();
        repo.action(Action::MergeTool { id }).unwrap();
        assert!(!repo
            .status()
            .unwrap()
            .files
            .iter()
            .any(|file| file.conflict));
        assert_eq!(repo.text(["show", ":conflict.txt"]).unwrap(), "resolved");
        assert_eq!(repo.operation().unwrap().as_deref(), Some("merge"));
    }
}
