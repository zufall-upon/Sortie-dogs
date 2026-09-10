import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSortieResult, createGoalReport, insertSortieResult } from '../../../dist/plugin/run-metrics.js';
import { summarizeCareer } from '../../../dist/plugin/sortie-career.js';
import { goalFingerprint } from '../../../dist/core/goal-bound.js';

const variants = [
  ['DONE', '✅ 任務完了', 'succeeded', 'completed'],
  ['INTERRUPTED', '⚠️ 中断帰還（未完了）', 'stopped', 'stopped'],
  ['BLOCKED', '⛔ 外部要因で待機（未完了）', 'stopped', 'external_dependency'],
  ['NEED_DECISION', '❓ 指示待ち（未完了）', 'stopped', 'awaiting_user'],
];
const cards = variants.map(([state, title, status, reason]) => {
  const receipt = { goal_id: 'synthetic-preview', terminal_revision: 1, acceptance_fingerprint: 'sha256:fixture',
    started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:12:24Z', status, stop_reason: reason,
    unit_ids: [], session_ids: [], evidence_refs: [], milestone_at: null };
  const result = createSortieResult(receipt, { acceptance_contract: null, consumed_time_ms: null, satisfied_criteria: [] },
    state === 'DONE' ? { tokens: 840000, cost: undefined, steps: 20, sessions: 5 } : undefined);
  // Explicitly synthetic display data, not collected measurements or earned traits.
  if (state === 'DONE') result.debrief = {
    pack: [{ model: 'fixture/Luna', count: 2 }, { model: 'fixture/Terra', count: 1 }, { model: 'fixture/Sol', count: 1 }],
    mix: [{ model: 'fixture/Luna', tokens: 520800, percent: 62 }, { model: 'fixture/Terra', tokens: 201600, percent: 24 },
      { model: 'fixture/Sol', tokens: 117600, percent: 14 }],
    validation: 'PASS', review: 'PASS', traits: ['連携作戦', '修正から復帰'],
  };
  const events = [
    { kind: 'goal.accepted', at: receipt.started_at, goal_id: receipt.goal_id },
    { kind: 'unit.settled', at: receipt.ended_at, goal_id: receipt.goal_id, reservation_id: 'fixture-unit', elapsed_ms: 300000 },
    { kind: 'goal.terminal', at: receipt.ended_at, goal_id: receipt.goal_id, receipt },
    { kind: 'goal.reported', at: receipt.ended_at, goal_id: receipt.goal_id, report: createGoalReport(result, receipt) },
  ];
  result.career = summarizeCareer([events.map((event, index) => ({ event, sequence: index + 1, event_hash: goalFingerprint([event, index]), previous_hash: null }))],
    { files: 1, included: 1, unavailable: 0, truncated: false });
  return insertSortieResult(`status: ${state} — ${title}\n\n**変更点:** 架空の表示fixture\n\n**確認結果:** 実run未実施\n\n**次:** 表示確認`, result);
});
const directory = new URL('../../../_testenv/mission-debrief/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('preview.md', directory), '# Synthetic mission debrief previews\n\n架空値。ベンチマーク結果ではありません。\n\n' + cards.join('\n\n---\n\n') + '\n');
console.log(`Synthetic preview: ${fileURLToPath(new URL('preview.md', directory))}`);
