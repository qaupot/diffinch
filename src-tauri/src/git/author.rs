use super::{model::AuthorPlan, process::execute, refs::validate_oid, trim_line, Repo, Result};
use std::collections::HashMap;

const AUTHOR_REWRITE_LIMIT: usize = 2_000;

fn commit_parts(bytes: &[u8]) -> Result<(&[u8], &[u8])> {
    let end = bytes
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .ok_or("invalidAuthorCommit")?;
    Ok((&bytes[..end], &bytes[end..]))
}

fn author_identity(headers: &[u8]) -> Result<(&str, &str, &str)> {
    let mut authors = headers
        .split(|&byte| byte == b'\n')
        .filter_map(|line| line.strip_prefix(b"author "));
    let author = std::str::from_utf8(authors.next().ok_or("invalidAuthorCommit")?)
        .map_err(|_| "authorUnsupportedEncoding")?;
    if authors.next().is_some() {
        return Err("invalidAuthorCommit".into());
    }
    let (name, rest) = author.rsplit_once(" <").ok_or("invalidAuthorCommit")?;
    let (email, date) = rest.split_once("> ").ok_or("invalidAuthorCommit")?;
    Ok((name, email, date))
}

fn rewrite_commit(
    bytes: &[u8],
    parents: &HashMap<String, String>,
    author: Option<(&str, &str)>,
) -> Result<Vec<u8>> {
    let (headers, body) = commit_parts(bytes)?;
    let mut rewritten = Vec::with_capacity(bytes.len());
    let mut skip = false;
    for line in headers.split(|&byte| byte == b'\n') {
        if !line.starts_with(b" ") {
            // A signature covers the original commit bytes. A merge tag is
            // still valid only when its tagged parent has not been rewritten.
            skip = line.starts_with(b"gpgsig ") || line.starts_with(b"gpgsig-sha256 ");
            if let Some(parent) = line.strip_prefix(b"mergetag object ") {
                skip = parents.contains_key(std::str::from_utf8(parent).unwrap_or(""));
            }
        }
        if skip {
            continue;
        }
        if !rewritten.is_empty() {
            rewritten.push(b'\n');
        }
        let new_parent = line
            .strip_prefix(b"parent ")
            .and_then(|parent| parents.get(std::str::from_utf8(parent).unwrap_or("")));
        let new_author = author.filter(|_| line.starts_with(b"author "));
        if let Some(id) = new_parent {
            rewritten.extend_from_slice(format!("parent {id}").as_bytes());
        } else if let Some((name, email)) = new_author {
            let (_, _, date) = author_identity(headers)?;
            rewritten.extend_from_slice(format!("author {name} <{email}> {date}").as_bytes());
        } else {
            rewritten.extend_from_slice(line);
        }
    }
    rewritten.extend_from_slice(body);
    Ok(rewritten)
}

impl Repo {
    fn author_history(&self, id: &str) -> Result<(AuthorPlan, Vec<String>)> {
        if self.operation()?.is_some() {
            return Err("gitOperationActive".into());
        }
        let status = self.status()?;
        let branch = status.branch.ok_or("authorNeedsBranch")?;
        let head = status.head.ok_or("authorNeedsBranch")?;
        // Replacements, grafts and shallow boundaries can hide descendants or
        // change parentage. Do not materialize that altered view of history.
        if self.text(["rev-parse", "--is-shallow-repository"])? == "true"
            || !self
                .text(["for-each-ref", "--format=%(refname)", "refs/replace/"])?
                .is_empty()
            || self.common_dir()?.join("info/grafts").exists()
        {
            return Err("authorNeedsFullHistory".into());
        }
        let id = self.commit_target(id)?;
        let mut git = self.command();
        git.args(["--no-replace-objects", "merge-base", &id, &head]);
        let ancestor = execute(git, &[1], None)?;
        if trim_line(&ancestor.bytes) != id.as_bytes() {
            return Err("authorNotAncestor".into());
        }
        let descendants = self.text([
            "--no-replace-objects",
            "rev-list",
            "--topo-order",
            "--reverse",
            "--ancestry-path",
            &format!("--max-count={AUTHOR_REWRITE_LIMIT}"),
            &format!("{id}..{head}"),
            "--",
        ])?;
        let mut commits = vec![id.clone()];
        commits.extend(descendants.lines().map(str::to_owned));
        if commits.len() > AUTHOR_REWRITE_LIMIT {
            return Err("authorTooManyCommits".into());
        }
        let raw = self.author_commit(&id)?;
        let (headers, _) = commit_parts(&raw)?;
        if headers.split(|&byte| byte == b'\n').any(|line| {
            line.strip_prefix(b"encoding ")
                .is_some_and(|encoding| !encoding.eq_ignore_ascii_case(b"UTF-8"))
        }) {
            return Err("authorUnsupportedEncoding".into());
        }
        let (name, email, _) = author_identity(headers)?;
        let subject = self.text([
            "show",
            "--no-patch",
            "--no-show-signature",
            "--format=%s",
            &id,
            "--",
        ])?;
        Ok((
            AuthorPlan {
                branch,
                head,
                id,
                name: name.into(),
                email: email.into(),
                subject,
                affected_commits: commits.len(),
            },
            commits,
        ))
    }

    fn author_commit(&self, id: &str) -> Result<Vec<u8>> {
        validate_oid(id)?;
        let output = self.run(["--no-replace-objects", "cat-file", "commit", id])?;
        if output.truncated {
            return Err("invalidAuthorCommit".into());
        }
        Ok(output.bytes)
    }

    pub fn author_plan(&self, id: &str) -> Result<AuthorPlan> {
        self.author_history(id).map(|(plan, _)| plan)
    }

    pub(super) fn change_author(
        &self,
        branch: &str,
        head: &str,
        id: &str,
        name: &str,
        email: &str,
    ) -> Result<()> {
        let name = name.trim();
        let email = email.trim();
        if name.is_empty()
            || email.is_empty()
            || name
                .chars()
                .chain(email.chars())
                .any(|c| c.is_control() || matches!(c, '<' | '>'))
            || email.chars().any(char::is_whitespace)
        {
            return Err("invalidAuthorIdentity".into());
        }
        let (plan, commits) = self.author_history(id)?;
        if plan.branch != branch || plan.head != head {
            return Err("staleAuthorPlan".into());
        }
        if plan.name == name && plan.email == email {
            return Ok(());
        }
        let mut parents = HashMap::new();
        for commit in commits {
            let raw = self.author_commit(&commit)?;
            let rewritten =
                rewrite_commit(&raw, &parents, (commit == plan.id).then_some((name, email)))?;
            let mut git = self.command();
            git.args(["hash-object", "-t", "commit", "-w", "--stdin"]);
            let output = execute(git, &[], Some(&rewritten))?;
            let new_id = std::str::from_utf8(trim_line(&output.bytes))
                .map_err(|_| "invalidCommitId")?
                .to_owned();
            validate_oid(&new_id)?;
            parents.insert(commit, new_id);
        }
        let new_head = parents.get(head).ok_or("invalidAuthorCommit")?;
        let current = self.status()?;
        if current.branch.as_deref() != Some(branch)
            || current.head.as_deref() != Some(head)
            || self.operation()?.is_some()
        {
            return Err("staleAuthorPlan".into());
        }
        // Trees and the index are unchanged. Publish the complete new history
        // with a compare-and-swap, leaving the old tip in the branch reflog.
        self.run([
            "update-ref",
            "--no-deref",
            "--create-reflog",
            "-m",
            "diffinch: change commit author",
            &format!("refs/heads/{branch}"),
            new_head,
            head,
        ])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{
        model::Action,
        tests::{commit_file, repo},
    };

    fn change(repo: &Repo, plan: &AuthorPlan) -> Result<&'static str> {
        repo.action(Action::ChangeAuthor {
            branch: plan.branch.clone(),
            head: plan.head.clone(),
            id: plan.id.clone(),
            name: "새 작성자 O'Connor".into(),
            email: "new+author@example.invalid".into(),
        })
    }

    fn head(repo: &Repo) -> String {
        repo.text(["rev-parse", "HEAD"]).unwrap()
    }

    #[test]
    fn changes_an_older_author_preserving_descendants_and_uncommitted_work() {
        let (dir, repo) = repo();
        let base = commit_file(&repo, "file", "base", "Base");
        let selected = commit_file(&repo, "file", "selected", "Selected");
        let tip = commit_file(&repo, "file", "tip", "Tip");
        repo.run(["branch", "saved", &tip]).unwrap();
        repo.run(["tag", "saved-tag", &selected]).unwrap();
        repo.run(["update-ref", "refs/remotes/origin/main", &tip])
            .unwrap();
        let before = repo.snapshot().unwrap();
        std::fs::write(dir.path().join("file"), "staged").unwrap();
        repo.run(["add", "file"]).unwrap();
        std::fs::write(dir.path().join("file"), "unstaged").unwrap();
        std::fs::write(dir.path().join("untracked"), "keep").unwrap();
        let index = repo.run(["ls-files", "--stage", "-z"]).unwrap().bytes;
        let status = repo.run(["status", "--porcelain=v2", "-z"]).unwrap().bytes;
        let plan = repo.author_plan(&selected).unwrap();
        assert_eq!(plan.affected_commits, 2);
        assert_eq!(plan.name, "Diffinch Test");
        assert_eq!(change(&repo, &plan).unwrap(), "commitAuthorChanged");
        let new_tip = head(&repo);
        let new_selected = repo.text(["rev-parse", "HEAD^"]).unwrap();
        let mut parents = HashMap::new();
        parents.insert(selected.clone(), new_selected.clone());
        assert_eq!(
            repo.author_commit(&new_tip).unwrap(),
            rewrite_commit(&repo.author_commit(&tip).unwrap(), &parents, None).unwrap()
        );
        assert_eq!(
            repo.author_commit(&new_selected).unwrap(),
            rewrite_commit(
                &repo.author_commit(&selected).unwrap(),
                &HashMap::new(),
                Some(("새 작성자 O'Connor", "new+author@example.invalid"))
            )
            .unwrap()
        );
        assert_eq!(repo.text(["rev-parse", "HEAD^^"]).unwrap(), base);
        for (reference, expected) in [
            ("saved", &tip),
            ("saved-tag", &selected),
            ("refs/remotes/origin/main", &tip),
            ("main@{1}", &tip),
        ] {
            assert_eq!(repo.text(["rev-parse", reference]).unwrap(), *expected);
        }
        assert_eq!(
            repo.run(["ls-files", "--stage", "-z"]).unwrap().bytes,
            index
        );
        assert_eq!(
            repo.run(["status", "--porcelain=v2", "-z"]).unwrap().bytes,
            status
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file")).unwrap(),
            "unstaged"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("untracked")).unwrap(),
            "keep"
        );
        let after = repo.snapshot().unwrap();
        let edited = after
            .commits
            .iter()
            .find(|commit| commit.id == new_selected)
            .unwrap();
        let original = before
            .commits
            .iter()
            .find(|commit| commit.id == selected)
            .unwrap();
        assert_eq!(edited.author, "새 작성자 O'Connor");
        assert_eq!(edited.email, "new+author@example.invalid");
        assert_eq!(edited.date, original.date);
        assert_eq!(edited.subject, original.subject);
        repo.run(["fsck", "--no-dangling"]).unwrap();
    }

    #[test]
    fn changes_root_and_tip_and_does_not_rewrite_an_unchanged_identity() {
        let (_dir, repo) = repo();
        let root = commit_file(&repo, "file", "root", "Root");
        let plan = repo.author_plan(&root).unwrap();
        assert_eq!(plan.affected_commits, 1);
        repo.change_author(&plan.branch, &plan.head, &plan.id, &plan.name, &plan.email)
            .unwrap();
        assert_eq!(head(&repo), root);
        change(&repo, &plan).unwrap();
        assert_ne!(head(&repo), root);
        assert_eq!(
            repo.text(["show", "--format=%P", "--no-patch", "HEAD"])
                .unwrap(),
            ""
        );
        let tip = commit_file(&repo, "file", "tip", "Tip");
        let parent = repo.text(["rev-parse", "HEAD^"]).unwrap();
        change(&repo, &repo.author_plan(&tip).unwrap()).unwrap();
        assert_eq!(repo.text(["rev-parse", "HEAD^"]).unwrap(), parent);
    }

    #[test]
    fn preserves_merge_topology_and_unaffected_side_history() {
        let (_dir, repo) = repo();
        let root = commit_file(&repo, "base", "base", "Base");
        repo.run(["checkout", "-b", "side"]).unwrap();
        let side = commit_file(&repo, "side", "side", "Side");
        repo.run(["checkout", "main"]).unwrap();
        let selected = commit_file(&repo, "main", "main", "Main");
        repo.run([
            "-c",
            "commit.gpgsign=false",
            "merge",
            "--no-ff",
            "side",
            "-m",
            "Merge",
        ])
        .unwrap();
        let merge = head(&repo);
        let tree = repo.text(["rev-parse", "HEAD^{tree}"]).unwrap();
        let plan = repo.author_plan(&selected).unwrap();
        assert_eq!(plan.affected_commits, 2);
        change(&repo, &plan).unwrap();
        assert_eq!(repo.text(["rev-parse", "HEAD^2"]).unwrap(), side);
        assert_eq!(repo.text(["rev-parse", "HEAD^1^1"]).unwrap(), root);
        assert_eq!(repo.text(["rev-parse", "HEAD^{tree}"]).unwrap(), tree);
        assert_ne!(head(&repo), merge);
        let merge_plan = repo.author_plan(&head(&repo)).unwrap();
        let parents = repo
            .text(["show", "--no-patch", "--format=%P", "HEAD"])
            .unwrap();
        change(&repo, &merge_plan).unwrap();
        assert_eq!(
            repo.text(["show", "--no-patch", "--format=%P", "HEAD"])
                .unwrap(),
            parents
        );
        // Rewriting the root updates both paths and reconnects the merge.
        let root_plan = repo.author_plan(&root).unwrap();
        assert_eq!(root_plan.affected_commits, 4);
        change(&repo, &root_plan).unwrap();
        assert_eq!(
            repo.text(["rev-parse", "HEAD^1^1"]).unwrap(),
            repo.text(["rev-parse", "HEAD^2^1"]).unwrap()
        );
        assert_eq!(repo.text(["rev-parse", "side"]).unwrap(), side);
        repo.run(["fsck", "--no-dangling"]).unwrap();
    }

    #[test]
    fn rejects_stale_previews_detached_heads_and_unrelated_commits() {
        let (_dir, repo) = repo();
        let root = commit_file(&repo, "file", "root", "Root");
        let plan = repo.author_plan(&root).unwrap();
        let tip = commit_file(&repo, "file", "tip", "Tip");
        assert_eq!(change(&repo, &plan).unwrap_err().key, "staleAuthorPlan");
        assert_eq!(head(&repo), tip);
        let plan = repo.author_plan(&tip).unwrap();
        repo.run(["checkout", "-b", "other"]).unwrap();
        assert_eq!(change(&repo, &plan).unwrap_err().key, "staleAuthorPlan");
        repo.run(["checkout", "--detach", &tip]).unwrap();
        assert_eq!(
            repo.author_plan(&root).err().unwrap().key,
            "authorNeedsBranch"
        );
        repo.run(["checkout", "main"]).unwrap();
        repo.run(["checkout", "--orphan", "unrelated"]).unwrap();
        let unrelated = commit_file(&repo, "other", "other", "Other");
        repo.run(["checkout", "main"]).unwrap();
        assert_eq!(
            repo.author_plan(&unrelated).err().unwrap().key,
            "authorNotAncestor"
        );
        assert_eq!(head(&repo), tip);
    }

    #[test]
    fn rejects_invalid_identity_and_active_operations_without_changes() {
        let (_dir, repo) = repo();
        let id = commit_file(&repo, "file", "root", "Root");
        for (name, email) in [
            ("", "a@b"),
            ("Name\ncommitter injected", "a@b"),
            ("Name <bad>", "a@b"),
            ("Name", "bad email"),
            ("Name", "bad\0email"),
        ] {
            assert_eq!(
                repo.change_author("main", &id, &id, name, email)
                    .unwrap_err()
                    .key,
                "invalidAuthorIdentity"
            );
        }
        assert_eq!(head(&repo), id);
        let plan = repo.author_plan(&id).unwrap();
        std::fs::write(
            repo.git_dir().unwrap().join("MERGE_HEAD"),
            format!("{id}\n"),
        )
        .unwrap();
        assert_eq!(change(&repo, &plan).unwrap_err().key, "gitOperationActive");
        assert_eq!(head(&repo), id);
    }

    #[test]
    fn rejects_replaced_grafted_and_shallow_history() {
        let (_dir, repo) = repo();
        let root = commit_file(&repo, "file", "root", "Root");
        let tip = commit_file(&repo, "file", "tip", "Tip");
        repo.run(["replace", &root, &tip]).unwrap();
        assert_eq!(
            repo.author_plan(&tip).err().unwrap().key,
            "authorNeedsFullHistory"
        );
        repo.run(["replace", "-d", &root]).unwrap();
        let grafts = repo.common_dir().unwrap().join("info/grafts");
        std::fs::write(&grafts, "").unwrap();
        assert_eq!(
            repo.author_plan(&tip).err().unwrap().key,
            "authorNeedsFullHistory"
        );
        std::fs::remove_file(grafts).unwrap();
        std::fs::write(
            repo.common_dir().unwrap().join("shallow"),
            format!("{root}\n"),
        )
        .unwrap();
        assert_eq!(
            repo.author_plan(&tip).err().unwrap().key,
            "authorNeedsFullHistory"
        );
        assert_eq!(head(&repo), tip);
    }

    #[test]
    fn strips_invalid_signatures_and_preserves_raw_metadata_and_message_bytes() {
        let old_parent = "a".repeat(40);
        let new_parent = "b".repeat(40);
        let raw = format!("tree {}\nparent {old_parent}\nauthor Old <old@example.invalid> 123 +0900\ncommitter Committer <committer@example.invalid> 456 -0500\ngpgsig -----BEGIN SIGNATURE-----\n payload\n -----END SIGNATURE-----\ngpgsig-sha256 other\n continuation\nmergetag object {old_parent}\n type commit\n tag v1\n \n signed tag\nx-extra keep\n continuation\n\n# Message\n\nBody\n", "c".repeat(40));
        let mut raw = raw.into_bytes();
        raw.extend_from_slice(&[0xff, 0xfe]);
        let parents = HashMap::from([(old_parent, new_parent.clone())]);
        let rewritten =
            rewrite_commit(&raw, &parents, Some(("New", "new@example.invalid"))).unwrap();
        let text = String::from_utf8_lossy(&rewritten);
        assert!(!text.contains("gpgsig"));
        assert!(!text.contains("mergetag"));
        assert!(text.contains(&format!("parent {new_parent}\n")));
        assert!(text.contains("author New <new@example.invalid> 123 +0900\n"));
        assert!(text.contains("committer Committer <committer@example.invalid> 456 -0500\n"));
        assert!(text.contains("x-extra keep\n continuation\n"));
        assert_eq!(
            commit_parts(&rewritten).unwrap().1,
            commit_parts(&raw).unwrap().1
        );
    }

    #[test]
    fn leaves_the_branch_untouched_if_a_descendant_cannot_be_rewritten() {
        let (_dir, repo) = repo();
        let root = commit_file(&repo, "file", "root", "Root");
        let raw = repo.author_commit(&root).unwrap();
        let (headers, _) = commit_parts(&raw).unwrap();
        let first_line = headers.iter().position(|&byte| byte == b'\n').unwrap();
        let mut oversized = headers[..first_line].to_vec();
        oversized.extend_from_slice(format!("\nparent {root}").as_bytes());
        oversized.extend_from_slice(&headers[first_line..]);
        oversized.extend_from_slice(b"\n\n");
        oversized.extend(vec![b'x'; crate::git::OUTPUT_LIMIT]);
        let mut git = repo.command();
        git.args(["hash-object", "-t", "commit", "-w", "--stdin"]);
        let output = execute(git, &[], Some(&oversized)).unwrap();
        let tip = std::str::from_utf8(trim_line(&output.bytes)).unwrap();
        repo.run(["update-ref", "HEAD", tip, &root]).unwrap();
        let plan = repo.author_plan(&root).unwrap();
        assert_eq!(change(&repo, &plan).unwrap_err().key, "invalidAuthorCommit");
        assert_eq!(head(&repo), tip);
    }

    #[test]
    fn rejects_rewrites_above_the_history_limit() {
        let (_dir, repo) = repo();
        let mut stream = String::new();
        for index in 0..=AUTHOR_REWRITE_LIMIT {
            stream.push_str(&format!(
                "commit refs/heads/main\ncommitter Test <test@example.invalid> {} +0000\ndata 1\nx\n\n",
                1_700_000_000 + index
            ));
        }
        let mut git = repo.command();
        git.args(["fast-import", "--quiet"]);
        execute(git, &[], Some(stream.as_bytes())).unwrap();
        let root = repo.text(["rev-list", "--max-parents=0", "HEAD"]).unwrap();
        let tip = head(&repo);
        assert_eq!(
            repo.author_plan(&root).err().unwrap().key,
            "authorTooManyCommits"
        );
        assert_eq!(head(&repo), tip);
    }

    #[test]
    fn rewrites_signed_commits_without_retaining_invalid_signatures() {
        let (dir, repo) = repo();
        let key = dir.path().join("signing-key");
        let result = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .output()
            .unwrap();
        assert!(result.status.success());
        repo.run(["config", "gpg.format", "ssh"]).unwrap();
        repo.run(["config", "user.signingkey", key.to_str().unwrap()])
            .unwrap();
        commit_file(&repo, "file", "root", "Root");
        repo.run(["commit", "--amend", "--no-edit", "-S"]).unwrap();
        let root = head(&repo);
        repo.run(["commit", "--allow-empty", "-m", "Signed descendant", "-S"])
            .unwrap();
        let old_tip = head(&repo);
        assert!(repo
            .text(["cat-file", "commit", &old_tip])
            .unwrap()
            .contains("gpgsig "));
        change(&repo, &repo.author_plan(&root).unwrap()).unwrap();
        for id in ["HEAD", "HEAD^"] {
            assert!(!repo
                .text(["cat-file", "commit", id])
                .unwrap()
                .contains("gpgsig "));
        }
        assert!(repo
            .text(["cat-file", "commit", &old_tip])
            .unwrap()
            .contains("gpgsig "));
        repo.run(["fsck", "--no-dangling"]).unwrap();
    }
}
