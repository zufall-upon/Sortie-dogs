import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { lintHandoff } from "../src/core/validate-semantics.ts";

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

const schema = await readJson(new URL("../src/schema/handoff-v0.1.schema.json", import.meta.url));
const minimal = await readJson(new URL("./fixtures/schema/valid-minimal-investigation.json", import.meta.url));
const interrupted = await readJson(new URL("./fixtures/schema/valid-minimal-interrupted.json", import.meta.url));
const full = await readJson(new URL("./fixtures/schema/valid-full-completion.json", import.meta.url));
const unknownField = await readJson(new URL("./fixtures/schema/invalid-unknown-field.json", import.meta.url));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function clone(value) {
  return structuredClone(value);
}

function assertValid(value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function assertInvalid(value) {
  assert.equal(validate(value), false, "expected schema validation to fail");
}

test("accepts minimal investigation, minimal interruption, and full completion fixtures", () => {
  assertValid(minimal);
  assertValid(interrupted);
  assertValid(full);
});

test("requires every common top-level field", () => {
  for (const key of ["version", "profile", "id", "created_at", "task", "state", "risks", "verification"]) {
    const candidate = clone(minimal);
    delete candidate[key];
    assertInvalid(candidate);
  }

  const missingNestedField = clone(minimal);
  delete missingNestedField.task.objective;
  assertInvalid(missingNestedField);
});

test("rejects invalid field types", () => {
  const invalidTitle = clone(minimal);
  invalidTitle.task.title = 42;
  assertInvalid(invalidTitle);

  const invalidExitCode = clone(interrupted);
  invalidExitCode.verification[0].exit_code = "zero";
  assertInvalid(invalidExitCode);
});

test("enforces constants and enums", () => {
  for (const [path, value] of [
    ["version", "0.2.0"],
    ["profile", "partial"]
  ]) {
    const candidate = clone(minimal);
    candidate[path] = value;
    assertInvalid(candidate);
  }

  const invalidSeverity = clone(full);
  invalidSeverity.risks[0].severity = "critical";
  assertInvalid(invalidSeverity);

  const invalidStatus = clone(full);
  invalidStatus.verification[0].status = "skipped";
  assertInvalid(invalidStatus);
});

test("rejects unknown fields except inside top-level ext", () => {
  assertInvalid(unknownField);

  const unknownTopLevel = clone(minimal);
  unknownTopLevel.unexpected = true;
  assertInvalid(unknownTopLevel);

  const openExtension = clone(minimal);
  openExtension.ext = { arbitrary: { nested: [1, true, null] } };
  assertValid(openExtension);
});

test("requires scope and sources only for the full profile", () => {
  assertValid(minimal);

  const missingBoth = clone(full);
  delete missingBoth.scope;
  delete missingBoth.sources;
  assertInvalid(missingBoth);

  const missingScope = clone(full);
  delete missingScope.scope;
  assertInvalid(missingScope);

  const missingSources = clone(full);
  delete missingSources.sources;
  assertInvalid(missingSources);
});

test("enforces string length, ID pattern, and unique scope boundaries", () => {
  const atBoundary = clone(full);
  atBoundary.id = `h${"a".repeat(127)}`;
  atBoundary.task.title = "t".repeat(160);
  atBoundary.task.objective = "o".repeat(2000);
  atBoundary.scope.paths = ["p".repeat(512)];
  assertValid(atBoundary);

  for (const mutate of [
    (candidate) => { candidate.id = `h${"a".repeat(128)}`; },
    (candidate) => { candidate.id = "-invalid"; },
    (candidate) => { candidate.task.title = ""; },
    (candidate) => { candidate.task.title = "t".repeat(161); },
    (candidate) => { candidate.task.objective = "o".repeat(2001); },
    (candidate) => { candidate.scope.paths = []; },
    (candidate) => { candidate.scope.paths = ["same", "same"]; }
  ]) {
    const candidate = clone(full);
    mutate(candidate);
    assertInvalid(candidate);
  }
});

test("validates RFC 3339 date-time values", () => {
  const offsetDateTime = clone(minimal);
  offsetDateTime.created_at = "2030-01-02T04:34:05+01:30";
  assertValid(offsetDateTime);

  for (const value of ["2030-01-02", "2030-02-30T03:04:05Z", "not-a-date"]) {
    const candidate = clone(minimal);
    candidate.created_at = value;
    assertInvalid(candidate);
  }
});

test("enforces the semantic exit-code invariant for every verification status", () => {
  for (const [status, exitCode] of [
    ["pass", 0],
    ["fail", 1],
    ["not_run", null]
  ]) {
    const candidate = clone(minimal);
    candidate.verification = [{ check: "focused-check", status, exit_code: exitCode, summary: "Focused result." }];
    assert.deepEqual(lintHandoff(candidate), []);
  }

  for (const [status, exitCode] of [
    ["pass", null],
    ["fail", 0],
    ["fail", null],
    ["not_run", 1]
  ]) {
    const candidate = clone(minimal);
    candidate.verification = [{ check: "focused-check", status, exit_code: exitCode, summary: "Focused result." }];
    assert.equal(lintHandoff(candidate).filter((issue) => issue.code === "verification_exit_code_mismatch").length, 1);
  }

  for (const status of ["pass", "fail", "not_run"]) {
    const candidate = clone(minimal);
    candidate.verification = [{ check: "focused-check", status, summary: "Focused result." }];
    assert.equal(lintHandoff(candidate).filter((issue) => issue.code === "verification_exit_code_mismatch").length, 1);
  }
});
