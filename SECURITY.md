# Security policy

## Supported versions

Security fixes target the latest published `sortie-dogs` release. Older versions are not maintained
as separate security branches; there is no LTS or guaranteed backport policy. Check
[GitHub Releases](https://github.com/zufall-upon/Sortie-dogs/releases/latest) and the
[npm package](https://www.npmjs.com/package/sortie-dogs) for current versions.

Reports about older releases are still useful, especially when the issue also affects the latest
release. Include the installed version and runtime asset marker where available; a package update
does not by itself prove that a running host has reloaded it.

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting form](https://github.com/zufall-upon/Sortie-dogs/security/advisories/new),
also available under **Security → Report a vulnerability**. Do not post exploitable details,
credentials or private artifacts in public issues or PRs.

Include what you can safely share:

- Affected Sortie-dogs version/commit, host and host version, OS and Node.js version.
- Minimal reproduction, required permissions/configuration and expected versus observed behavior.
- Potential impact and affected boundary, such as unauthorized writes, host-permission bypass,
  credential exposure or unsafe handling of untrusted artifacts.
- Redacted evidence and any proposed mitigation. Use a synthetic example instead of real secrets.

If the private form is unavailable, open a public issue only to request a private contact route,
without vulnerability details. No dedicated security email address is currently published.

The maintainer will triage reports and coordinate fixes and disclosure with the reporter as capacity
allows. There is no guaranteed response/fix deadline or paid bug-bounty program. Please coordinate
public disclosure rather than publishing an unpatched exploit in an ordinary issue.

## Execution boundaries

Sortie-dogs can coordinate file writes and command execution through OpenCode or Codex. It is **not
an independent operating-system sandbox**. Existing host permissions and approvals remain
authoritative; manifests and receipts do not make an untrusted repository, model response or shell
command safe. Use host isolation appropriate to the work and review requested permissions.

Ordinary model mistakes, expected permission denials and bugs without a security impact belong in
the [bug report form](https://github.com/zufall-upon/Sortie-dogs/issues/new?template=bug_report.yml).
If the security impact is unclear, a private report is appropriate. Accessibility feedback follows
[ACCESSIBILITY.md](ACCESSIBILITY.md); community conduct follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
