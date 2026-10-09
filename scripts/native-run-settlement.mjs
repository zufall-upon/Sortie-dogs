import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** CLI close ends one root turn, not its background descendants or Mission.
 * Read native state only; never dispatch another prompt or manufacture acceptance. */
export function nativeRunPending(project, databasePath, { since = 0, root } = {}) {
  if (!databasePath) return false;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const sessions = db.prepare('SELECT id, parent_id, time_idle, idle_outcome FROM session_v2 WHERE directory IN (?, ?) AND time_created >= ? ORDER BY time_created')
      .all(project, project.replaceAll('\\', '/'), since);
    root ??= sessions.filter(s => !s.parent_id && db.prepare("SELECT 1 FROM session_message WHERE session_id = ? AND type = 'assistant' LIMIT 1").get(s.id)).at(-1)?.id;
    if (!root) return false;
    const ids = new Set([root]);
    for (let size = -1; size !== ids.size;) {
      size = ids.size;
      for (const session of sessions) if (ids.has(session.parent_id)) ids.add(session.id);
    }
    for (const session of sessions.filter(s => ids.has(s.id))) {
      if (db.prepare('SELECT 1 FROM session_pending WHERE session_id = ? LIMIT 1').get(session.id) ||
          db.prepare('SELECT 1 FROM session_inbox WHERE session_id = ? LIMIT 1').get(session.id)) return true;
      const row = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1").get(session.id);
      if (!row) {
        if (session.parent_id && !session.time_idle) return true;
        continue;
      }
      const message = JSON.parse(row.data);
      if ((!message.time?.completed && !message.error) ||
          (message.content ?? []).some(p => p.type === 'tool' && ['pending', 'running'].includes(p.state?.status))) return true;
      if (!session.time_idle && !session.idle_outcome) return true;
    }
    const missionPath = join(project, '.sortie-dogs-v010', 'missions', `${createHash('sha256').update(root).digest('hex')}.json`);
    if (existsSync(missionPath)) {
      const mission = JSON.parse(readFileSync(missionPath, 'utf8'));
      if (!['completed', 'cancelled'].includes(mission.phase)) return true;
    }
    return false;
  } finally { db.close(); }
}

/** Shared by benchmark and complete-mode practical CLI; existing callers own limits. */
export async function waitForNativeSettlement({ pending, stopped, pause = () => new Promise(resolve => setTimeout(resolve, 250)) }) {
  while (!stopped() && await pending()) await pause();
}
