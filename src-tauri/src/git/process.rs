use super::{credentials::authentication_required, GitError, Result, OUTPUT_LIMIT};
use std::{
    cell::RefCell,
    io::{self, Read, Write},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
#[cfg(target_os = "macos")]
use std::{env, path::PathBuf};

#[derive(Clone)]
struct Operation {
    cancelled: Arc<AtomicBool>,
    progress: Arc<dyn Fn(u8) + Send + Sync>,
}

thread_local! {
    // A blocking repository worker stays on one thread. Nested Git commands
    // inherit cancellation without changing every domain method's signature.
    static OPERATION: RefCell<Option<Operation>> = const { RefCell::new(None) };
}

pub fn with_operation<T>(
    cancelled: Arc<AtomicBool>,
    progress: impl Fn(u8) + Send + Sync + 'static,
    run: impl FnOnce() -> Result<T>,
) -> Result<T> {
    struct Reset(Option<Operation>);
    impl Drop for Reset {
        fn drop(&mut self) {
            OPERATION.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let previous = OPERATION.with(|slot| {
        slot.replace(Some(Operation {
            cancelled,
            progress: Arc::new(progress),
        }))
    });
    let _reset = Reset(previous);
    run().map_err(|error| {
        if error.key == "transferCancelled" {
            "operationInterrupted".into()
        } else {
            error
        }
    })
}
pub fn check_operation() -> Result<()> {
    if OPERATION.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|operation| operation.cancelled.load(Ordering::Relaxed))
    }) {
        return Err("transferCancelled".into());
    }
    Ok(())
}

pub(super) fn command() -> Command {
    let mut command = Command::new("git");
    command
        // Parsed output must stay UTF-8 and include root diffs and blank context
        // prefixes regardless of the user's terminal presentation preferences.
        .args([
            "-c",
            "color.ui=false",
            "-c",
            "diff.suppressBlankEmpty=false",
            "-c",
            "i18n.logOutputEncoding=UTF-8",
            "-c",
            "log.showRoot=true",
        ])
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true");
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_PREFIX",
        "GIT_GLOB_PATHSPECS",
        "GIT_NOGLOB_PATHSPECS",
        "GIT_ICASE_PATHSPECS",
        "GIT_LITERAL_PATHSPECS",
    ] {
        command.env_remove(name);
    }

    #[cfg(target_os = "macos")]
    {
        let path = env::var_os("PATH").unwrap_or_default();
        let mut paths: Vec<PathBuf> = env::split_paths(&path).collect();
        for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            let directory = PathBuf::from(directory);
            if !paths.contains(&directory) {
                paths.push(directory);
            }
        }
        if let Ok(path) = env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

pub(super) struct Output {
    pub(super) bytes: Vec<u8>,
    pub(super) truncated: bool,
}

pub(super) fn read_output(mut reader: impl Read, limit: usize) -> io::Result<Output> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > limit;
    if truncated {
        bytes.truncate(limit);
        io::copy(&mut reader, &mut io::sink())?;
    }
    Ok(Output { bytes, truncated })
}

pub(super) fn execute(command: Command, accepted: &[i32], input: Option<&[u8]>) -> Result<Output> {
    execute_with_limit(command, accepted, input, OUTPUT_LIMIT)
}

pub(super) fn execute_with_limit(
    command: Command,
    accepted: &[i32],
    input: Option<&[u8]>,
    limit: usize,
) -> Result<Output> {
    execute_command(command, accepted, input, limit, None)
}

pub struct Transfer<'a> {
    pub cancelled: &'a AtomicBool,
    pub progress: &'a (dyn Fn(u8) + Sync),
}

pub(super) fn execute_command(
    mut command: Command,
    accepted: &[i32],
    input: Option<&[u8]>,
    limit: usize,
    transfer: Option<&Transfer<'_>>,
) -> Result<Output> {
    let operation = OPERATION.with(|slot| slot.borrow().clone());
    let inherited = operation.as_ref().map(|operation| Transfer {
        cancelled: &operation.cancelled,
        progress: operation.progress.as_ref(),
    });
    let transfer = transfer.or(inherited.as_ref());
    if let Some(transfer) = transfer {
        if transfer.cancelled.load(Ordering::Relaxed) {
            return Err("transferCancelled".into());
        }
        // Each subprocess may have a different progress phase.
        if operation.is_some() {
            (transfer.progress)(0);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "gitNotFound".into()
        } else {
            GitError::new("gitStartFailed", error)
        }
    })?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdin = child.stdin.take();
    let io_error = |error: io::Error| GitError::new("gitIoFailed", error);
    let finished = AtomicUsize::new(0);
    thread::scope(|scope| {
        let finished = &finished;
        struct Done<'a>(&'a AtomicUsize);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::Release);
            }
        }
        let stdout = scope.spawn(move || {
            let _done = Done(finished);
            read_output(stdout, limit)
        });
        let stderr = scope.spawn(move || {
            let _done = Done(finished);
            match transfer {
                Some(transfer) => read_progress(stderr, transfer.progress),
                None => read_output(stderr, OUTPUT_LIMIT),
            }
        });
        let writer = scope.spawn(move || {
            let _done = Done(finished);
            match (stdin, input) {
                (Some(mut pipe), Some(bytes)) => pipe.write_all(bytes),
                _ => Ok(()),
            }
        });
        let (status, cancelled) =
            wait_for_command(&mut child, transfer, finished).map_err(io_error)?;
        let stdout = stdout.join().expect("stdout reader").map_err(io_error)?;
        let stderr = stderr.join().expect("stderr reader").map_err(io_error)?;
        let written = writer.join().expect("stdin writer");
        if cancelled {
            return Err("transferCancelled".into());
        }
        if !status.success() && !status.code().is_some_and(|code| accepted.contains(&code)) {
            let message = String::from_utf8_lossy(&stderr.bytes).trim().to_owned();
            let message = if message.is_empty() {
                String::from_utf8_lossy(&stdout.bytes).trim().to_owned()
            } else {
                message
            };
            return Err(if authentication_required(&message) {
                // Authentication output can include credential-bearing URLs.
                // The UI recovers through the existing credential helper dialog.
                "authenticationRequired".into()
            } else if message.is_empty() {
                GitError::new("gitExited", status)
            } else {
                GitError::new("gitOutput", message)
            });
        }
        written.map_err(io_error)?;
        Ok(stdout)
    })
}

fn wait_for_command(
    child: &mut Child,
    transfer: Option<&Transfer<'_>>,
    finished: &AtomicUsize,
) -> io::Result<(ExitStatus, bool)> {
    let Some(transfer) = transfer else {
        return child.wait().map(|status| (status, false));
    };
    let mut exited = None;
    loop {
        if exited.is_none() {
            exited = child.try_wait()?;
        }
        if let Some(status) = exited {
            // Descendants can keep pipes open after Git exits. Continue accepting
            // cancellation until all readers and the input writer have finished.
            if finished.load(Ordering::Acquire) == 3 {
                return Ok((status, false));
            }
        }
        if transfer.cancelled.load(Ordering::Relaxed) {
            #[cfg(unix)]
            {
                // Git and its transport share a dedicated process group.
                unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGTERM) };
                thread::sleep(Duration::from_millis(250));
                unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill")
                    .creation_flags(0x08000000)
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
                let _ = child.kill();
            }
            #[cfg(not(any(unix, windows)))]
            let _ = child.kill();
            return child.wait().map(|status| (status, true));
        }
        thread::sleep(Duration::from_millis(80));
    }
}

fn read_progress(mut input: impl Read, report: &dyn Fn(u8)) -> io::Result<Output> {
    let mut bytes = Vec::new();
    let mut line = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut last = None;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count.min(OUTPUT_LIMIT - bytes.len())]);
        for &byte in &buffer[..count] {
            if matches!(byte, b'\r' | b'\n') {
                if let Some(percent) = transfer_percent(&line) {
                    if last != Some(percent) {
                        report(percent);
                        last = Some(percent);
                    }
                }
                line.clear();
            } else if line.len() < 256 {
                line.push(byte);
            }
        }
    }
    Ok(Output {
        truncated: bytes.len() == OUTPUT_LIMIT,
        bytes,
    })
}

fn transfer_percent(line: &[u8]) -> Option<u8> {
    let line = std::str::from_utf8(line).ok()?.trim();
    let line = line.strip_prefix("remote: ").unwrap_or(line);
    let (label, progress) = line.split_once(':')?;
    if !matches!(
        label,
        "Counting objects"
            | "Compressing objects"
            | "Receiving objects"
            | "Resolving deltas"
            | "Updating files"
            | "Writing objects"
    ) {
        return None;
    }
    progress
        .split_once('%')?
        .0
        .trim()
        .parse::<u8>()
        .ok()
        .filter(|percent| *percent <= 100)
}
