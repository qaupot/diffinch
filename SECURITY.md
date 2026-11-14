# Security policy

Security fixes target the latest released version. During the 0.x series, update to the latest version before reporting an issue; older versions do not have a separate backport commitment.

## Report a vulnerability

On the project's GitHub repository, use **Security → Report a vulnerability** to send a private report. Include the affected version and platform, impact, and reproduction steps using a disposable repository. Remove real credentials and personal repository contents.

If private reporting is unavailable, open an issue asking a maintainer for a private reporting channel, without the vulnerability details or proof of concept. Do not post secrets or exploit details publicly while arranging that channel.

## Trust boundaries

Diffinch is a local Git client. It runs the installed Git and configured credential helpers, signing tools, hooks, filters, and optional Git extensions with your operating-system permissions. Only open repositories and use Git configuration you trust. The app is not a sandbox for malicious repositories.

Git credentials belong in the operating system's credential tools or Git's configured helper. Remote URLs shown in the interface remove embedded user information, query parameters, and fragments. Repository content, paths, and Git error output can still be sensitive; review screenshots and logs before sharing them.

Run dependency and secret scans manually before releases as described in the [release checklist](doc/releasing.md). The current upstream dependency limitations are tracked in [security review notes](doc/security-review.md). No scanner result guarantees the absence of a vulnerability.
