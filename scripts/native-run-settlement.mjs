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
    // The owned CLI can identify its root before this snapshot sees the row.
    // Absence is not native settlement; the caller still owns all stop limits.
    if (root && !sessions.some(session => session.id === root)) return true;
    root ??= sessions.filter(s => !s.parent_id && db.prepare("SELECT 1 FROM session_message WHERE session_id = ? AND type = 'assistant' LIMIT 1").get(s.id)).at(-1)?.id;
    if (!root) return false;
    const ids = new Set([root]);
    for (let size = -1; size !== ids.size;) {
      size = ids.size;
      for (const session of sessions) if (ids.has(session.parent_id)) ids.add(session.id);
    }
    // V2 2.2 removed session_pending; queued delivery remains in session_inbox.
    // Only this known optional table is omitted, never swallow other read errors.
    const hasPending = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_pending'").get());
    for (const session of sessions.filter(s => ids.has(s.id))) {
      if ((hasPending && db.prepare('SELECT 1 FROM session_pending WHERE session_id = ? LIMIT 1').get(session.id)) ||
          db.prepare('SELECT 1 FROM session_inbox WHERE session_id = ? LIMIT 1').get(session.id)) return true;
      const row = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1").get(session.id);
      if (!row) {
        // An explicitly owned CLI root can still be starting its first assistant,
        // just like an unstarted descendant. Missing messages are not native idle.
        if (!session.time_idle) return true;
        continue;
      }
      const message = JSON.parse(row.data);
      if ((!message.time?.completed && !message.error) ||
          (message.content ?? []).some(p => p.type === 'tool' && ['pending', 'running'].includes(p.state?.status))) return true;
      if (!session.time_idle && !session.idle_outcome) return true;
      // Background completion can resume a root while its previous idle epoch
      // remains persisted. A completed tool call (even Mission acceptance) is
      // not the new turn's idle event; its final response/usage can still follow.
      const lastMessageAt = message.time?.completed ?? message.time?.created;
      if (lastMessageAt && (!session.time_idle || session.time_idle < lastMessageAt)) return true;
      // Child idle precedes admission of its background completion notification.
      // The parent's earlier idle cannot settle in that gap. Only actual
      // completed background handoffs require this final native parent delivery.
      for (const row of db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant'").all(session.id)) {
        for (const part of JSON.parse(row.data).content ?? []) {
          if (part.type !== 'tool' || part.name !== 'subagent' || part.state?.status !== 'completed' ||
              (part.input ?? part.state?.input)?.background !== true) continue;
          const child = sessions.find(s => s.id === part.state?.metadata?.sessionID && s.parent_id === session.id);
          if (child?.time_idle && (!session.time_idle || session.time_idle < child.time_idle)) return true;
        }
      }
    }
    const missionPath = join(project, '.sortie-dogs-v010', 'missions', `${createHash('sha256').update(root).digest('hex')}.json`);
    if (existsSync(missionPath)) {
      const mission = JSON.parse(readFileSync(missionPath, 'utf8'));
      // A delivered blocker/decision is a stopped attempt, not acceptance. Native
      // writers, queued continuations and fresh idle epochs were checked above.
      const incompleteDelivery = mission.phase === 'submitted' && ['blocked', 'needs-decision'].includes(mission.submission?.status);
      if (!['completed', 'cancelled'].includes(mission.phase) && !incompleteDelivery) return true;
    }
    return false;
  } finally { db.close(); }
}

/** Shared by benchmark and complete-mode practical CLI; existing callers own limits. */
export async function waitForNativeSettlement({ pending, stopped, pause = () => new Promise(resolve => setTimeout(resolve, 250)) }) {
  while (!stopped() && await pending()) await pause();
}
