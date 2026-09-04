# Unit 5: output path policy

Create `output/unit-5.mjs` and export `resolveOutputPath(root, candidate)`.

Requirements:

- Require a non-empty absolute `root` path.
- Accept only normalized forward-slash paths shaped as `output/<name>.mjs`.
- `<name>` may contain ASCII letters, digits, dots, underscores, and hyphens, but may not start with a dot.
- Reject absolute candidates, backslashes, empty segments, `.` segments, `..` segments, and other extensions.
- Return the platform-native absolute path below `root`.
- Verify containment after path resolution.
- Do not access the filesystem.

Acceptance command: `node --test test/unit-5.test.mjs`.
