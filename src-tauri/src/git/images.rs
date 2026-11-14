use super::{
    bytes_to_os, extensions,
    process::{execute, execute_with_limit},
    refs::validate_oid,
    string, Repo, Result,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::{
    ffi::{OsStr, OsString},
    io::{self, Read},
    path::Path,
};

const IMAGE_LIMIT: usize = 10 * 1024 * 1024;
pub(super) const IMAGE_TOTAL_LIMIT: usize = 24 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImageVersion {
    data_url: Option<String>,
    size: Option<u64>,
    error: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImagePreview {
    path: String,
    original_path: Option<String>,
    before: Option<ImageVersion>,
    after: Option<ImageVersion>,
}

#[derive(Clone, Copy)]
pub(super) enum ImageSource<'a> {
    Worktree,
    Index,
    Commit(&'a str),
    Comparison(&'a str, &'a str),
}

fn image_mime(path: &OsStr) -> Option<&'static str> {
    match Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "apng" => Some("image/png"),
        "jpg" | "jpeg" | "jfif" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

impl ImageVersion {
    fn unavailable(error: &'static str) -> Self {
        Self {
            data_url: None,
            size: None,
            error: Some(error),
        }
    }

    fn from_bytes(mime: &str, bytes: &[u8], budget: &mut usize) -> Self {
        *budget -= bytes.len();
        Self {
            data_url: Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))),
            size: Some(bytes.len() as u64),
            error: None,
        }
    }
}

impl Repo {
    pub(super) fn image_previews(
        &self,
        source: ImageSource<'_>,
        paths: &[OsString],
        budget: &mut usize,
    ) -> Result<Vec<ImagePreview>> {
        if !paths.is_empty() && !paths.iter().any(|path| image_mime(path).is_some()) {
            return Ok(Vec::new());
        }
        let mut git = self.command();
        git.arg("--literal-pathspecs");
        match source {
            ImageSource::Commit(_) => {
                git.args([
                    "show",
                    "--format=",
                    "--first-parent",
                    "--diff-merges=first-parent",
                ]);
            }
            _ => {
                git.arg("diff");
            }
        }
        git.args([
            "--raw",
            "-z",
            "--no-abbrev",
            "--find-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
        ]);
        match source {
            ImageSource::Index => {
                git.args(["--cached", "--diff-filter=u"]);
            }
            ImageSource::Commit(id) => {
                git.arg(id);
            }
            ImageSource::Comparison(base, target) => {
                git.args([base, target]);
            }
            ImageSource::Worktree => {}
        }
        git.arg("--").args(paths);
        let output = execute(git, &[], None)?;
        // Only consume complete NUL-delimited records if Git's output is capped.
        let mut records = output
            .bytes
            .split_inclusive(|byte| *byte == 0)
            .filter_map(|record| record.strip_suffix(&[0]));
        let mut images = Vec::new();
        while let Some(header) = records.next() {
            let Some(header) = header.strip_prefix(b":") else {
                continue;
            };
            let fields: Vec<_> = header.split(|byte| *byte == b' ').collect();
            if fields.len() != 5 {
                continue;
            }
            let Some(before_path) = records.next() else {
                break;
            };
            let renamed = matches!(fields[4].first(), Some(b'R' | b'C'));
            let after_path = if renamed {
                let Some(path) = records.next() else { break };
                path
            } else {
                before_path
            };
            // Unmerged entries use combined raw records; the conflict viewer handles them.
            if fields[4] == b"U" {
                continue;
            }
            let before_path = bytes_to_os(before_path)?;
            let after_path = bytes_to_os(after_path)?;
            if image_mime(&before_path).is_none() && image_mime(&after_path).is_none() {
                continue;
            }
            let before = (fields[0] != b"000000")
                .then(|| self.image_blob(&before_path, fields[0], fields[2], budget));
            let after = (fields[1] != b"000000").then(|| {
                if matches!(source, ImageSource::Worktree) {
                    self.image_worktree(&after_path, budget)
                } else {
                    self.image_blob(&after_path, fields[1], fields[3], budget)
                }
            });
            images.push(ImagePreview {
                path: after_path.to_string_lossy().into_owned(),
                original_path: renamed.then(|| before_path.to_string_lossy().into_owned()),
                before,
                after,
            });
        }
        Ok(images)
    }

    pub(super) fn untracked_image(&self, path: &OsStr, budget: &mut usize) -> Option<ImagePreview> {
        image_mime(path)?;
        Some(ImagePreview {
            path: path.to_string_lossy().into_owned(),
            original_path: None,
            before: None,
            after: Some(self.image_worktree(path, budget)),
        })
    }

    fn image_blob(
        &self,
        path: &OsStr,
        mode: &[u8],
        oid: &[u8],
        budget: &mut usize,
    ) -> ImageVersion {
        let Some(mime) = image_mime(path) else {
            return ImageVersion::unavailable("imageUnsupported");
        };
        if !matches!(mode, b"100644" | b"100755") {
            return ImageVersion::unavailable("imageUnsupported");
        }
        let oid = string(oid);
        let result = (|| -> Result<ImageVersion> {
            validate_oid(&oid)?;
            let size: u64 = self
                .text(["cat-file", "-s", &oid])?
                .parse()
                .map_err(|_| "imageUnavailable")?;
            if let Some(error) = image_size_error(size, *budget) {
                return Ok(error);
            }
            let mut git = self.command();
            git.args(["cat-file", "blob", &oid]);
            let output = execute_with_limit(git, &[], None, IMAGE_LIMIT.min(*budget))?;
            if output.truncated {
                return Err("imageTooLarge".into());
            }
            Ok(self.image_content(mime, &output.bytes, budget))
        })();
        result.unwrap_or_else(|_| ImageVersion::unavailable("imageUnavailable"))
    }

    fn image_worktree(&self, path: &OsStr, budget: &mut usize) -> ImageVersion {
        let Some(mime) = image_mime(path) else {
            return ImageVersion::unavailable("imageUnsupported");
        };
        let result = (|| -> io::Result<ImageVersion> {
            let relative = Path::new(path);
            if !relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
            {
                return Ok(ImageVersion::unavailable("imageUnsupported"));
            }
            let root = self.0.canonicalize()?;
            let file_path = root.join(relative);
            // Do not follow symlinks, including symlinked parent directories.
            if file_path.parent().unwrap().canonicalize()? != file_path.parent().unwrap()
                || !file_path.symlink_metadata()?.is_file()
            {
                return Ok(ImageVersion::unavailable("imageUnsupported"));
            }
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let file = options.open(file_path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() {
                return Ok(ImageVersion::unavailable("imageUnsupported"));
            }
            if let Some(error) = image_size_error(metadata.len(), *budget) {
                return Ok(error);
            }
            let limit = IMAGE_LIMIT.min(*budget);
            let mut bytes = Vec::new();
            file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > limit {
                return Ok(ImageVersion::unavailable("imageTooLarge"));
            }
            Ok(self.image_content(mime, &bytes, budget))
        })();
        result.unwrap_or_else(|_| ImageVersion::unavailable("imageUnavailable"))
    }

    fn image_content(&self, mime: &str, bytes: &[u8], budget: &mut usize) -> ImageVersion {
        let Some((oid, size)) = extensions::lfs_pointer(bytes) else {
            return ImageVersion::from_bytes(mime, bytes, budget);
        };
        if let Some(error) = image_size_error(size, *budget) {
            return error;
        }
        let result = (|| -> Result<ImageVersion> {
            // Resolve local storage through LFS, including custom lfs.storage and worktrees.
            // Never download an object merely because the user selected a diff.
            let location = self.lfs_object_path(oid)?;
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let file = options.open(location).map_err(|_| "lfsImageMissing")?;
            let metadata = file.metadata().map_err(|_| "lfsImageMissing")?;
            if !metadata.is_file() || metadata.len() != size {
                return Err("lfsImageMissing".into());
            }
            let mut content = Vec::new();
            file.take(size + 1)
                .read_to_end(&mut content)
                .map_err(|_| "lfsImageMissing")?;
            if content.len() as u64 != size {
                return Err("lfsImageMissing".into());
            }
            Ok(ImageVersion::from_bytes(mime, &content, budget))
        })();
        result.unwrap_or(ImageVersion {
            data_url: None,
            size: Some(size),
            error: Some("lfsImageMissing"),
        })
    }
}

fn image_size_error(size: u64, budget: usize) -> Option<ImageVersion> {
    let error = if size > IMAGE_LIMIT as u64 {
        "imageTooLarge"
    } else if size > budget as u64 {
        "imagePreviewLimit"
    } else {
        return None;
    };
    Some(ImageVersion {
        data_url: None,
        size: Some(size),
        error: Some(error),
    })
}

#[cfg(test)]
mod tests {
    use super::super::model::DiffOptions;
    use super::*;

    fn repository() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repo::init(dir.path()).unwrap();
        for (key, value) in [
            ("user.name", "Image Test"),
            ("user.email", "images@example.invalid"),
            ("core.hooksPath", ".git/no-test-hooks"),
            ("commit.gpgSign", "false"),
        ] {
            repo.run(["config", "--local", key, value]).unwrap();
        }
        (dir, repo)
    }

    fn commit(repo: &Repo) -> String {
        repo.run(["add", "-A"]).unwrap();
        repo.run(["commit", "-m", "Image version"]).unwrap();
        repo.text(["rev-parse", "HEAD"]).unwrap()
    }

    fn content(version: &Option<ImageVersion>) -> Vec<u8> {
        let version = version.as_ref().expect("image version exists");
        assert_eq!(version.error, None);
        let (_, encoded) = version.data_url.as_ref().unwrap().split_once(',').unwrap();
        STANDARD.decode(encoded).unwrap()
    }

    #[test]
    fn previews_distinct_worktree_index_and_head_versions() {
        let (dir, repo) = repository();
        let path = dir.path().join("image.PNG");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\noriginal").unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let untracked = repo.diff(&id, false).unwrap();
        assert!(untracked.images[0].before.is_none());
        assert_eq!(
            content(&untracked.images[0].after),
            std::fs::read(&path).unwrap()
        );
        assert_eq!(repo.changes_diff(false).unwrap().images.len(), 1);
        repo.run(["add", "--", "image.PNG"]).unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        assert!(repo.diff(&id, true).unwrap().images[0].before.is_none());
        let root = commit(&repo);
        let root_diff = repo.commit_diff(&root).unwrap();
        assert!(root_diff.images[0].before.is_none());
        let original = content(&root_diff.images[0].after);
        std::fs::write(&path, b"\0staged").unwrap();
        repo.run(["add", "--", "image.PNG"]).unwrap();
        std::fs::write(&path, b"\0working").unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let staged = repo.diff(&id, true).unwrap();
        assert_eq!(content(&staged.images[0].before), original);
        assert_eq!(content(&staged.images[0].after), b"\0staged");
        let working = repo.diff(&id, false).unwrap();
        assert_eq!(content(&working.images[0].before), b"\0staged");
        assert_eq!(content(&working.images[0].after), b"\0working");
        assert_eq!(
            content(&repo.changes_diff(true).unwrap().images[0].after),
            b"\0staged"
        );
        assert_eq!(
            content(&repo.changes_diff(false).unwrap().images[0].after),
            b"\0working"
        );
    }

    #[test]
    fn previews_history_comparisons_renames_and_deleted_images() {
        let (dir, repo) = repository();
        let old = if cfg!(windows) {
            "before 雪.png"
        } else {
            "before\t雪.png"
        };
        let new = if cfg!(windows) {
            "after 雪.png"
        } else {
            "after\n雪.png"
        };
        std::fs::write(dir.path().join(old), b"\0image").unwrap();
        let base = commit(&repo);
        repo.run(["mv", "--", old, new]).unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let staged = repo.diff(&id, true).unwrap();
        assert_eq!(staged.images[0].original_path.as_deref(), Some(old));
        assert_eq!(
            content(&staged.images[0].before),
            content(&staged.images[0].after)
        );
        let target = commit(&repo);
        std::fs::write(dir.path().join(new), b"\0working change").unwrap();
        let history = repo.commit_diff(&target).unwrap();
        assert_eq!(history.images[0].path, new);
        assert_eq!(content(&history.images[0].after), b"\0image");
        let comparison = repo.compare(&base, &target, false).unwrap();
        let compared = repo
            .compare_file(
                &base,
                &target,
                &comparison.files[0].id,
                DiffOptions::default(),
            )
            .unwrap();
        assert_eq!(compared.images[0].original_path.as_deref(), Some(old));
        assert_eq!(content(&compared.images[0].after), b"\0image");
        std::fs::remove_file(dir.path().join(new)).unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let deleted = repo.diff(&id, false).unwrap();
        assert_eq!(content(&deleted.images[0].before), b"\0image");
        assert!(deleted.images[0].after.is_none());
        let deletion = commit(&repo);
        assert!(repo.commit_diff(&deletion).unwrap().images[0]
            .after
            .is_none());
        std::fs::write(dir.path().join("data.bin"), b"\0not an image").unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        assert!(repo.diff(&id, false).unwrap().images.is_empty());
    }

    #[test]
    fn previews_merge_commit_against_its_first_parent() {
        let (dir, repo) = repository();
        std::fs::write(dir.path().join("image.svg"), "<svg/>").unwrap();
        commit(&repo);
        let branch = repo.text(["branch", "--show-current"]).unwrap();
        repo.run(["switch", "-c", "image-change"]).unwrap();
        std::fs::write(dir.path().join("image.svg"), "<svg><!--new--></svg>").unwrap();
        commit(&repo);
        repo.run(["switch", &branch]).unwrap();
        repo.run(["merge", "--no-ff", "image-change", "-m", "Merge image"])
            .unwrap();
        let id = repo.text(["rev-parse", "HEAD"]).unwrap();
        let diff = repo.commit_diff(&id).unwrap();
        assert_eq!(diff.images.len(), 1);
        assert_eq!(content(&diff.images[0].before), b"<svg/>");
        assert_eq!(content(&diff.images[0].after), b"<svg><!--new--></svg>");
        assert!(diff.text.contains("+<svg><!--new--></svg>"));
    }

    #[test]
    fn bounds_image_reads_without_dropping_the_text_diff() {
        let (dir, repo) = repository();
        let file = std::fs::File::create(dir.path().join("large.png")).unwrap();
        file.set_len(IMAGE_LIMIT as u64 + 1).unwrap();
        let id = repo.status().unwrap().files.remove(0).id;
        let diff = repo.diff(&id, false).unwrap();
        assert_eq!(
            diff.images[0].after.as_ref().unwrap().error,
            Some("imageTooLarge")
        );
        assert!(!diff.text.is_empty());
        let id = commit(&repo);
        assert_eq!(
            repo.commit_diff(&id).unwrap().images[0]
                .after
                .as_ref()
                .unwrap()
                .error,
            Some("imageTooLarge")
        );
        std::fs::write(dir.path().join("small.webp"), b"12345").unwrap();
        let mut budget = 4;
        let image = repo
            .untracked_image(OsStr::new("small.webp"), &mut budget)
            .unwrap();
        assert_eq!(image.after.unwrap().error, Some("imagePreviewLimit"));
        assert_eq!(budget, 4);
        budget = 5;
        assert_eq!(
            content(
                &repo
                    .untracked_image(OsStr::new("small.webp"), &mut budget)
                    .unwrap()
                    .after
            ),
            b"12345"
        );
        assert_eq!(budget, 0);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_or_traverse_outside_the_repository() {
        use std::os::unix::fs::symlink;
        let (dir, repo) = repository();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("image.png"), b"private").unwrap();
        symlink(
            outside.path().join("image.png"),
            dir.path().join("link.png"),
        )
        .unwrap();
        symlink(outside.path(), dir.path().join("linked")).unwrap();
        for path in ["link.png", "linked/image.png", "../image.png"] {
            let mut budget = IMAGE_TOTAL_LIMIT;
            let image = repo.untracked_image(OsStr::new(path), &mut budget).unwrap();
            assert_eq!(image.after.unwrap().error, Some("imageUnsupported"));
        }
        let id = commit(&repo);
        assert_eq!(
            repo.commit_diff(&id).unwrap().images[0]
                .after
                .as_ref()
                .unwrap()
                .error,
            Some("imageUnsupported")
        );
    }
}
