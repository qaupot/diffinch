//! Exercise the real Serde boundary; the companion script checks these values
//! against TypeScript and ensures every frontend action kind has a request sample.
use super::{
    model::*,
    tests::{commit_file, repo},
    *,
};

#[test]
fn export_contract_fixtures() {
    let requests: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../tests/contracts/actions.json")).unwrap();
    for request in &requests {
        if request["command"] == "inspect_file" {
            serde_json::from_value::<FileInspectionRequest>(request["request"].clone()).unwrap();
        } else if request["command"] == "git_action" {
            serde_json::from_value::<GitActionRequest>(request["request"].clone()).unwrap();
        } else if request["command"] == "credential_account" {
            serde_json::from_value::<CredentialAccountRequest>(request["request"].clone())
                .unwrap_or_else(|error| panic!("{request}: {error}"));
        } else {
            serde_json::from_value::<Action>(request.clone())
                .unwrap_or_else(|error| panic!("{request}: {error}"));
        }
    }

    let (dir, repo) = repo();
    let author_settings = requests
        .iter()
        .find(|request| request["kind"] == "saveSettings")
        .unwrap();
    repo.action(serde_json::from_value(author_settings.clone()).unwrap())
        .unwrap();
    let base = commit_file(&repo, "notes.txt", "before\n", "Contract base");
    let target = commit_file(&repo, "notes.txt", "after\n", "Contract target");
    let plan = repo.rebase_plan(&base, false).unwrap();
    let author_plan = repo.author_plan(&base).unwrap();
    repo.action(Action::CreateTag {
        name: "v-test".into(),
        start: Some(base.clone()),
    })
    .unwrap();
    repo.action(Action::AddRemote {
        name: "origin".into(),
        url: "https://example.invalid/repo.git".into(),
    })
    .unwrap();
    std::fs::write(dir.path().join("notes.txt"), "stashed\n").unwrap();
    repo.action(Action::Stash {
        message: "Contract stash".into(),
        include_untracked: false,
    })
    .unwrap();
    std::fs::write(dir.path().join("notes.txt"), "working\n").unwrap();
    std::fs::write(
        dir.path().join("image.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    let mut snapshot = repo.snapshot().unwrap();
    for commit in &snapshot.commits {
        assert_eq!(commit.email, author_settings["settings"]["email"]);
    }
    snapshot.push_lease = Some(PushLease {
        branch: "main".into(),
        head: target.clone(),
        remote: "origin".into(),
        target: "refs/heads/main".into(),
        expected: base.clone(),
        destination: "opaque-push-destination".into(),
    });
    let mut credential_targets = repo.credential_targets("origin").unwrap();
    repo.run([
        "remote",
        "add",
        "ssh-target",
        "git@example.invalid:repo.git",
    ])
    .unwrap();
    credential_targets.extend(repo.credential_targets("ssh-target").unwrap());
    let responses = serde_json::json!({
        "FileInspectionResult": [
            repo.inspect_file(FileInspectionRequest::Catalog { revision: target.clone() }).unwrap(),
            repo.inspect_file(FileInspectionRequest::History { revision: target.clone(), file: "notes.txt".into(), limit: 1 }).unwrap(),
            repo.inspect_file(FileInspectionRequest::Blame { revision: target.clone(), file: "notes.txt".into(), page: 0 }).unwrap(),
            repo.inspect_file(FileInspectionRequest::Diff { revision: target.clone(), file: "notes.txt".into(), previous_path: None, options: DiffOptions::default() }).unwrap(),
        ],
        "Snapshot": snapshot,
        "WorkingState": repo.working_state().unwrap(),
        "Diff": repo.working_diff(false, DiffOptions::default()).unwrap(),
        "DiscardPlan": repo.discard_plan(&snapshot.status.files.iter().find(|file| file.path == "notes.txt").unwrap().id).unwrap(),
        "Comparison": repo.compare(&base, &target, false).unwrap(),
        "CommitSearch": repo.search_commits("Contract", SearchField::Title, false).unwrap(),
        "RebasePlan": plan,
        "AuthorPlan": author_plan,
        "Conflict": Conflict { base: Some("base".into()), current: Some("current".into()), incoming: None, result: "resolved".into(), token: "opaque-token".into(), marker_size: 5 },
        "RemoteRefs": RemoteRefs { destination: "opaque-destination".into(), url: "https://example.invalid/repo.git".into(), refs: vec![RemoteRef { name: "main".into(), tip: target }] },
        "CredentialTarget": credential_targets,
        "CredentialAccount": [CredentialAccount { username: Some("saved-user".into()) }, CredentialAccount { username: None }],
        "GitError": GitError::new("gitOutput", "Example error"),
    });
    if let Some(path) = std::env::var_os("DIFFINCH_CONTRACT_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&responses).unwrap()).unwrap();
    }
}
