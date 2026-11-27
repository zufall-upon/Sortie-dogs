import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { appExecLinkBufferDigest, sameAppExecLink } from "../dist/plugin/windows-app-exec-link.js";

function reparse(fields = ["package", "application", "target", "display"]): Buffer {
  const strings = Buffer.from(fields.map(field => `${field}\0`).join(""), "utf16le");
  const bytes = Buffer.alloc(12 + strings.length);
  bytes.writeUInt32LE(0x8000001b, 0);
  bytes.writeUInt16LE(bytes.length - 8, 4);
  bytes.writeUInt32LE(3, 8);
  strings.copy(bytes, 12);
  return bytes;
}

test("AppExecLink fingerprints only a complete supported reparse payload", () => {
  const bytes = reparse(["package", "application", "target", "emoji-😀"]);
  assert.deepEqual(appExecLinkBufferDigest(bytes), {
    hash: createHash("sha256").update(bytes).digest("hex"), length: bytes.length,
  });
  assert.notDeepEqual(appExecLinkBufferDigest(bytes), appExecLinkBufferDigest(reparse()));

  const wrongTag = Buffer.from(bytes); wrongTag.writeUInt32LE(0xa000000c, 0);
  const wrongLength = Buffer.from(bytes); wrongLength.writeUInt16LE(bytes.length - 9, 4);
  const unknownVersion = Buffer.from(bytes); unknownVersion.writeUInt32LE(4, 8);
  const noTerminator = Buffer.from(bytes); noTerminator.writeUInt16LE(65, noTerminator.length - 2);
  const emptyField = reparse(["package", "", "target", "display"]);
  const missingField = reparse(["package", "application", "target"]);
  const extraField = reparse(["package", "application", "target", "display", "extra"]);
  const brokenUnicode = Buffer.from(bytes); brokenUnicode.writeUInt16LE(0xdc00, 12);
  const oddLength = Buffer.concat([bytes, Buffer.from([0])]); oddLength.writeUInt16LE(oddLength.length - 8, 4);
  for (const invalid of [Buffer.alloc(7), wrongTag, wrongLength, unknownVersion, noTerminator,
    emptyField, missingField, extraField, brokenUnicode, oddLength, Buffer.alloc(16385)]) {
    assert.equal(appExecLinkBufferDigest(invalid), undefined);
  }
});

test("entry identity comparison binds both parent and reparse metadata", () => {
  const original = {
    canonicalEntry: "c:/fixture/alias.exe", parentDevice: "1", parentFile: "2",
    entryDevice: "1", entryFile: "3", entryMode: "4", entrySize: "0",
    entryChange: "5", entryModified: "6", linkHash: "a".repeat(64),
    reparseHash: "b".repeat(64), reparseLength: 42,
  };
  assert.equal(sameAppExecLink(original, { ...original }), true);
  for (const [key, replacement] of [
    ["canonicalEntry", "c:/elsewhere/alias.exe"], ["parentDevice", "9"], ["parentFile", "9"],
    ["entryDevice", "9"], ["entryFile", "9"], ["entryMode", "9"], ["entrySize", "9"],
    ["entryChange", "9"], ["entryModified", "9"], ["linkHash", "c".repeat(64)],
    ["reparseHash", "c".repeat(64)], ["reparseLength", 43],
  ] as const) assert.equal(sameAppExecLink(original, { ...original, [key]: replacement }), false, key);
});
