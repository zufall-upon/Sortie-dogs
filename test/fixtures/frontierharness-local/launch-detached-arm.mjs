#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContext } from "./run-local-case-study.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const argv = process.argv.slice(2);
const armIndex = argv.indexOf("--arm"), manifestIndex = argv.indexOf("--manifest");
const arm = armIndex >= 0 ? argv[armIndex + 1] : undefined;
const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : undefined;
if (!(["bare", "sortie"].includes(arm)) || typeof manifestPath !== "string") {
  fail("Usage: node launch-detached-arm.mjs --arm bare|sortie --manifest <path>");
} else {
  const context = await loadContext(manifestPath);
  const statePath = join(context.runtimeRoot, "frontierharness-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.preflight?.status !== "pass" || state.prepared?.status !== "pass" || state.arms?.[arm]?.attempted) {
    fail("Detached launch requires a prepared, unattempted arm.");
  } else if (arm === "sortie" && state.arms?.bare?.run?.status !== "complete") {
    fail("Bare must complete before Sortie starts.");
  } else {
    const marker = join(context.runtimeRoot, `${arm}-controller-launch.json`);
    let markerHandle;
    try { markerHandle = openSync(marker, "wx", 0o600); }
    catch { fail("This arm already has a detached controller launch marker."); }
    if (markerHandle !== undefined) {
      const output = openSync(join(context.runtimeRoot, `${arm}-controller.stdout.jsonl`), "wx", 0o600);
      const error = openSync(join(context.runtimeRoot, `${arm}-controller.stderr.log`), "wx", 0o600);
      const runner = resolve(dirname(fileURLToPath(import.meta.url)), "run-local-case-study.mjs");
      const child = spawn(process.execPath, [runner, "run-arm", "--arm", arm, "--manifest", resolve(manifestPath)], {
        cwd: context.repositoryRoot, detached: true, windowsHide: true, stdio: ["ignore", output, error],
        env: { ...process.env },
      });
      closeSync(output); closeSync(error);
      writeFileSync(markerHandle, `${JSON.stringify({ schema_version: 1, arm, controller_pid: child.pid,
        launched_at: new Date().toISOString(), output: "sanitized-runner-only" })}\n`);
      closeSync(markerHandle);
      child.unref();
      process.stdout.write(`${JSON.stringify({ status: "launched", arm, controller_pid: child.pid })}\n`);
    }
  }
}
