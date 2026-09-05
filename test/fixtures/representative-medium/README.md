# Representative medium benchmark

This directory is the durable authority for the five-unit representative benchmark. `_testenv` is only
a disposable runtime destination.

The workload contains five independent modules:

- `unit-1`: argument validation
- `unit-2`: retry scheduling
- `unit-3`: weighted batching
- `unit-4`: event reduction
- `unit-5`: output path policy

Each unit has one specification, one pre-written test, one acceptance item, and one disjoint output path.
The serial manifest and Luna template consume those same files. `validate.mjs` is the shared final
validation command.

Prepare a runtime copy without running either route:

```text
node test/fixtures/representative-medium/run-representative-rpt.mjs --prepare --runtime-root _testenv/representative-medium --package _testenv/sortie-dogs-0.8.2.tgz
```

The command creates a deterministic nested Git baseline, `representative-config.json`, and an exact
`luna-fabric.json`. The config records the package SHA-256, fixture source SHA-256, target SHA, route
timeouts, expected writes, typed child counts, an isolated `opencode_config_dir`, and an isolated
`xdg_config_home`. It also records the exact top-level and nested `result_contract`, so the terminal
benchmark result needs no source scan. Launch OpenCode with `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` set to those
directories; the generated project-local plugin wrapper resolves the copied package through
`.opencode/package.json` without loading unrelated global plugins. Before OpenCode, run `npm install
--force` from both `<project>/.opencode` and `<xdg_config_home>/opencode`, then initialize the isolated
agent assets with `OPENCODE_CONFIG_DIR=<opencode_config_dir> node
<project>/.opencode/node_modules/sortie-dogs/dist/cli/main.js init --global`. Runtime values are never
written into this directory.

Preparation self-tests do not dispatch Sol or Luna:

```text
node test/fixtures/representative-medium/run-representative-rpt.mjs --self-test-result-identity --config _testenv/representative-medium/representative-config.json
node test/fixtures/representative-medium/run-representative-rpt.mjs --self-test-clean-workspace --config _testenv/representative-medium/representative-config.json
```
