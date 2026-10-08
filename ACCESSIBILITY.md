# Accessibility

Sortie-dogs aims to make its documentation, commands and Mission results understandable without
relying only on graphics, color or emoji. Accessibility feedback and focused improvements are
welcome under the same [contribution process](CONTRIBUTING.md) as other changes.

## Current surfaces and limits

- The CLI and repository documentation provide textual commands, status and verification evidence.
  Workflow images are supplementary; the README also describes the workflow in text.
- Mission return cards include textual status alongside visual indicators. They use Markdown and
  collapsible HTML details; rendering, focus behavior and assistive-technology support depend on
  the OpenCode/Codex host and viewer.
- Sortie-dogs does not own the host application's keyboard navigation, theme or screen-reader
  integration. Host-specific barriers may need an upstream fix, but reports here can help identify
  responsibility and improve Sortie's output.
- A formal accessibility audit, WCAG conformance assessment and comprehensive screen-reader or
  keyboard-only test matrix have **not** been completed. This policy is not a conformance claim.

## Report a barrier

Use the [accessibility issue form](https://github.com/zufall-upon/Sortie-dogs/issues/new?template=accessibility.yml).
Describe the task you were trying to complete, the barrier, expected behavior and any workaround.
When relevant, include host/OS/browser or terminal versions and assistive technology/settings;
sharing personal or medical information is not required. Text descriptions are sufficient—screenshots
or video are optional. Redact private information from all evidence.

If the form itself is inaccessible, use a
[blank issue](https://github.com/zufall-upon/Sortie-dogs/issues/new) with the same information in any
readable format. Maintainers will triage as capacity allows; no resolution deadline is promised.

## Contribution priorities

- Keep meaningful status and actions available in text, not only through color, emoji or animation.
- Give informative images appropriate alternative text and explain workflows in prose.
- Use descriptive links, logical headings and copyable command examples.
- Preserve relevant host accessibility behavior; record exactly what was tested and what remains
  unverified when changing output or documentation.
