use super::{model::*, process::*, rebase::REBASE_MESSAGES, *};
#[cfg(unix)]
use std::time::Duration;
use std::{io, process::Command};

#[cfg(unix)]
#[test]
fn cancels_a_git_transfer_and_its_child() {
    let cancelled = Cancellation::default();
    let progress = |percent| {
        assert_eq!(percent, 42);
        cancelled.cancel();
    };
    let mut command = Command::new("sh");
    command.args([
        "-c",
        "printf 'Receiving objects: 42%%\r' >&2; sleep 30 & wait",
    ]);
    let transfer = Transfer {
        cancelled: &cancelled,
        progress: &progress,
    };
    let started = std::time::Instant::now();
    assert!(
        execute_command(command, &[], None, OUTPUT_LIMIT, Some(&transfer))
            .is_err_and(|error| error.key == "transferCancelled")
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

pub(super) fn repo() -> (tempfile::TempDir, Repo) {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repo::init(dir.path()).unwrap();
    for (name, value) in [
        ("user.name", "Diffinch Test"),
        ("user.email", "diffinch@example.invalid"),
        ("core.hooksPath", ".git/no-test-hooks"),
        ("core.autocrlf", "false"),
    ] {
        repo.run(["config", "--local", name, value]).unwrap();
    }
    (dir, repo)
}

#[test]
fn commit_readers_preserve_unicode_with_a_non_utf8_log_encoding() {
    let (_dir, repo) = repo();
    repo.run(["config", "user.name", "André"]).unwrap();
    let id = commit_file(&repo, "notes.txt", "content\n", "Café update");
    repo.run(["config", "i18n.logOutputEncoding", "ISO-8859-1"])
        .unwrap();

    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.commits[0].subject, "Café update");
    assert_eq!(snapshot.commits[0].author, "André");
    assert_eq!(
        repo.commit_message(&id).unwrap(),
        "Café update\n\nTest body\n"
    );
    let matches = serde_json::to_value(
        repo.search_commits("Café", SearchField::All, false)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(matches["commits"][0]["subject"], "Café update");
    assert_eq!(matches["commits"][0]["author"], "André");
    assert_eq!(
        repo.rebase_plan(&id, true).unwrap().commits[0].subject,
        "Café update"
    );
    assert_eq!(repo.author_plan(&id).unwrap().subject, "Café update");
}

#[test]
fn root_commit_reviews_ignore_the_log_show_root_preference() {
    let (_dir, repo) = repo();
    let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n";
    let id = commit_file(&repo, "image.svg", svg, "First commit");
    repo.run(["config", "log.showRoot", "false"]).unwrap();

    let diff = repo.commit_diff(&id).unwrap();
    assert!(diff.text.contains(&format!("+{svg}")));
    let diff = serde_json::to_value(diff).unwrap();
    assert_eq!(diff["images"][0]["path"], "image.svg");
    assert!(diff["images"][0]["before"].is_null());
    assert!(diff["images"][0]["after"]["dataUrl"].is_string());
    assert!(repo
        .file_revision_diff(&id, "image.svg", None, DiffOptions::default())
        .unwrap()
        .text
        .contains(&format!("+{svg}")));
    let history = serde_json::to_value(repo.file_history(&id, "image.svg", 100).unwrap()).unwrap();
    assert_eq!(history["commits"][0]["id"], id);
}

#[cfg(unix)]
#[test]
fn cancels_a_commit_hook_and_preserves_the_index() {
    use std::{fs, os::unix::fs::PermissionsExt, sync::Arc};
    let (dir, repo) = repo();
    let base = commit_file(&repo, "file", "before\n", "Base");
    fs::write(dir.path().join("file"), "after\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    let hooks = dir.path().join("hooks");
    fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    fs::write(
        &hook,
        "#!/bin/sh\nprintf 'Receiving objects: 42%%\\r' >&2\nsleep 30 & wait\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    repo.run(["config", "core.hooksPath", hooks.to_str().unwrap()])
        .unwrap();
    let cancelled = Arc::new(Cancellation::default());
    let signal = cancelled.clone();
    let started = std::time::Instant::now();
    let result = with_operation(
        cancelled,
        move |percent| {
            if percent == 42 {
                signal.cancel();
            }
        },
        || {
            repo.action(Action::Commit {
                summary: "Interrupted".into(),
                description: String::new(),
                sign: false,
                amend: None,
            })
        },
    );
    assert!(result.is_err_and(|error| error.key == "operationInterrupted"));
    assert!(started.elapsed() < Duration::from_secs(5));
    // The scoped cancellation must not poison the subsequent refresh.
    assert_eq!(repo.status().unwrap().head, Some(base));
    assert_eq!(repo.text(["show", ":file"]).unwrap(), "after");
    assert!(!repo.git_dir().unwrap().join("index.lock").exists());
}

#[cfg(unix)]
#[test]
fn cancellation_remains_available_when_a_child_keeps_a_pipe_open() {
    use std::sync::Arc;
    let cancelled = Arc::new(Cancellation::default());
    let signal = cancelled.clone();
    let dir = tempfile::tempdir().unwrap();
    let leader = dir.path().join("leader");
    let started = std::time::Instant::now();
    let cancel = std::thread::spawn(move || {
        let mut reserved = false;
        while started.elapsed() < Duration::from_secs(4) {
            if let Ok(pid) = std::fs::read_to_string(&leader) {
                if let Ok(pid) = pid.trim().parse::<u32>() {
                    reserved = process::wait_without_reaping(pid).is_ok();
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        signal.cancel();
        reserved
    });
    let result = with_operation(
        cancelled,
        |_| {},
        || {
            let mut command = Command::new("sh");
            command
                .current_dir(dir.path())
                .args(["-c", "sleep 30 & echo $$ > leader; exit 0"]);
            execute(command, &[], None)
        },
    );
    assert!(
        cancel.join().unwrap(),
        "the group leader must stay waitable until the pipes close"
    );
    assert!(result.is_err_and(|error| error.key == "operationInterrupted"));
    assert!(started.elapsed() < Duration::from_secs(5));
}

fn commit(repo: &Repo, summary: &str) {
    repo.action(Action::Commit {
        summary: summary.into(),
        description: "Test body".into(),
        sign: false,
        amend: None,
    })
    .unwrap();
}

pub(super) fn commit_file(repo: &Repo, path: &str, contents: &str, summary: &str) -> String {
    std::fs::write(repo.0.join(path), contents).unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(repo, summary);
    repo.text(["rev-parse", "HEAD"]).unwrap()
}

fn amend_action(repo: &Repo) -> Action {
    Action::Commit {
        summary: "Reviewed amendment".into(),
        description: "Reviewed body".into(),
        sign: false,
        amend: Some(head_target(repo)),
    }
}

fn head_target(repo: &Repo) -> HeadTarget {
    let status = repo.status().unwrap();
    HeadTarget {
        branch: status.branch,
        head: status.head,
    }
}

fn history_action(repo: &Repo, kind: &str, tip: &str) -> Action {
    let target = head_target(repo);
    match kind {
        "merge" => Action::Merge {
            name: "source".into(),
            remote: false,
            tip: tip.into(),
            target,
        },
        "rebase" => Action::Rebase {
            name: "source".into(),
            remote: false,
            tip: tip.into(),
            target,
        },
        "cherryPick" => Action::CherryPick {
            id: tip.into(),
            target,
        },
        "revert" => Action::Revert {
            id: tip.into(),
            target,
        },
        "pullRebase" => Action::PullRebase { target },
        _ => unreachable!(),
    }
}

#[test]
fn history_actions_reject_changed_heads_branches_and_active_operations() {
    for kind in ["merge", "rebase", "cherryPick", "revert", "pullRebase"] {
        for change in ["branch", "head", "detached", "operation"] {
            let (_dir, repo) = repo();
            let tip = commit_file(&repo, "notes", "Initial", "Initial");
            repo.run(["branch", "source"]).unwrap();
            let action = history_action(&repo, kind, &tip);
            match change {
                "branch" => {
                    repo.run(["switch", "-c", "other"]).unwrap();
                }
                "head" => {
                    commit_file(&repo, "notes", "Later", "Later");
                }
                "detached" => {
                    repo.run(["switch", "--detach"]).unwrap();
                }
                _ => {
                    std::fs::write(repo.git_dir().unwrap().join("CHERRY_PICK_HEAD"), &tip).unwrap()
                }
            }
            let before = repo.text(["show-ref", "--head"]).unwrap();
            let index = repo.text(["write-tree"]).unwrap();
            let error = repo.action(action).unwrap_err();
            assert_eq!(
                error.key,
                if change == "operation" {
                    "gitOperationActive"
                } else {
                    "staleHistoryAction"
                },
                "{kind}/{change}"
            );
            assert_eq!(repo.text(["show-ref", "--head"]).unwrap(), before);
            assert_eq!(repo.text(["write-tree"]).unwrap(), index);
        }
    }
}

#[test]
fn merge_and_rebase_reject_a_source_branch_moved_after_confirmation() {
    for kind in ["merge", "rebase"] {
        let (_dir, repo) = repo();
        let tip = commit_file(&repo, "notes", "Initial", "Initial");
        repo.run(["branch", "source"]).unwrap();
        let action = history_action(&repo, kind, &tip);
        repo.run(["switch", "source"]).unwrap();
        commit_file(&repo, "source", "Later", "Later source");
        repo.run(["switch", "main"]).unwrap();
        let before = repo.text(["show-ref", "--head"]).unwrap();
        assert_eq!(repo.action(action).unwrap_err().key, "staleHistoryAction");
        assert_eq!(repo.text(["show-ref", "--head"]).unwrap(), before);
        assert!(!repo.0.join("source").exists());
    }
}

#[test]
fn history_actions_apply_to_the_reviewed_branch() {
    for kind in ["merge", "rebase", "cherryPick", "revert"] {
        let (_dir, repo) = repo();
        commit_file(&repo, "notes", "Base", "Base");
        repo.run(["switch", "-c", "source"]).unwrap();
        let source = commit_file(&repo, "source", "Source", "Source");
        repo.run(["switch", "main"]).unwrap();
        if kind == "revert" {
            repo.run(["merge", "--ff-only", "source"]).unwrap();
        }
        let before = commit_file(&repo, "main", "Main", "Main");
        repo.action(history_action(&repo, kind, &source)).unwrap();
        let status = repo.status().unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_ne!(status.head.as_deref(), Some(before.as_str()));
        assert!(status.files.is_empty());
        assert_eq!(repo.0.join("source").exists(), kind != "revert");
        assert_eq!(repo.text(["rev-parse", "source"]).unwrap(), source);
    }
}

#[test]
fn history_requests_require_a_reviewed_target() {
    for kind in ["merge", "rebase", "cherryPick", "revert", "pullRebase"] {
        assert!(
            serde_json::from_value::<Action>(serde_json::json!({
                "kind": kind, "name": "source", "remote": false,
                "id": "a".repeat(40), "tip": "a".repeat(40)
            }))
            .is_err(),
            "{kind}"
        );
    }
}

#[test]
fn amend_rejects_a_new_commit_and_preserves_staged_work() {
    let (_dir, repo) = repo();
    let initial = commit_file(&repo, "notes", "Initial", "Initial");
    let action = amend_action(&repo);
    let later = commit_file(&repo, "notes", "Later", "Later commit");
    std::fs::write(repo.0.join("notes"), "Pending work").unwrap();
    repo.action(Action::StageAll).unwrap();
    let index = repo.text(["write-tree"]).unwrap();

    assert_eq!(repo.action(action).unwrap_err().key, "staleAmend");
    assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), later);
    assert_eq!(repo.text(["rev-parse", "HEAD^"]).unwrap(), initial);
    assert_eq!(
        repo.commit_message(&later).unwrap(),
        "Later commit\n\nTest body\n"
    );
    assert_eq!(repo.text(["write-tree"]).unwrap(), index);
    assert_eq!(
        std::fs::read_to_string(repo.0.join("notes")).unwrap(),
        "Pending work"
    );
}

#[test]
fn amend_rejects_branch_changes_and_started_operations_at_the_same_commit() {
    for change in ["branch", "detached", "operation"] {
        let (_dir, repo) = repo();
        let head = commit_file(&repo, "notes", "Initial", "Initial");
        let action = amend_action(&repo);
        match change {
            "branch" => {
                repo.run(["switch", "-c", "other"]).unwrap();
            }
            "detached" => {
                repo.run(["switch", "--detach"]).unwrap();
            }
            _ => std::fs::write(repo.git_dir().unwrap().join("CHERRY_PICK_HEAD"), &head).unwrap(),
        }
        let before = repo.text(["status", "--porcelain=v2", "--branch"]).unwrap();

        assert_eq!(
            repo.action(action).unwrap_err().key,
            "staleAmend",
            "{change}"
        );
        assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), head);
        assert_eq!(
            repo.text(["status", "--porcelain=v2", "--branch"]).unwrap(),
            before
        );
    }
}

#[test]
fn amend_accepts_the_reviewed_commit_on_a_branch_or_detached_head() {
    for detached in [false, true] {
        let (_dir, repo) = repo();
        let base = commit_file(&repo, "notes", "Base", "Base");
        let original = commit_file(&repo, "notes", "Original", "Original");
        if detached {
            repo.run(["switch", "--detach"]).unwrap();
        }
        let action = amend_action(&repo);
        std::fs::write(repo.0.join("notes"), "Amended content").unwrap();
        repo.action(Action::StageAll).unwrap();

        assert_eq!(repo.action(action).unwrap(), "commitAmended");
        let status = repo.status().unwrap();
        assert_ne!(status.head.as_deref(), Some(original.as_str()));
        assert_eq!(status.branch.is_none(), detached);
        assert!(status.files.is_empty());
        assert_eq!(repo.text(["rev-parse", "HEAD^"]).unwrap(), base);
        assert_eq!(
            repo.text(["show", "HEAD:notes"]).unwrap(),
            "Amended content"
        );
        assert_eq!(
            repo.commit_message(status.head.as_ref().unwrap()).unwrap(),
            "Reviewed amendment\n\nReviewed body\n"
        );
    }
}

#[test]
fn history_preserves_each_commits_author_email() {
    let (_dir, repo) = repo();
    commit_file(&repo, "file", "one", "Original author");
    repo.run([
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--amend",
        "--no-edit",
        "--author=Original Author <original+author@example.invalid>",
    ])
    .unwrap();
    let first = repo.text(["rev-parse", "HEAD"]).unwrap();
    let second = commit_file(&repo, "file", "two", "Current author");

    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.commits.len(), 2);
    assert_eq!(snapshot.commits[0].id, second);
    assert_eq!(snapshot.commits[0].email, "diffinch@example.invalid");
    assert_eq!(snapshot.commits[1].id, first);
    assert_eq!(snapshot.commits[1].author, "Original Author");
    assert_eq!(snapshot.commits[1].email, "original+author@example.invalid");
}

#[test]
fn interactive_rebase_reorders_combines_and_drops_commits() {
    let (_dir, repo) = repo();
    let base = commit_file(&repo, "base", "Base", "Base");
    let first = commit_file(&repo, "a", "A", "First");
    let second = commit_file(&repo, "b", "B", "Second");
    let third = commit_file(&repo, "c", "C", "Third");
    let fourth = commit_file(&repo, "d", "D", "Fourth");
    let fifth = commit_file(&repo, "e", "E", "Fifth");
    repo.run(["branch", "saved-tip", &third]).unwrap();
    repo.run(["config", "rebase.updateRefs", "true"]).unwrap();
    let plan = repo.rebase_plan(&base, false).unwrap();
    let step = |id: &str, operation| RebaseStep {
        id: id.into(),
        operation,
    };
    assert_eq!(
        plan.commits
            .iter()
            .map(|commit| commit.id.as_str())
            .collect::<Vec<_>>(),
        [&first, &second, &third, &fourth, &fifth]
    );
    assert_eq!(
        repo.interactive_rebase(&plan.branch, &fourth, &base, false, vec![])
            .unwrap_err()
            .key,
        "staleRebasePlan"
    );
    assert_eq!(
        repo.interactive_rebase(
            &plan.branch,
            &plan.head,
            &base,
            false,
            vec![
                step(&second, RebaseOperation::Squash),
                step(&first, RebaseOperation::Pick),
                step(&third, RebaseOperation::Pick),
                step(&fourth, RebaseOperation::Pick),
                step(&fifth, RebaseOperation::Drop),
            ]
        )
        .unwrap_err()
        .key,
        "invalidRebasePlan"
    );
    repo.action(Action::InteractiveRebase {
        branch: plan.branch,
        head: plan.head,
        base: plan.base,
        from_root: false,
        steps: vec![
            step(&third, RebaseOperation::Pick),
            step(&second, RebaseOperation::Squash),
            step(&first, RebaseOperation::Pick),
            step(&fourth, RebaseOperation::Fixup),
            step(&fifth, RebaseOperation::Drop),
        ],
    })
    .unwrap();
    assert_eq!(
        repo.text(["log", "--format=%s"]).unwrap(),
        "First\nThird\nBase"
    );
    assert!(repo
        .text(["log", "-1", "--format=%B", "HEAD^"])
        .unwrap()
        .contains("Second"));
    assert!(!repo
        .text(["log", "-1", "--format=%B"])
        .unwrap()
        .contains("Fourth"));
    assert!(!repo.0.join("e").exists());
    assert!(repo.0.join("d").exists());
    assert_eq!(repo.text(["rev-parse", "saved-tip"]).unwrap(), third);
}

#[test]
fn interactive_rebase_rewords_messages_and_preserves_commit_contents() {
    let (_dir, repo) = repo();
    let base = commit_file(&repo, "base", "Base", "Base");
    let first = commit_file(&repo, "a", "A", "First");
    let second = commit_file(&repo, "b", "B", "Second");
    let third = commit_file(&repo, "c", "C", "Third");
    let plan = repo.rebase_plan(&base, false).unwrap();
    let message = "#123 Fix the wording\n\n본문 with 'quotes' and $(literal text)\n";
    let action = |message: &str| {
        serde_json::from_value(serde_json::json!({
            "kind": "interactiveRebase",
            "branch": plan.branch,
            "head": plan.head,
            "base": plan.base,
            "steps": [
                {"id": first, "operation": "reword", "message": message},
                {"id": second, "operation": "reword", "message": "Edited second\n\nA different body"},
                {"id": third, "operation": "pick"}
            ],
        }))
        .unwrap()
    };
    assert_eq!(
        repo.action(action(" \n ")).unwrap_err().key,
        "invalidRebaseMessage"
    );
    assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), third);
    repo.action(action(message)).unwrap();

    let new_plan = repo.rebase_plan(&base, false).unwrap();
    let rewritten = &new_plan.commits;
    assert_eq!(rewritten.len(), 3);
    assert_eq!(repo.commit_message(&rewritten[0].id).unwrap(), message);
    assert_eq!(
        repo.commit_message(&rewritten[1].id).unwrap(),
        "Edited second\n\nA different body\n"
    );
    assert_eq!(
        repo.commit_message(&rewritten[2].id).unwrap(),
        repo.commit_message(&third).unwrap()
    );
    for (original, updated) in plan.commits.iter().zip(rewritten) {
        assert_ne!(original.id, updated.id);
        let metadata = |id: &str| {
            repo.text(["show", "-s", "--format=%T %an %ae %at", id])
                .unwrap()
        };
        assert_eq!(metadata(&original.id), metadata(&updated.id));
    }
}

#[test]
fn interactive_rebase_rewords_the_first_commit() {
    for with_descendant in [false, true] {
        let (_dir, repo) = repo();
        let root = commit_file(&repo, "initial", "Original contents", "First");
        let descendant =
            with_descendant.then(|| commit_file(&repo, "later", "Later contents", "Later"));
        let original_head = descendant.as_deref().unwrap_or(&root);
        let plan = repo.rebase_plan(&root, true).unwrap();
        let planned_ids = plan
            .commits
            .iter()
            .map(|commit| commit.id.as_str())
            .collect::<Vec<_>>();
        assert!(plan.from_root);
        let expected_ids = std::iter::once(root.as_str())
            .chain(descendant.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(planned_ids, expected_ids);
        let all_drops = planned_ids
            .iter()
            .map(|id| RebaseStep {
                id: (*id).into(),
                operation: RebaseOperation::Drop,
            })
            .collect();
        assert_eq!(
            repo.interactive_rebase(&plan.branch, &plan.head, &root, true, all_drops)
                .unwrap_err()
                .key,
            "rebaseKeepRootHistory"
        );
        assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), original_head);

        let message = "#123 Revised first commit\n\nFull description";
        let mut steps =
            vec![serde_json::json!({"id": root, "operation": "reword", "message": message})];
        if let Some(descendant) = &descendant {
            steps.push(serde_json::json!({"id": descendant, "operation": "pick"}));
        }
        repo.action(
            serde_json::from_value(serde_json::json!({
                "kind": "interactiveRebase",
                "branch": plan.branch,
                "head": plan.head,
                "base": plan.base,
                "fromRoot": true,
                "steps": steps,
            }))
            .unwrap(),
        )
        .unwrap();

        let new_root = repo.text(["rev-list", "--max-parents=0", "HEAD"]).unwrap();
        let new_head = repo.text(["rev-parse", "HEAD"]).unwrap();
        assert_ne!(new_root, root);
        assert_ne!(new_head, original_head);
        assert_eq!(
            repo.commit_message(&new_root).unwrap(),
            format!("{message}\n")
        );
        assert!(repo.text(["diff", &root, &new_root]).unwrap().is_empty());
        assert!(repo
            .text(["diff", original_head, &new_head])
            .unwrap()
            .is_empty());
        if let Some(descendant) = descendant {
            assert_eq!(repo.text(["rev-parse", "HEAD^"]).unwrap(), new_root);
            assert_eq!(
                repo.commit_message(&new_head).unwrap(),
                repo.commit_message(&descendant).unwrap()
            );
        } else {
            assert_eq!(new_head, new_root);
        }
    }
}

#[test]
fn root_rebase_rejects_a_shallow_boundary() {
    let (_dir, repo) = repo();
    commit_file(&repo, "first", "A", "First");
    let tip = commit_file(&repo, "second", "B", "Second");
    let clone = tempfile::tempdir().unwrap();
    repo.run([
        OsStr::new("clone"),
        OsStr::new("--no-local"),
        OsStr::new("--depth=1"),
        OsStr::new("--"),
        OsStr::new("."),
        clone.path().as_os_str(),
    ])
    .unwrap();
    let shallow = Repo::discover(clone.path()).unwrap();
    assert!(shallow
        .text(["log", "-1", "--format=%P"])
        .unwrap()
        .is_empty());
    assert_eq!(
        shallow.rebase_plan(&tip, true).err().unwrap().key,
        "rebaseNeedsRoot"
    );
}

#[test]
fn interactive_rebase_retains_reword_messages_across_conflicts() {
    let (_dir, repo) = repo();
    let base = commit_file(&repo, "notes", "base\n", "Base");
    let first = commit_file(&repo, "notes", "first\n", "First");
    let second = commit_file(&repo, "notes", "second\n", "Second");
    let third = commit_file(&repo, "other", "third\n", "Third");
    let plan = repo.rebase_plan(&base, false).unwrap();
    let start = || {
        repo.action(Action::InteractiveRebase {
            branch: plan.branch.clone(),
            head: plan.head.clone(),
            base: plan.base.clone(),
            from_root: false,
            steps: vec![
                RebaseStep {
                    id: second.clone(),
                    operation: RebaseOperation::Reword {
                        message: "Edited second".into(),
                    },
                },
                RebaseStep {
                    id: third.clone(),
                    operation: RebaseOperation::Reword {
                        message: "Edited third".into(),
                    },
                },
                RebaseStep {
                    id: first.clone(),
                    operation: RebaseOperation::Drop,
                },
            ],
        })
        .unwrap_err();
        assert_eq!(repo.operation().unwrap().as_deref(), Some("rebase"));
    };
    let drafts = repo.git_dir().unwrap().join(REBASE_MESSAGES);

    start();
    assert!(drafts.is_dir());
    repo.action(Action::AbortOperation).unwrap();
    assert!(!drafts.exists());
    assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), third);

    start();
    repo.action(Action::SkipRebase).unwrap();
    assert_eq!(
        repo.text(["log", "--format=%s"]).unwrap(),
        "Edited third\nBase"
    );
    assert!(!drafts.exists());

    repo.run(["reset", "--hard", &third]).unwrap();
    start();
    std::fs::write(repo.0.join("notes"), "resolved\n").unwrap();
    repo.run(["add", "notes"]).unwrap();
    repo.action(Action::ContinueOperation).unwrap();
    assert_eq!(
        repo.text(["log", "--format=%s"]).unwrap(),
        "Edited third\nEdited second\nBase"
    );
    assert_eq!(
        std::fs::read_to_string(repo.0.join("notes")).unwrap(),
        "resolved\n"
    );
    assert!(!drafts.exists());
}

#[test]
fn rebase_conflict_can_be_aborted_or_skipped() {
    let (_dir, repo) = repo();
    commit_file(&repo, "notes", "base", "Base");
    repo.run(["switch", "-c", "topic"]).unwrap();
    let topic = commit_file(&repo, "notes", "topic", "Topic");
    repo.run(["switch", "main"]).unwrap();
    let main = commit_file(&repo, "notes", "main", "Main");
    repo.run(["switch", "topic"]).unwrap();
    let rebase = || {
        repo.action(Action::Rebase {
            name: "main".into(),
            remote: false,
            tip: main.clone(),
            target: head_target(&repo),
        })
    };
    assert!(rebase().is_err());
    assert_eq!(repo.operation().unwrap().as_deref(), Some("rebase"));
    repo.action(Action::AbortOperation).unwrap();
    assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), topic);
    assert!(rebase().is_err());
    repo.action(Action::SkipRebase).unwrap();
    assert!(repo.operation().unwrap().is_none());
    assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), main);
}

#[test]
fn force_push_lease_rejects_a_moved_remote_and_fetch_prunes_deleted_refs() {
    let (_dir, repo) = repo();
    let initial = commit_file(&repo, "base", "Base", "Base");
    let remote = tempfile::tempdir().unwrap();
    let mut git = command();
    git.current_dir(remote.path())
        .args(["init", "--bare", "--initial-branch=main"]);
    execute(git, &[], None).unwrap();
    let url = remote.path().to_str().unwrap();
    repo.run(["remote", "add", "origin", url]).unwrap();
    repo.run(["push", "--set-upstream", "origin", "HEAD:refs/heads/main"])
        .unwrap();
    repo.run(["switch", "-c", "rewrite"]).unwrap();
    repo.run(["branch", "--set-upstream-to=origin/main"])
        .unwrap();
    let peer_dir = tempfile::tempdir().unwrap();
    let peer = Repo::clone(url, peer_dir.path(), "peer", None).unwrap();
    peer.run(["config", "user.name", "Peer"]).unwrap();
    peer.run(["config", "user.email", "peer@example.invalid"])
        .unwrap();

    let local = commit_file(&repo, "local", "Local", "Local");
    let lease = repo.snapshot().unwrap().push_lease.unwrap();
    assert_eq!(lease.expected, initial);
    assert_eq!(lease.branch, "rewrite");
    assert_eq!(lease.target, "refs/heads/main");
    let other = commit_file(&peer, "other", "Other", "Other");
    peer.run(["push", "origin", "main", "HEAD:refs/heads/obsolete"])
        .unwrap();
    assert!(repo.action(Action::ForcePush { lease }).is_err());
    assert!(repo
        .text(["ls-remote", "origin", "refs/heads/main"])
        .unwrap()
        .starts_with(&other));

    let lease_before_fetch = repo.snapshot().unwrap().push_lease.unwrap();
    repo.action(Action::Fetch).unwrap();
    assert_eq!(
        repo.action(Action::ForcePush {
            lease: lease_before_fetch
        })
        .unwrap_err()
        .key,
        "stalePushLease"
    );
    // Explicit pull mode works even with a fast-forward-only preference.
    repo.run(["config", "pull.ff", "only"]).unwrap();
    repo.action(Action::PullRebase {
        target: head_target(&repo),
    })
    .unwrap();
    let rebased = repo.text(["rev-parse", "HEAD"]).unwrap();
    assert_ne!(rebased, local);
    assert_eq!(repo.text(["rev-parse", "HEAD^"]).unwrap(), other);
    repo.run(["reset", "--hard", &local]).unwrap();
    let lease = repo.snapshot().unwrap().push_lease.unwrap();
    assert_eq!(lease.expected, other);
    repo.action(Action::ForcePush { lease }).unwrap();
    assert_eq!(
        repo.text(["rev-parse", "refs/remotes/origin/main"])
            .unwrap(),
        local
    );
    assert!(repo
        .text(["ls-remote", "origin", "refs/heads/main"])
        .unwrap()
        .starts_with(&local));
    assert!(repo
        .run(["show-ref", "--verify", "refs/remotes/origin/obsolete"])
        .is_ok());
    peer.run(["push", "origin", "--delete", "obsolete"])
        .unwrap();
    repo.action(Action::FetchPrune).unwrap();
    assert!(repo
        .run(["show-ref", "--verify", "refs/remotes/origin/obsolete"])
        .is_err());
}

fn bare_remote() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let mut git = command();
    git.current_dir(dir.path())
        .args(["init", "--bare", "--initial-branch=main"]);
    execute(git, &[], None).unwrap();
    dir
}

#[test]
fn force_push_rejects_retargeted_urls_even_with_matching_remote_tips() {
    for change in ["pushurl", "url", "rewrite", "multiple"] {
        let (_dir, repo) = repo();
        let original = bare_remote();
        let other = bare_remote();
        let url = original.path().to_str().unwrap();
        let other_url = other.path().to_str().unwrap();
        let initial = commit_file(&repo, "notes", "Initial", "Initial");
        repo.run(["remote", "add", "origin", url]).unwrap();
        repo.run(["push", "--set-upstream", "origin", "HEAD:refs/heads/main"])
            .unwrap();
        repo.run(["push", other_url, "HEAD:refs/heads/main"])
            .unwrap();
        let local = commit_file(&repo, "notes", "Local", "Local");
        let lease = repo.snapshot().unwrap().push_lease.unwrap();
        match change {
            "pushurl" => {
                repo.run(["remote", "set-url", "--push", "origin", other_url])
                    .unwrap();
            }
            "url" => {
                repo.run(["remote", "set-url", "origin", other_url])
                    .unwrap();
            }
            "rewrite" => {
                repo.run(["config", &format!("url.{other_url}.pushInsteadOf"), url])
                    .unwrap();
            }
            _ => {
                repo.run(["remote", "set-url", "--push", "origin", url])
                    .unwrap();
                repo.run(["remote", "set-url", "--add", "--push", "origin", other_url])
                    .unwrap();
            }
        }

        let refreshed = repo.snapshot().unwrap();
        if change == "multiple" {
            assert!(refreshed.push_lease.is_none());
            assert!(repo.working_state().unwrap().push_lease.is_none());
        } else {
            assert_ne!(refreshed.push_lease.unwrap().destination, lease.destination);
        }
        assert_eq!(
            repo.action(Action::ForcePush { lease }).unwrap_err().key,
            "stalePushLease",
            "{change}"
        );
        for remote_url in [url, other_url] {
            assert_eq!(
                repo.text(["ls-remote", remote_url, "refs/heads/main"])
                    .unwrap(),
                format!("{initial}\trefs/heads/main")
            );
        }
        assert_eq!(repo.text(["rev-parse", "HEAD"]).unwrap(), local);
    }
}

#[test]
fn force_push_uses_the_reviewed_push_url_when_it_differs_from_fetch() {
    let (_dir, repo) = repo();
    let fetch_remote = bare_remote();
    let push_remote = bare_remote();
    let fetch_url = fetch_remote.path().to_str().unwrap();
    let push_url = push_remote.path().to_str().unwrap();
    let initial = commit_file(&repo, "notes", "Initial", "Initial");
    repo.run(["remote", "add", "origin", fetch_url]).unwrap();
    repo.run(["push", "--set-upstream", "origin", "HEAD:refs/heads/main"])
        .unwrap();
    repo.run(["push", push_url, "HEAD:refs/heads/main"])
        .unwrap();
    repo.run(["remote", "set-url", "--push", "origin", push_url])
        .unwrap();
    repo.action(amend_action(&repo)).unwrap();
    let local = repo.text(["rev-parse", "HEAD"]).unwrap();
    let lease = repo.snapshot().unwrap().push_lease.unwrap();
    assert!(!serde_json::to_string(&lease).unwrap().contains(push_url));

    repo.action(Action::ForcePush { lease }).unwrap();
    for (url, tip) in [(fetch_url, initial), (push_url, local.clone())] {
        assert_eq!(
            repo.text(["ls-remote", url, "refs/heads/main"]).unwrap(),
            format!("{tip}\trefs/heads/main")
        );
    }
    assert_eq!(
        repo.text(["rev-parse", "refs/remotes/origin/main"])
            .unwrap(),
        local
    );
}

#[cfg(unix)]
#[test]
fn force_push_honors_the_remote_receive_command_without_changing_its_destination() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let (_dir, repo) = repo();
    let remote = bare_remote();
    let url = remote.path().to_str().unwrap();
    commit_file(&repo, "notes", "Initial", "Initial");
    repo.run(["remote", "add", "origin", url]).unwrap();
    repo.run(["push", "--set-upstream", "origin", "HEAD:refs/heads/main"])
        .unwrap();
    let command = repo.git_dir().unwrap().join("reviewed-receiver");
    fs::write(
        &command,
        "#!/bin/sh\nprintf 'called\\n' >> .git/receiver-calls\nexec git receive-pack \"$@\"\n",
    )
    .unwrap();
    fs::set_permissions(&command, fs::Permissions::from_mode(0o755)).unwrap();
    repo.run([
        "config",
        "remote.origin.receivepack",
        command.to_str().unwrap(),
    ])
    .unwrap();
    commit_file(&repo, "notes", "Normal push", "Normal");
    repo.action(Action::Push).unwrap();
    assert_eq!(
        fs::read_to_string(repo.git_dir().unwrap().join("receiver-calls")).unwrap(),
        "called\n"
    );
    repo.action(amend_action(&repo)).unwrap();
    let lease = repo.snapshot().unwrap().push_lease.unwrap();
    let head = lease.head.clone();
    repo.action(Action::ForcePush { lease }).unwrap();
    assert_eq!(
        fs::read_to_string(repo.git_dir().unwrap().join("receiver-calls")).unwrap(),
        "called\ncalled\n"
    );
    assert_eq!(
        repo.text(["ls-remote", url, "refs/heads/main"]).unwrap(),
        format!("{head}\trefs/heads/main")
    );
}

#[cfg(unix)]
#[test]
fn force_push_preserves_tracking_updates_made_during_the_push() {
    use std::{fs, os::unix::fs::PermissionsExt};

    let (_dir, repo) = repo();
    let remote = bare_remote();
    let url = remote.path().to_str().unwrap();
    commit_file(&repo, "notes", "Initial", "Initial");
    repo.run(["remote", "add", "origin", url]).unwrap();
    repo.run(["push", "--set-upstream", "origin", "HEAD:refs/heads/main"])
        .unwrap();
    let local = commit_file(&repo, "notes", "Local", "Local");
    let newer = commit_file(&repo, "notes", "Newer", "Newer");
    repo.run(["reset", "--hard", &local]).unwrap();
    let lease = repo.snapshot().unwrap().push_lease.unwrap();
    let hooks = repo.git_dir().unwrap().join("test-push-hooks");
    fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("pre-push");
    fs::write(
        &hook,
        format!("#!/bin/sh\ngit update-ref refs/remotes/origin/main {newer}\n"),
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    repo.run(["config", "core.hooksPath", hooks.to_str().unwrap()])
        .unwrap();

    repo.action(Action::ForcePush { lease }).unwrap();
    assert_eq!(
        repo.text(["ls-remote", url, "refs/heads/main"]).unwrap(),
        format!("{local}\trefs/heads/main")
    );
    assert_eq!(
        repo.text(["rev-parse", "refs/remotes/origin/main"])
            .unwrap(),
        newer
    );
}

#[test]
fn reviews_staged_and_current_changes_separately_including_untracked_files() {
    let (dir, repo) = repo();
    let notes = dir.path().join("notes.txt");
    std::fs::write(&notes, "initial\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    // Staged changes must also work before the first commit.
    let unborn = repo.changes_diff(true).unwrap();
    assert!(unborn.text.contains("+initial"));
    assert!(unborn.hunk_token.is_none());
    assert!(repo.changes_diff(false).unwrap().text.is_empty());
    commit(&repo, "Initial");
    assert!(repo.changes_diff(true).unwrap().text.is_empty());

    std::fs::write(&notes, "staged version\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    std::fs::write(&notes, "working version\n").unwrap();
    std::fs::write(dir.path().join("new file.txt"), "untracked content\n").unwrap();

    let index = repo.changes_diff(true).unwrap();
    assert!(index.text.contains("-initial\n+staged version"));
    assert!(!index.text.contains("working version"));
    assert!(!index.text.contains("new file.txt"));
    let worktree = repo.changes_diff(false).unwrap();
    assert!(worktree.text.contains("-staged version\n+working version"));
    assert!(worktree.text.contains("new file.txt"));
    assert!(worktree.text.contains("+untracked content"));
    assert!(!worktree.truncated);
    assert!(worktree.hunk_token.is_none());
    assert_eq!(repo.status().unwrap().files.len(), 2);
}

#[test]
fn limits_combined_untracked_diffs_and_handles_staged_renames() {
    let (dir, repo) = repo();
    std::fs::write(dir.path().join("before.txt"), "original\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Initial");
    repo.run(["mv", "before.txt", "after.txt"]).unwrap();
    let index = repo.changes_diff(true).unwrap();
    assert!(index.text.contains("rename from before.txt"));
    assert!(index.text.contains("rename to after.txt"));
    assert!(repo.changes_diff(false).unwrap().text.is_empty());

    let content = "line of text\n".repeat(OUTPUT_LIMIT / 20);
    std::fs::write(dir.path().join("large-a.txt"), &content).unwrap();
    std::fs::write(dir.path().join("large-b.txt"), &content).unwrap();
    let worktree = repo.changes_diff(false).unwrap();
    assert!(worktree.truncated);
    assert!(worktree.text.len() <= OUTPUT_LIMIT);
    assert!(worktree.text.contains("large-a.txt"));
    assert!(worktree.text.contains("large-b.txt"));
    assert!(worktree.hunk_token.is_none());
}

#[test]
fn loads_older_graph_parents_and_creates_refs_at_an_older_commit() {
    let (dir, repo) = repo();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "first\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "First");
    let first = repo.status().unwrap().head.unwrap();
    std::fs::write(&file, "second\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Second");
    let second = repo.status().unwrap().head.unwrap();

    repo.action(Action::CreateBranch {
        name: "review".into(),
        checkout: false,
        start: Some(first.clone()),
    })
    .unwrap();
    repo.action(Action::CreateTag {
        name: "v1".into(),
        start: Some(first.clone()),
    })
    .unwrap();
    repo.run([
        "-c",
        "tag.gpgSign=false",
        "tag",
        "-a",
        "-m",
        "First release",
        "v1-annotated",
        &first,
    ])
    .unwrap();
    repo.run(["update-ref", "refs/remotes/origin/main", &first])
        .unwrap();
    repo.run([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ])
    .unwrap();

    let latest = repo.snapshot_with_history(Some(1)).unwrap();
    assert!(latest.has_older_commits);
    assert_eq!(latest.commits.len(), 1);
    assert_eq!(latest.status.head.as_deref(), Some(second.as_str()));
    assert_eq!(latest.commits[0].parents, std::slice::from_ref(&first));
    assert!(latest
        .branches
        .iter()
        .any(|branch| branch.name == "review" && branch.tip == first));
    assert!(latest
        .branches
        .iter()
        .any(|branch| branch.name == "origin/main" && branch.remote && branch.tip == first));
    assert!(!latest
        .branches
        .iter()
        .any(|branch| branch.name == "origin/HEAD"));
    assert_eq!(latest.tags.len(), 2);
    assert!(latest.tags.iter().all(|tag| tag.tip == first));

    let full = repo.snapshot_with_history(Some(2)).unwrap();
    assert!(!full.has_older_commits);
    assert_eq!(full.commits[1].id, first);
    assert!(full.commits[1].parents.is_empty());
    repo.action(Action::CreateBranch {
        name: "inspect".into(),
        checkout: true,
        start: Some(first.clone()),
    })
    .unwrap();
    assert_eq!(repo.status().unwrap().head, Some(first));
    assert!(repo
        .action(Action::CreateTag {
            name: "invalid".into(),
            start: Some("HEAD".into())
        })
        .is_err());
}

#[test]
fn refreshes_multiple_history_pages_with_large_commit_titles() {
    let (_dir, repo) = repo();
    let branch = repo.text(["symbolic-ref", "HEAD"]).unwrap();
    let title = "x".repeat(11 * 1024);
    let commit = format!(
        "commit {branch}\ncommitter Tester <t@example.test> 1000000000 +0000\ndata {}\n{title}\n\n",
        title.len()
    );
    let mut import = repo.command();
    import.args(["fast-import", "--quiet"]);
    execute(import, &[], Some(commit.repeat(200).as_bytes())).unwrap();
    let first = repo.snapshot().unwrap();
    let next = repo
        .history_page(HistoryPageRequest {
            roots: first.history_cursor.unwrap().roots,
            offset: first.commits.len(),
            limit: HISTORY_PAGE_SIZE,
        })
        .unwrap();
    let refreshed = repo.snapshot_with_history(Some(200)).unwrap();
    assert!(!refreshed.has_older_commits);
    assert_eq!(refreshed.commits.len(), 200);
    assert!(refreshed.commits.iter().map(|c| &c.id).eq(first
        .commits
        .iter()
        .chain(&next.commits)
        .map(|c| &c.id)));
}

#[test]
fn detects_a_shifted_page_boundary_after_deepening_a_clone() {
    let (source, repo) = repo();
    for branch in ["main", "topic"] {
        if branch == "topic" {
            repo.run(["switch", "--orphan", branch]).unwrap();
        }
        for i in 0..4 {
            repo.run(["commit", "--allow-empty", "-m", &format!("{branch}-{i}")])
                .unwrap();
        }
    }
    let clone_dir = tempfile::tempdir().unwrap();
    repo.run([
        "clone",
        "--no-local",
        "--no-single-branch",
        "--depth=2",
        "--",
        source.path().to_str().unwrap(),
        clone_dir.path().to_str().unwrap(),
    ])
    .unwrap();
    let clone = Repo::discover(clone_dir.path()).unwrap();
    let shallow = clone.snapshot_with_history(Some(3)).unwrap();
    let cursor = shallow.history_cursor.unwrap();
    clone.run(["fetch", "--unshallow"]).unwrap();
    let page = clone
        .history_page(HistoryPageRequest {
            roots: cursor.roots,
            offset: 3,
            limit: 2,
        })
        .unwrap();
    assert_ne!(page.commits[0].id, cursor.next);
    let refreshed = clone.snapshot_with_history(Some(5)).unwrap();
    assert_eq!(refreshed.commits.len(), 5);
    assert_eq!(refreshed.commits[3].id, page.commits[0].id);
    assert_ne!(shallow.commits[2].id, refreshed.commits[2].id);
}

#[test]
fn appends_pages_from_pinned_roots_after_branches_move() {
    let (_dir, repo) = repo();
    let base = commit_file(&repo, "file", "one", "Base");
    repo.run(["switch", "-c", "topic"]).unwrap();
    let topic = commit_file(&repo, "topic", "topic", "Topic");
    repo.run(["switch", "main"]).unwrap();
    commit_file(&repo, "file", "two", "Main");
    repo.run(["merge", "--no-ff", "topic", "-m", "Merge"])
        .unwrap();
    let expected = repo.snapshot().unwrap().commits;
    let first = repo.snapshot_with_history(Some(1)).unwrap();
    repo.run(["update-ref", "refs/heads/main", &base]).unwrap();
    repo.run(["branch", "-D", "topic"]).unwrap();
    let mut loaded = first.commits;
    let cursor = first.history_cursor.unwrap();
    let mut expected_next = Some(cursor.next);
    loop {
        let page = repo
            .history_page(HistoryPageRequest {
                roots: cursor.roots.clone(),
                offset: loaded.len(),
                limit: 1,
            })
            .unwrap();
        assert_eq!(page.commits.len(), 1);
        assert_eq!(expected_next.as_ref(), Some(&page.commits[0].id));
        expected_next = page.next_commit;
        loaded.extend(page.commits);
        if expected_next.is_none() {
            break;
        }
    }
    assert!(loaded.iter().any(|commit| commit.id == topic));
    assert!(loaded
        .iter()
        .map(|c| &c.id)
        .eq(expected.iter().map(|c| &c.id)));
    assert!(repo
        .history_page(HistoryPageRequest {
            roots: vec!["--all".into()],
            offset: 1,
            limit: 1
        })
        .is_err());
}

#[test]
fn filters_branch_roots_before_pagination_and_preserves_shared_history() {
    let (_dir, repo) = repo();
    let empty_commit = |message| {
        repo.run([
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--allow-empty",
            "-m",
            message,
        ])
        .unwrap();
        repo.status().unwrap().head.unwrap()
    };
    let base = empty_commit("Shared base");
    repo.run(["switch", "-c", "feature/editor"]).unwrap();
    let feature = empty_commit("Feature only");
    repo.run(["update-ref", "refs/remotes/origin/feature/editor", &feature])
        .unwrap();
    repo.run(["switch", "main"]).unwrap();
    let main = empty_commit("Main only");

    let hidden = vec!["refs/heads/main".into(), "refs/heads/feature/editor".into()];
    let page = repo.snapshot_with_branches(Some(1), &hidden).unwrap();
    assert_eq!(page.commits[0].id, feature);
    assert!(page.has_older_commits);
    assert_eq!(page.branches.len(), 3);
    let full = repo.snapshot_with_branches(Some(10), &hidden).unwrap();
    assert_eq!(
        full.commits
            .iter()
            .map(|commit| &commit.id)
            .collect::<Vec<_>>(),
        [&feature, &base]
    );
    assert!(!full.has_older_commits);

    let feature_hidden = vec![
        "refs/heads/feature/editor".into(),
        "refs/remotes/origin/feature/editor".into(),
    ];
    let main_only = repo.snapshot_with_branches(None, &feature_hidden).unwrap();
    assert_eq!(
        main_only
            .commits
            .iter()
            .map(|commit| &commit.id)
            .collect::<Vec<_>>(),
        [&main, &base]
    );

    let all_hidden = vec![
        "refs/heads/main".into(),
        "refs/heads/feature/editor".into(),
        "refs/remotes/origin/feature/editor".into(),
    ];
    let empty = repo.snapshot_with_branches(None, &all_hidden).unwrap();
    assert!(empty.commits.is_empty());
    assert!(!empty.has_older_commits);
    assert_eq!(empty.branches.len(), 3);
    assert_eq!(empty.status.branch.as_deref(), Some("main"));

    repo.run(["switch", "--detach", &main]).unwrap();
    let detached = repo.snapshot_with_branches(None, &all_hidden).unwrap();
    assert_eq!(detached.commits[0].id, main);
    assert_eq!(detached.commits[1].id, base);
    assert_eq!(
        repo.snapshot_with_branches(None, &["--not".into(), "refs/heads/deleted".into()])
            .unwrap()
            .commits
            .len(),
        3
    );
}

#[test]
fn includes_tag_only_history_and_every_stash_with_branch_filters() {
    let (dir, repo) = repo();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "baseline\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    let base = repo.status().unwrap().head.unwrap();
    let tree = repo.text(["rev-parse", "HEAD^{tree}"]).unwrap();
    let orphan = |message| repo.text(["commit-tree", &tree, "-m", message]).unwrap();
    let local = orphan("Local only");
    let remote = orphan("Remote only");
    let lightweight = orphan("Lightweight tag only");
    let annotated = orphan("Annotated tag only");
    repo.run(["update-ref", "refs/heads/local", &local])
        .unwrap();
    repo.run(["update-ref", "refs/remotes/origin/remote", &remote])
        .unwrap();
    repo.run(["-c", "tag.gpgSign=false", "tag", "preview", &lightweight])
        .unwrap();
    repo.run([
        "-c",
        "tag.gpgSign=false",
        "tag",
        "-a",
        "-m",
        "Release",
        "release",
        &annotated,
    ])
    .unwrap();
    // Tags of non-commit objects must not break history traversal.
    let blob = repo.text(["rev-parse", "HEAD:notes.txt"]).unwrap();
    repo.run(["update-ref", "refs/tags/tree", &tree]).unwrap();
    repo.run(["update-ref", "refs/tags/blob", &blob]).unwrap();

    for (message, content) in [("Older draft", "older\n"), ("Latest draft", "latest\n")] {
        std::fs::write(&path, content).unwrap();
        repo.action(Action::Stash {
            message: message.into(),
            include_untracked: false,
        })
        .unwrap();
    }
    let full = repo.snapshot_with_history(Some(100)).unwrap();
    assert_eq!(full.stashes.len(), 2);
    assert_eq!(full.stashes[0].id, "stash@{0}");
    assert_eq!(full.stashes[1].id, "stash@{1}");
    assert!(full.stashes[1].subject.contains("Older draft"));
    for tip in [&base, &local, &remote, &lightweight, &annotated] {
        assert!(full.commits.iter().any(|commit| &commit.id == tip));
    }
    for stash in &full.stashes {
        let commit = full
            .commits
            .iter()
            .find(|commit| commit.id == stash.tip)
            .unwrap();
        assert_eq!(commit.parents.len(), 2);
        for parent in &commit.parents {
            assert!(full.commits.iter().any(|commit| &commit.id == parent));
        }
        assert!(!repo.commit_diff(&stash.tip).unwrap().text.is_empty());
    }
    assert!(full
        .tags
        .iter()
        .any(|tag| tag.name == "release" && tag.tip == annotated));
    assert!(!full.has_older_commits);
    let page = repo.snapshot_with_history(Some(1)).unwrap();
    assert_eq!(page.commits.len(), 1);
    assert!(page.has_older_commits);
    assert_eq!(page.commits[0].id, full.commits[0].id);

    let hidden = vec![
        "refs/heads/main".into(),
        "refs/heads/local".into(),
        "refs/remotes/origin/remote".into(),
    ];
    let filtered = repo.snapshot_with_branches(None, &hidden).unwrap();
    for tip in [
        &base,
        &lightweight,
        &annotated,
        &full.stashes[0].tip,
        &full.stashes[1].tip,
    ] {
        assert!(filtered.commits.iter().any(|commit| &commit.id == tip));
    }
    assert!(!filtered
        .commits
        .iter()
        .any(|commit| commit.id == local || commit.id == remote));
    assert!(!filtered.has_older_commits);
    let page = repo.snapshot_with_branches(Some(1), &hidden).unwrap();
    assert_eq!(page.commits.len(), 1);
    assert!(page.has_older_commits);
    assert_eq!(page.commits[0].id, filtered.commits[0].id);
}

#[test]
fn review_stage_unstage_and_commit_on_unborn_branch() {
    let (dir, repo) = repo();
    assert!(repo.snapshot().unwrap().commits.is_empty());
    let path = ":(glob)[notes].txt";
    std::fs::write(dir.path().join(path), "hello world\n").unwrap();
    let id = repo.status().unwrap().files.remove(0).id;
    assert!(repo.diff(&id, false).unwrap().text.contains("+hello world"));
    repo.action(Action::Stage { id }).unwrap();
    let staged = repo.status().unwrap().files.remove(0);
    assert_eq!(staged.index, 'A');
    assert!(repo
        .diff(&staged.id, true)
        .unwrap()
        .text
        .contains("+hello world"));
    repo.action(Action::Unstage { id: staged.id }).unwrap();
    assert_eq!(repo.status().unwrap().files[0].worktree, '?');
    repo.action(Action::StageAll).unwrap();
    repo.action(Action::UnstageAll).unwrap();
    assert_eq!(repo.status().unwrap().files[0].worktree, '?');
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "First commit");
    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.commits.len(), 1);
    assert_eq!(snapshot.commits[0].subject, "First commit");
    assert!(snapshot.status.files.is_empty());
    assert!(repo
        .commit_diff(&snapshot.commits[0].id)
        .unwrap()
        .text
        .contains("+hello world"));
}

#[test]
fn stage_and_unstage_only_selected_paths() {
    let (dir, repo) = repo();
    let selected = ["[notes].txt", "-with space.txt"];
    for name in [selected[0], selected[1], "keep.txt", "n.txt"] {
        std::fs::write(dir.path().join(name), "hello\n").unwrap();
    }
    repo.run(["add", "--", "keep.txt"]).unwrap();
    let ids = |code| {
        repo.status()
            .unwrap()
            .files
            .into_iter()
            .filter(|file| selected.contains(&file.path.as_str()) && file.index == code)
            .map(|file| file.id)
            .collect::<Vec<_>>()
    };
    let unstaged = ids('.');
    assert_eq!(unstaged.len(), 2);
    let mut stale = unstaged.clone();
    stale.push("missing".into());
    assert!(repo.action(Action::StageFiles { ids: stale }).is_err());
    assert_eq!(ids('.'), unstaged);

    repo.action(Action::StageFiles { ids: unstaged }).unwrap();
    let staged = ids('A');
    assert_eq!(staged.len(), 2);
    assert!(repo.text(["ls-files", "--", "n.txt"]).unwrap().is_empty());
    repo.action(Action::UnstageFiles { ids: staged }).unwrap();
    assert_eq!(ids('.').len(), 2);
    assert_eq!(repo.text(["ls-files"]).unwrap(), "keep.txt");
}

#[test]
fn stage_and_reverse_one_hunk_and_reject_a_stale_patch() {
    let (dir, repo) = repo();
    let path = dir.path().join("notes.txt");
    let original = (0..40)
        .map(|line| format!("Line {line}\n"))
        .collect::<String>();
    std::fs::write(&path, &original).unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    std::fs::write(
        &path,
        original
            .replace("Line 1\n", "First\n")
            .replace("Line 30\n", "Second\n"),
    )
    .unwrap();
    let id = repo.status().unwrap().files.remove(0).id;
    let token = repo.diff(&id, false).unwrap().hunk_token.unwrap();
    repo.action(Action::Hunk {
        id: id.clone(),
        staged: false,
        index: 1,
        token: token.clone(),
        page: None,
        lines: None,
    })
    .unwrap();
    assert!(repo
        .action(Action::Hunk {
            id: id.clone(),
            staged: false,
            index: 1,
            token,
            page: None,
            lines: None,
        })
        .is_err_and(|error| error.key == "staleDiff"));
    assert!(repo.diff(&id, false).unwrap().text.contains("+First"));
    let staged = repo.diff(&id, true).unwrap();
    assert!(staged.text.contains("+Second"));
    assert!(!staged.text.contains("+First"));
    repo.action(Action::Hunk {
        id: id.clone(),
        staged: true,
        index: 0,
        token: staged.hunk_token.unwrap(),
        page: None,
        lines: None,
    })
    .unwrap();
    assert_eq!(repo.status().unwrap().files[0].index, '.');
    assert!(repo.diff(&id, false).unwrap().text.contains("+Second"));
}

#[test]
fn stages_and_unstages_selected_lines_without_changing_the_worktree() {
    let (dir, repo) = repo();
    commit_file(&repo, "notes", "first\nsecond\nthird\n", "Base");
    let path = dir.path().join("notes");
    let working = "first revised\nsecond\nthird revised";
    std::fs::write(&path, working).unwrap();
    let id = repo.status().unwrap().files.remove(0).id;

    // Stage only the first deletion and the final addition, including its EOF marker.
    let stage = repo.diff(&id, false).unwrap();
    let indexes = |diff: &Diff, lines: &[&str]| -> Vec<usize> {
        diff.text
            .lines()
            .skip_while(|line| !line.starts_with("@@ "))
            .skip(1)
            .enumerate()
            .filter_map(|(index, line)| lines.contains(&line).then_some(index))
            .collect()
    };
    repo.action(Action::Hunk {
        id: id.clone(),
        staged: false,
        index: 0,
        lines: Some(indexes(&stage, &["-first", "+third revised"])),
        token: stage.hunk_token.unwrap(),
        page: None,
    })
    .unwrap();
    assert_eq!(
        repo.run(["show", ":notes"]).unwrap().bytes,
        b"second\nthird\nthird revised"
    );

    let staged = repo.diff(&id, true).unwrap();
    repo.action(Action::Hunk {
        id,
        staged: true,
        index: 0,
        lines: Some(indexes(&staged, &["-first", "+third revised"])),
        token: staged.hunk_token.unwrap(),
        page: None,
    })
    .unwrap();
    assert_eq!(
        repo.run(["show", ":notes"]).unwrap().bytes,
        b"first\nsecond\nthird\n"
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), working);
}

#[test]
fn compares_diverged_refs_by_merge_base_and_opens_renamed_files() {
    let (dir, repo) = repo();
    let before = if cfg!(windows) {
        "before 한글 name"
    } else {
        "before\tname"
    };
    let after = if cfg!(windows) {
        "after 한글 name"
    } else {
        "after\nname"
    };
    let base = commit_file(&repo, before, "Keep this line\n", "Base");
    repo.run(["branch", "target"]).unwrap();
    let main = commit_file(&repo, "main-only", "Only main\n", "Main");
    repo.run(["switch", "target"]).unwrap();
    repo.run(["mv", "--", before, after]).unwrap();
    std::fs::write(dir.path().join("binary"), [0, 1]).unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Feature");
    let comparison = repo.compare("main", "target", true).unwrap();
    assert_eq!(comparison.base, base);
    let renamed = comparison
        .files
        .iter()
        .find(|file| file.path == after)
        .unwrap();
    assert_eq!(renamed.original_path.as_deref(), Some(before));
    assert_eq!(renamed.additions, Some(0));
    assert!(comparison
        .files
        .iter()
        .any(|file| file.path == "binary" && file.additions.is_none()));
    let patch = repo
        .compare_file(
            &comparison.base,
            &comparison.target,
            &renamed.id,
            DiffOptions::default(),
        )
        .unwrap();
    assert!(patch.text.contains("rename from "));
    let direct = repo.compare(&main, "HEAD", false).unwrap();
    assert!(direct
        .files
        .iter()
        .any(|file| file.path == "main-only" && file.deletions == Some(1)));
}

#[test]
fn staged_deletion_and_recreated_file_have_distinct_ids() {
    let (dir, repo) = repo();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "original\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    repo.run(["rm", "--", "notes.txt"]).unwrap();
    std::fs::write(path, "recreated\n").unwrap();
    let snapshot = repo.snapshot().unwrap();
    let staged = snapshot
        .status
        .files
        .iter()
        .find(|file| file.index == 'D')
        .unwrap();
    let untracked = snapshot
        .status
        .files
        .iter()
        .find(|file| file.worktree == '?')
        .unwrap();
    assert_ne!(staged.id, untracked.id);
    assert!(repo
        .diff(&staged.id, true)
        .unwrap()
        .text
        .contains("-original"));
    assert!(repo
        .diff(&untracked.id, false)
        .unwrap()
        .text
        .contains("+recreated"));
}

#[test]
fn publish_push_fetch_pull_and_track_a_remote_branch() {
    let (dir, repo) = repo();
    std::fs::write(dir.path().join("notes.txt"), "first\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "First");
    let remote = tempfile::tempdir().unwrap();
    let mut git = command();
    git.current_dir(remote.path())
        .args(["init", "--bare", "--initial-branch=main"]);
    execute(git, &[], None).unwrap();
    let url = remote.path().to_str().unwrap().to_owned();
    repo.action(Action::AddRemote {
        name: "origin".into(),
        url: url.clone(),
    })
    .unwrap();
    repo.action(Action::Publish {
        remote: "origin".into(),
    })
    .unwrap();
    assert_eq!(
        repo.status().unwrap().upstream.as_deref(),
        Some("origin/main")
    );
    let peer_dir = tempfile::tempdir().unwrap();
    let peer = Repo::clone(&url, peer_dir.path(), "peer", None).unwrap();
    peer.run(["config", "user.name", "Peer"]).unwrap();
    peer.run(["config", "user.email", "peer@example.invalid"])
        .unwrap();
    std::fs::write(peer.0.join("notes.txt"), "second\n").unwrap();
    peer.action(Action::StageAll).unwrap();
    commit(&peer, "Second");
    peer.action(Action::Push).unwrap();
    peer.action(Action::CreateBranch {
        name: "review".into(),
        checkout: true,
        start: None,
    })
    .unwrap();
    peer.action(Action::Publish {
        remote: "origin".into(),
    })
    .unwrap();
    repo.action(Action::Fetch).unwrap();
    assert_eq!(repo.status().unwrap().behind, 1);
    repo.action(Action::Pull).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes.txt")).unwrap(),
        "second\n"
    );
    repo.action(Action::SwitchBranch {
        name: "origin/review".into(),
        remote: true,
    })
    .unwrap();
    assert_eq!(repo.status().unwrap().branch.as_deref(), Some("review"));
}

#[test]
fn deletes_only_the_selected_remote_branch_or_tag() {
    let (_dir, repo) = repo();
    repo.run([
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "First",
    ])
    .unwrap();
    let server = tempfile::tempdir().unwrap();
    let url = server.path().to_str().unwrap();
    repo.run(["init", "--bare", "--initial-branch=main", url])
        .unwrap();
    repo.run(["remote", "add", "origin", url]).unwrap();
    repo.run(["branch", "release/next"]).unwrap();
    repo.run(["tag", "--no-sign", "-m", "Release", "release/next"])
        .unwrap();
    repo.run([
        "push",
        "origin",
        "refs/heads/release/next",
        "refs/tags/release/next",
    ])
    .unwrap();

    for kind in [RemoteRefKind::Branch, RemoteRefKind::Tag] {
        let listing = repo.remote_refs("origin", kind).unwrap();
        let [selected] = listing.refs.as_slice() else {
            panic!("expected one ref");
        };
        assert_eq!(selected.name, "release/next");
        let reference = format!("{}release/next", kind.prefix());
        assert_eq!(
            selected.tip,
            repo.text(["rev-parse", "--verify", &reference]).unwrap()
        );
        let delete = |tip: String| Action::DeleteRemoteRef {
            remote: "origin".into(),
            ref_kind: kind,
            name: selected.name.clone(),
            tip,
            destination: listing.destination.clone(),
        };

        assert!(repo.action(delete("1".repeat(selected.tip.len()))).is_err());
        assert_eq!(repo.remote_refs("origin", kind).unwrap().refs.len(), 1);
        repo.action(delete(selected.tip.clone())).unwrap();
        assert!(repo.remote_refs("origin", kind).unwrap().refs.is_empty());
        repo.run(["show-ref", "--verify", &reference]).unwrap();
    }
    assert!(repo
        .run(["show-ref", "--verify", "refs/remotes/origin/release/next"])
        .is_err());
}

#[test]
fn remote_deletion_uses_the_push_url_and_rejects_a_changed_destination() {
    let (_dir, repo) = repo();
    repo.run([
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "First",
    ])
    .unwrap();
    let fetch_server = tempfile::tempdir().unwrap();
    let push_server = tempfile::tempdir().unwrap();
    let fetch_url = fetch_server.path().to_str().unwrap();
    let push_url = push_server.path().to_str().unwrap();
    for url in [fetch_url, push_url] {
        repo.run(["init", "--bare", "--initial-branch=main", url])
            .unwrap();
    }
    repo.run(["remote", "add", "origin", fetch_url]).unwrap();
    repo.run(["remote", "set-url", "--push", "origin", push_url])
        .unwrap();
    repo.run(["push", fetch_url, "HEAD:refs/tags/other"])
        .unwrap();
    repo.run(["push", "origin", "HEAD:refs/tags/release"])
        .unwrap();
    let listing = repo.remote_refs("origin", RemoteRefKind::Tag).unwrap();
    assert_eq!(listing.url, push_url);
    let [selected] = listing.refs.as_slice() else {
        panic!("expected one tag on the push server");
    };
    assert_eq!(selected.name, "release");
    repo.run(["remote", "set-url", "--push", "origin", fetch_url])
        .unwrap();
    assert!(repo
        .action(Action::DeleteRemoteRef {
            remote: "origin".into(),
            ref_kind: RemoteRefKind::Tag,
            name: selected.name.clone(),
            tip: selected.tip.clone(),
            destination: listing.destination,
        })
        .is_err_and(|error| error.key == "stalePushDestination"));
    repo.run(["remote", "set-url", "--add", "--push", "origin", push_url])
        .unwrap();
    assert!(repo
        .remote_refs("origin", RemoteRefKind::Tag)
        .is_err_and(|error| error.key == "multiplePushDestinations"));
}

#[test]
fn resolves_a_conflicting_merge_through_the_index() {
    let (dir, repo) = repo();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "base\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    repo.action(Action::CreateBranch {
        name: "draft".into(),
        checkout: true,
        start: None,
    })
    .unwrap();
    std::fs::write(&path, "draft\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Draft");
    repo.action(Action::SwitchBranch {
        name: "main".into(),
        remote: false,
    })
    .unwrap();
    std::fs::write(&path, "main\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Main change");

    assert!(repo
        .action(Action::Merge {
            name: "draft".into(),
            remote: false,
            tip: repo.text(["rev-parse", "draft"]).unwrap(),
            target: head_target(&repo),
        })
        .is_err());
    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.operation.as_deref(), Some("merge"));
    assert!(snapshot.status.files[0].conflict);
    repo.action(Action::AbortOperation).unwrap();
    assert!(repo.snapshot().unwrap().operation.is_none());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "main\n");

    assert!(repo
        .action(Action::Merge {
            name: "draft".into(),
            remote: false,
            tip: repo.text(["rev-parse", "draft"]).unwrap(),
            target: head_target(&repo),
        })
        .is_err());
    let id = repo.status().unwrap().files.remove(0).id;
    let conflict = repo.conflict(&id).unwrap();
    assert_eq!(conflict.base.as_deref(), Some("base\n"));
    assert_eq!(conflict.current.as_deref(), Some("main\n"));
    assert_eq!(conflict.incoming.as_deref(), Some("draft\n"));
    assert!(repo
        .action(Action::ResolveConflict {
            id: id.clone(),
            token: conflict.token.clone(),
            text: conflict.result.clone(),
        })
        .is_err_and(|error| error.key == "unresolvedConflict"));
    std::fs::write(&path, "external edit\n").unwrap();
    assert!(repo
        .action(Action::ResolveConflict {
            id: id.clone(),
            token: conflict.token,
            text: "main and draft\n".into(),
        })
        .is_err_and(|error| error.key == "staleConflict"));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "external edit\n");
    repo.action(Action::ResolveConflict {
        token: repo.conflict(&id).unwrap().token,
        id,
        text: "main and draft\n".into(),
    })
    .unwrap();
    repo.action(Action::ContinueOperation).unwrap();
    let snapshot = repo.snapshot().unwrap();
    assert!(snapshot.operation.is_none());
    assert_eq!(snapshot.commits[0].parents.len(), 2);
    assert!(repo
        .commit_diff(&snapshot.commits[0].id)
        .unwrap()
        .text
        .contains("+main and draft"));
    repo.action(Action::DeleteBranch {
        name: "draft".into(),
    })
    .unwrap();
}

#[test]
fn rejects_stash_actions_after_the_selected_entry_moves() {
    let (dir, repo) = repo();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "baseline\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    std::fs::write(&path, "selected\n").unwrap();
    repo.action(Action::Stash {
        message: "Selected stash".into(),
        include_untracked: false,
    })
    .unwrap();
    let selected = repo.snapshot().unwrap().stashes.remove(0);

    std::fs::write(&path, "newer\n").unwrap();
    repo.action(Action::Stash {
        message: "Newer stash".into(),
        include_untracked: false,
    })
    .unwrap();
    for action in [
        Action::ApplyStash {
            id: selected.id.clone(),
            tip: selected.tip.clone(),
        },
        Action::PopStash {
            id: selected.id.clone(),
            tip: selected.tip.clone(),
        },
        Action::DropStash {
            id: selected.id,
            tip: selected.tip.clone(),
        },
    ] {
        assert!(repo
            .action(action)
            .is_err_and(|error| error.key == "staleStash"));
        assert_eq!(repo.snapshot().unwrap().stashes.len(), 2);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "baseline\n");
    }

    // The same stash is still usable once its new selector has been loaded.
    let refreshed = repo.snapshot().unwrap().stashes.remove(1);
    assert_eq!(refreshed.tip, selected.tip);
    repo.action(Action::ApplyStash {
        id: refreshed.id.clone(),
        tip: refreshed.tip.clone(),
    })
    .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "selected\n");
    repo.action(Action::DropStash {
        id: refreshed.id,
        tip: refreshed.tip,
    })
    .unwrap();
    let remaining = repo.snapshot().unwrap().stashes;
    assert_eq!(remaining.len(), 1);
    assert!(remaining[0].subject.contains("Newer stash"));
}

#[test]
fn keeps_the_stash_when_pop_conflicts() {
    let (dir, repo) = repo();
    let path = dir.path().join("notes.txt");
    std::fs::write(&path, "baseline\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    std::fs::write(&path, "stashed\n").unwrap();
    repo.action(Action::Stash {
        message: "Keep on conflict".into(),
        include_untracked: false,
    })
    .unwrap();
    let selected = repo.snapshot().unwrap().stashes.remove(0);
    std::fs::write(&path, "conflicting\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Conflicting change");

    assert!(repo
        .action(Action::PopStash {
            id: selected.id,
            tip: selected.tip.clone(),
        })
        .is_err());
    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.stashes.len(), 1);
    assert_eq!(snapshot.stashes[0].tip, selected.tip);
    assert!(snapshot.status.files.iter().any(|file| file.conflict));
}

#[test]
fn creates_lightweight_tags_when_tag_signing_is_enabled() {
    let (dir, repo) = repo();
    std::fs::write(dir.path().join("notes.txt"), "baseline\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    let head = repo.status().unwrap().head.unwrap();
    repo.run(["config", "tag.gpgSign", "true"]).unwrap();
    for (name, start) in [("at-head", None), ("at-commit", Some(head.clone()))] {
        repo.action(Action::CreateTag {
            name: name.into(),
            start,
        })
        .unwrap();
        assert_eq!(
            repo.text(["cat-file", "-t", &format!("refs/tags/{name}")])
                .unwrap(),
            "commit"
        );
        assert_eq!(
            repo.text(["rev-parse", &format!("refs/tags/{name}")])
                .unwrap(),
            head
        );
    }
}

#[test]
fn preserves_the_index_when_stashing_and_restoring_changes() {
    let (dir, repo) = repo();
    let path = dir.path().join("notes.txt");
    let untracked = dir.path().join("scratch.txt");
    std::fs::write(&path, "baseline\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    commit(&repo, "Baseline");
    std::fs::write(&path, "staged\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    std::fs::write(&path, "unstaged\n").unwrap();
    std::fs::write(&untracked, "untracked\n").unwrap();

    repo.action(Action::Stash {
        message: "WIP".into(),
        include_untracked: true,
    })
    .unwrap();
    assert!(repo.status().unwrap().files.is_empty());
    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.commits.len(), 4);
    let stash_commit = snapshot
        .commits
        .iter()
        .find(|commit| commit.id == snapshot.stashes[0].tip)
        .unwrap();
    assert_eq!(stash_commit.parents.len(), 3);
    repo.action(Action::PopStash {
        id: snapshot.stashes[0].id.clone(),
        tip: snapshot.stashes[0].tip.clone(),
    })
    .unwrap();
    assert!(repo.snapshot().unwrap().stashes.is_empty());
    assert!(untracked.exists());
    let file = repo
        .status()
        .unwrap()
        .files
        .into_iter()
        .find(|file| file.path == "notes.txt")
        .unwrap();
    assert_eq!((file.index, file.worktree), ('M', 'M'));
    repo.action(Action::Discard {
        token: repo.discard_plan(&file.id).unwrap().token,
        id: file.id,
    })
    .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "staged\n");
}

#[test]
fn creates_an_ssh_signed_commit_with_repository_settings() {
    let (dir, repo) = repo();
    let key = dir.path().join(".git/test-signing-key");
    let result = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output();
    if result
        .as_ref()
        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
    {
        eprintln!("Skipping SSH signing check because ssh-keygen is unavailable");
        return;
    }
    assert!(result.unwrap().status.success());
    let mut settings = repo.settings().unwrap();
    settings.sign_commits = true;
    settings.signing_format = "ssh".into();
    settings.signing_key = key.to_string_lossy().into_owned();
    repo.action(Action::SaveSettings { settings }).unwrap();
    std::fs::write(dir.path().join("notes.txt"), "signed\n").unwrap();
    repo.action(Action::StageAll).unwrap();
    repo.action(Action::Commit {
        summary: "Signed commit".into(),
        description: String::new(),
        sign: true,
        amend: None,
    })
    .unwrap();
    let raw = repo.text(["cat-file", "commit", "HEAD"]).unwrap();
    assert!(raw.contains("gpgsig -----BEGIN SSH SIGNATURE-----"));
}
