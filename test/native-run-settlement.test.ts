import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nativeRunPending, waitForNativeSettlement } from '../scripts/native-run-settlement.mjs';

test('root turn exit does not settle a native background Worker, inbox or unfinished Mission', async () => {
  const project = await mkdtemp(join(tmpdir(), 'native-settlement-'));
  const path = join(project, 'native.db'), db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE session_v2(id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_idle INTEGER, idle_outcome TEXT);
      CREATE TABLE session_message(session_id TEXT, type TEXT, seq INTEGER, data TEXT);
      CREATE TABLE session_pending(session_id TEXT); CREATE TABLE session_inbox(session_id TEXT);`);
    const insertSession = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)');
    insertSession.run('root', null, project, 100, 120, 'succeeded');
    insertSession.run('worker', 'root', project, 110, null, null);
    // Native order need not put a parent before its grandchild.
    insertSession.run('grandchild', 'worker', project, 105, 125, 'succeeded');
    insertSession.run('foreign', null, project, 90, null, null);
    const insertMessage = db.prepare("INSERT INTO session_message VALUES (?, 'assistant', 1, ?)");
    insertMessage.run('root', JSON.stringify({ time: { completed: 120 }, finish: 'stop', content: [] }));
    insertMessage.run('worker', JSON.stringify({ time: { created: 110 }, content: [{ type: 'tool', name: 'read', state: { status: 'running' } }] }));
    insertMessage.run('grandchild', JSON.stringify({ time: { completed: 125 }, content: [] }));
    insertMessage.run('foreign', JSON.stringify({ time: { created: 90 }, content: [] }));
    assert.equal(nativeRunPending(project, path, { since: 100 }), true);
    db.prepare("UPDATE session_message SET data = ? WHERE session_id = 'worker'").run(JSON.stringify({ time: { completed: 130 }, content: [] }));
    db.exec("UPDATE session_v2 SET time_idle = 130, idle_outcome = 'succeeded' WHERE id = 'worker'");
    assert.equal(nativeRunPending(project, path, { since: 100 }), false, 'foreign root does not hold this Mission open');
    for (const table of ['session_pending', 'session_inbox']) {
      db.exec(`INSERT INTO ${table} VALUES ('root')`);
      assert.equal(nativeRunPending(project, path, { since: 100 }), true, 'queued parent continuation is not settlement');
      db.exec(`DELETE FROM ${table}`);
    }
    const missions = join(project, '.sortie-dogs-v010', 'missions');
    await mkdir(missions, { recursive: true });
    const mission = join(missions, `${createHash('sha256').update('root').digest('hex')}.json`);
    await writeFile(mission, JSON.stringify({ phase: 'submitted' }));
    assert.equal(nativeRunPending(project, path, { since: 100 }), true, 'Worker success is not root acceptance');
    await writeFile(mission, JSON.stringify({ phase: 'completed' }));
    assert.equal(nativeRunPending(project, path, { since: 100 }), false);
    await writeFile(mission, JSON.stringify({ phase: 'cancelled' }));
    assert.equal(nativeRunPending(project, path, { since: 100 }), false);
  } finally { db.close(); await rm(project, { recursive: true, force: true }); }
});

test('shared settlement wait preserves caller-owned stop conditions and propagates observation failures', async () => {
  let calls = 0, stops = false;
  await waitForNativeSettlement({ pending: () => ++calls < 3, stopped: () => stops, pause: async () => {} });
  assert.equal(calls, 3);
  calls = 0;
  await waitForNativeSettlement({ pending: () => { calls++; return true; }, stopped: () => stops, pause: async () => { stops = true; } });
  assert.equal(calls, 1);
  await assert.rejects(waitForNativeSettlement({ pending: () => { throw Error('native read failed'); }, stopped: () => false }), /native read failed/);
});
