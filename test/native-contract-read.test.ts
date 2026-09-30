import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeContractReadView } from "../dist/plugin/native-contract-read.js";

test("native contract read exposes late verbatim requirements hidden by the 2000-character line clip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sortie-readable-contract-"));
  try {
    const path = ".sortie-dogs-v010/contracts/handoff.actual-anko.json";
    await mkdir(join(directory, ".sortie-dogs-v010/contracts"), { recursive: true });
    const original = "Preparation context. ".repeat(130) + "\n\n" +
      "Errors must contain the literal type error, the variable name, source type and declared target type.\n" +
      "For nil-assignment errors, the source type appears as <nil>.\n" +
      "Typed declarations without initial values are initialized to the Go zero value for that type.";
    const command = 'wsl.exe --cd "/mnt/m/isolated/project" -e /usr/bin/env GOCACHE="/mnt/m/isolated/project/.gocache" go test ./...';
    const contract = { version: "0.1.0", task: { objective: "Implement typed bindings" }, verification: [{ check: command }],
      ext: { "sortie-dogs/mission-context": { original_requests: [{ id: "msg_original", text: original }] },
        "sortie-dogs/acceptance-continuity": { criteria: ["Full task, including exact error text"], fingerprint: "unchanged" } } };
    const source = JSON.stringify(contract);
    await writeFile(join(directory, path), source);
    assert(!source.slice(0, 2000).includes("type error"), "reproduce the native long-line visibility defect");
    const view = await nativeContractReadView(directory, { path });
    assert(view?.includes(original));
    assert(view?.includes(command));
    assert(view?.includes("Full task, including exact error text"));
    assert.match(view!, /SORTIE_EXACT_CONTRACT_VIEW/);
    assert.equal(await readFile(join(directory, path), "utf8"), source, "display must not rewrite the registered contract");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native original-request reads expose full multiline text without changing ordinary repository JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sortie-readable-request-"));
  try {
    const path = `.sortie-dogs-v010/missions/${"a".repeat(64)}.request.json`;
    await mkdir(join(directory, ".sortie-dogs-v010/missions"), { recursive: true });
    const text = "Original instructions: ".repeat(120) + "\nvar x: int64\nLiteral <nil> and type error must remain visible.";
    const source = JSON.stringify({ id: "msg_original", text });
    await writeFile(join(directory, path), source);
    const view = await nativeContractReadView(directory, { path: join(directory, path) });
    assert(view?.includes(text));
    await writeFile(join(directory, "user.json"), source);
    assert.equal(await nativeContractReadView(directory, { path: "user.json" }), undefined);
    assert.equal(await nativeContractReadView(directory, { path: "missing.json" }), undefined);
    assert.equal(await readFile(join(directory, path), "utf8"), source);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
