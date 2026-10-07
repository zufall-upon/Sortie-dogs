import { nativeTerminal } from './usage.mjs';

async function boundedCall(call, milliseconds) {
  if (milliseconds <= 0) throw new Error('settlement deadline reached');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => call(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('settlement observation timed out'));
      }, milliseconds); })]);
  } finally { clearTimeout(timer); }
}

// One deadline from the stop decision, shared by interrupts, state queries and exports.
export function createObservationDeadline({ now = Date.now, started = now(), budgetMs = 10_000,
  wallDeadline = Infinity } = {}) {
  const deadline = Math.max(started, Math.min(started + Math.max(0, Math.min(10_000, budgetMs)), wallDeadline));
  return { started, deadline, remaining: () => Math.max(0, deadline - now()),
    call: (call, capMs = Infinity) => boundedCall(call, Math.min(capMs, Math.max(0, deadline - now()))) };
}

// Export concurrently with the drain so missing usage cannot consume a second budget
// or prevent preservation of already returned native histories. New owned children
// discovered by a later DB snapshot get the same remaining observation deadline.
export async function recoverOwnedSessions({ exportSession, ...options }) {
  const observationDeadline = options.observationDeadline ?? createObservationDeadline(options);
  const exports = new Map();
  let settlement;
  try {
    settlement = await settleOwnedSessions({ ...options, observationDeadline, readUsage: () => {
      const usage = options.readUsage();
      for (const session of usage.sessions) if (!exports.has(session.id)) {
        exports.set(session.id, observationDeadline.call(signal => exportSession(session.id, signal)).then(
          history => ({ session_id: session.id, history }),
          () => ({ session_id: session.id, error: 'session-export-unconfirmed' })));
      }
      return usage;
    } });
  } catch {
    settlement = { status: 'query-error', native_settled: false, error: 'settlement-observation-unconfirmed' };
  }
  const results = await Promise.all(exports.values());
  return { settlement, history: results.filter(item => !item.error).map(item => item.history),
    history_errors: results.filter(item => item.error).map(({ session_id, error }) => ({ session_id, error })),
    observation_budget_ms: observationDeadline.deadline - observationDeadline.started };
}

// Read-only drain after safety-stop. No prompt, resume, retry or replacement session API.
export async function settleOwnedSessions({ readUsage, observeSession, listPermissions, activeTools,
  interrupt, requested = new Set(), record = async () => {}, now = Date.now,
  isTerminal = nativeTerminal,
  wait = ms => new Promise(done => setTimeout(done, ms)), budgetMs = 10_000, intervalMs = 250,
  observationDeadline = createObservationDeadline({ now, budgetMs }) }) {
  const { started, deadline, remaining } = observationDeadline;
  const interruptions = [];
  let last = null, samples = 0;
  do {
    const usage = readUsage();
    // Re-read descendants each time; an ack does not prove native termination.
    await Promise.all(usage.sessions.filter(item => !isTerminal(item) && !requested.has(item.id)).map(async item => {
      if (!remaining()) return;
      requested.add(item.id);
      try {
        await boundedCall(signal => interrupt(item.id, signal), Math.min(2_000, remaining()));
        interruptions.push({ session_id: item.id, requested: true, acknowledged: true, error: null });
      } catch {
        interruptions.push({ session_id: item.id, requested: true, acknowledged: false, error: 'interrupt-unconfirmed' });
      }
    }));
    const observations = await Promise.all(usage.sessions.map(async item => {
      const query = async call => {
        try { return { status: 'observed', value: await boundedCall(call, Math.min(1_000, remaining())) }; }
        catch { return { status: 'query-error', value: null }; }
      };
      const [state, permissions] = await Promise.all([
        query(signal => observeSession(item.id, signal)), query(signal => listPermissions(item.id, signal)),
      ]);
      const apiTerminal = state.status === 'observed' && isTerminal({ ...state.value, id: item.id });
      const dbTerminal = isTerminal(item);
      return { session_id: item.id, db_terminal: dbTerminal,
        db_outcome: item.idle_outcome ?? null, db_idle: item.time_idle ?? null,
        api_status: state.status, api_terminal: apiTerminal,
        terminal_state_matches: dbTerminal && apiTerminal &&
          state.value.outcome === item.idle_outcome && state.value.time.idle === item.time_idle,
        api_outcome: state.value?.outcome ?? null, api_idle: state.value?.time?.idle ?? null,
        permission_status: permissions.status,
        pending_permissions: permissions.status === 'observed' && Array.isArray(permissions.value) ? permissions.value.length : null };
    }));
    const tools = activeTools();
    const statesSettled = observations.length > 0 && observations.every(item => item.db_terminal &&
       item.api_terminal && item.terminal_state_matches && item.permission_status === 'observed' && item.pending_permissions === 0) && tools.length === 0;
    last = { at: new Date(now()).toISOString(), usage, observations, active_tool_count: tools.length,
      native_settled: statesSettled, usage_recovered: usage.cost_estimate_complete,
      elapsed_ms: now() - started };
    samples += 1;
    await record(last);
    if (statesSettled && usage.cost_estimate_complete) break;
    if (remaining()) await wait(Math.min(intervalMs, remaining()));
  } while (remaining());
  return { ...last, elapsed_ms: now() - started, samples, budget_ms: deadline - started,
    status: last.native_settled && last.usage_recovered ? 'settled' : 'deadline-unresolved', interruptions };
}
