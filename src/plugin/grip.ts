import { createHash } from "node:crypto";
import type { MissionGrip, GripQuestion } from "../core/grip.js";
import { OperatorMissionRuntime, type OperatorMission } from "../core/operator-mission.js";
import { V010_RUNTIME_PROFILE } from "../core/runtime-profile.js";
import { isKnownReadOnlyTool } from "./gate.js";
import { currentMissionVision } from "../core/mission-vision.js";

type ObjectValue = Record<string, unknown>;
const record = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);
const active = (m: OperatorMission | undefined): m is OperatorMission => !!m && !["completed", "cancelled"].includes(m.phase);
const controllers = new Set(["dog-operator", "dogs-coordinator"]);
// The general gate classifier also accepts output/helper flags on read commands. Do not
// import those ambiguous variants into a user-requested pause. Native read/search stay usable.
const pausedShellReads = new Set(["pwd", "git status --short", "git status --short --branch"]);
const short = (text: string, limit: number) => Array.from(text).slice(0, limit).join("") + (Array.from(text).length > limit ? "…" : "");
const inlineGripQuestion = (question: string, japanese: boolean): string => {
  const decision = japanese ? "❓【今回の判断】" : "❓[Decision] ";
  const reason = japanese ? "💡【なぜ今】" : "💡[Why now] ";
  const relation = japanese ? "🔗【今回判断との関係・AI整理】" : "🔗[Relation to vision · AI interpretation] ";
  // Native Form descriptions collapse whitespace. Keep visible boundaries instead of
  // relying on blank lines; recognize only explicit headings, never infer or shorten conditions.
  const sections = question.split(/\r\n|[\r\n\u2028\u2029]/u).map(line => line.trim()).filter(Boolean);
  return sections.map((line, index) => {
    const formatted = line.replace(/^(?:今回の判断|判断|Decision|Current decision)\s*[:：]\s*/u, decision)
      .replace(/^(?:なぜ今[?？]?|理由|Why now[?？]?)\s*[:：]\s*/u, reason)
      .replace(/^(?:今回判断との関係|今回の判断との関係|Relation to vision)\s*[:：]\s*/u, relation);
    return index === 0 && ![decision, relation, reason].some(label => formatted.startsWith(label)) ? decision + formatted : formatted;
  }).join(" ┃ ") || decision;
};

/** Explicit native questions only: no semantic inference, outgoing traffic or process cancellation. */
export class MissionGripController {
  readonly missions: OperatorMissionRuntime;
  private readonly failedWrites = new Map<string, string>();
  private readonly recoveryErrors = new Map<string, { missionID: string; reason: string }>();
  constructor(directory: string, readonly getSession: (id: string) => Promise<unknown>,
    readonly history: (id: string) => Promise<unknown[]>) {
    this.missions = new OperatorMissionRuntime(directory, V010_RUNTIME_PROFILE);
  }
  private async owner(id: string): Promise<{ root: string; mission: OperatorMission } | undefined> {
    let current = id;
    for (let depth = 0; depth < 4; depth++) {
      const info = await this.getSession(current);
      if (!record(info) || !controllers.has(String(info.agent))) return;
      if (typeof info.parentID === "string") { current = info.parentID; continue; }
      const mission = await this.missions.read(current);
      if (active(mission) && (id === current || id === mission.coordinator)) return { root: current, mission };
      return;
    }
  }
  private applyAnswer(state: MissionGrip, offered: GripQuestion, answers: unknown): void {
    if (offered.closed || offered.answered !== undefined || !Array.isArray(answers) || answers.length !== 1 ||
        !Array.isArray(answers[0]) || answers[0].length !== 1 || typeof answers[0][0] !== "string") return;
    const answer = answers[0][0];
    offered.answered = answer;
    if (!offered.options.some(option => option.label === answer)) { offered.feedback = answer; return; }
    if (answer === offered.consultationLabel) {
      // An unrelated question cannot replace the held decision.
      if (state.pending?.callID === offered.callID && state.pending.sessionID === offered.sessionID || offered.header === state.pending?.resumeHeader) {
        state.pending.consultationRequested = true;
      }
    } else if (state.pending && (offered.header === state.pending.resumeHeader ||
        !state.pending.consultationRequested && offered.callID === state.pending.callID && offered.sessionID === state.pending.sessionID)) delete state.pending;
  }
  private async recover(root: string, mission: OperatorMission): Promise<OperatorMission> {
    try {
      const recovered = await this.recoverNativeAnswers(root, mission);
      this.recoveryErrors.delete(root);
      return recovered;
    } catch (error) {
      // A failed observation cannot erase the saved pause or disable its diagnosis/cancellation.
      this.recoveryErrors.set(root, { missionID: mission.id, reason: String(error).slice(0, 500) });
      return mission;
    }
  }
  private async recoverNativeAnswers(root: string, mission: OperatorMission): Promise<OperatorMission> {
    const unanswered = mission.grip?.questions.filter(q => q.answered === undefined && !q.closed) ?? [];
    if (!unanswered.length) return mission;
    const histories = new Map<string, unknown[]>();
    const results: { callID: string; sessionID: string; answers: unknown }[] = [];
    for (const q of unanswered) {
      if (!histories.has(q.sessionID)) histories.set(q.sessionID, await this.history(q.sessionID));
      for (const message of histories.get(q.sessionID)!) {
        if (!record(message) || !Array.isArray(message.parts)) continue;
        const part = message.parts.find(part => record(part) && part.tool === "question" && part.callID === q.callID);
        if (!record(part) || !record(part.state) || !["completed", "error"].includes(String(part.state.status))) continue;
        results.push({ callID: q.callID, sessionID: q.sessionID, answers: part.state.status === "completed" &&
          record(part.state.metadata) ? part.state.metadata.answers : undefined });
      }
    }
    if (!results.length) return mission;
    const updated = await this.missions.update(root, m => {
      if (m.id !== mission.id || !active(m) || !m.grip) return;
      for (const result of results) {
        const offered = m.grip.questions.find(q => q.callID === result.callID && q.sessionID === result.sessionID);
        if (offered) {
          this.applyAnswer(m.grip, offered, result.answers);
          if (offered.answered === undefined) offered.closed = true;
        }
      }
    });
    this.failedWrites.delete(root);
    return updated;
  }
  async pending(id: string): Promise<ObjectValue | undefined> {
    const owner = await this.owner(id);
    if (!owner) return;
    const mission = await this.recover(owner.root, owner.mission);
    const pending = mission.grip?.pending;
    if (!pending) return;
    const question = mission.grip!.questions.find(q => q.callID === pending.callID && q.sessionID === pending.sessionID);
    const feedback = mission.grip!.questions.filter(q => q.feedback !== undefined &&
      (q.callID === pending.callID || q.header === pending.resumeHeader)).at(-1)?.feedback;
    return { status: "needs-user-direction", decision_call_id: pending.callID, resume_header: pending.resumeHeader,
      ...(this.failedWrites.get(owner.root) === mission.id ? { save_failed: true } : {}),
      ...(this.recoveryErrors.get(owner.root)?.missionID === mission.id
        ? { recovery: { status: "unavailable", reason: this.recoveryErrors.get(owner.root)!.reason } } : {}),
      consultation_requested: pending.consultationRequested,
      ...(feedback !== undefined ? { user_feedback: feedback, feedback_received_direction_still_held: true } : {}),
      original_requests: mission.requests, undecided: question,
      vision: currentMissionVision(mission) ?? null,
      saved_observations: mission.execution?.observations ?? [],
      constraints: { declared_requirements: mission.requirements, prohibited_write: mission.prohibitedWrite ?? [] },
      external_delivery: "not-sent", next_action: pending.consultationRequested
        ? "Consult only the authorized recipient/scope, distinguish facts from proposals, then ask the corresponding revised Grip question. Advice is not permission. Do not dump this internal packet to the user."
        : "The user decision is still unanswered. Preserve received feedback and ask the corresponding revised Grip question. Dismissal/unknown output does not request external transmission or authorize a proposal." };
  }
  async before(event: ObjectValue): Promise<void> {
    const id = String(event.sessionID ?? ""), owner = await this.owner(id);
    if (!owner) return;
    // These owner operations must not depend on recovering the native question service.
    const cancellation = event.tool === "sortie_v010_cancel_operator" || event.tool === "sortie_v010_release_write_gate";
    if (cancellation) return;
    const mission = await this.recover(owner.root, owner.mission);
    const input = record(event.input) ? event.input : {};
    if (event.tool === "question" && typeof event.id === "string" && Array.isArray(input.questions) && input.questions.length === 1) {
      const q = input.questions[0];
      const header = record(q) ? q.header : undefined;
      if (record(q) && typeof header === "string" && (header === "Grip" || header === mission.grip?.pending?.resumeHeader) && q.multiple !== true &&
          typeof q.question === "string" && Array.isArray(q.options) && q.options.length > 0 &&
          q.options.every(option => record(option) && typeof option.label === "string" && typeof option.description === "string")) {
        const previous = mission.grip?.questions.find(item => item.callID === event.id && item.sessionID === id);
        // Follow the current question's language, not an earlier request's script.
        const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(q.question);
        const label = previous?.consultationLabel ?? (japanese ? "目的に戻って外部相談" : "Revisit goal with outside advice");
        const original = mission.requests[0];
        const excerpt = original ? short(original.text.split(/\r?\n/u).filter(Boolean)[0] ?? original.text, 90) : undefined;
        const oldQuote = excerpt === undefined ? "" : japanese
          ? `🎯【元の目的・原文抜粋】「${excerpt}」 ┃ ` : `🎯[Original goal excerpt] "${excerpt}" ┃ `;
        const vision = currentMissionVision(mission);
        const summary = vision?.summary.replace(/\s+/gu, " ").trim();
        const title = japanese ? `🎯【達成したい姿・AI整理${vision?.translated ? "／翻訳" : ""}】`
          : `🎯[Desired outcome · AI synthesis${vision?.translated ? " / translated" : ""}] `;
        const prefix = title + (summary ?? (japanese ? "未整理（根拠不足なら推測しない）" : "Not established (do not infer missing context)")) + " ┃ ";
        const rawQuestion = q.question, formattedQuestion = prefix + inlineGripQuestion(rawQuestion, japanese);
        const oldFormattedQuestion = oldQuote + inlineGripQuestion(rawQuestion, japanese);
        // Retry compatibility only: never rewrite an already saved/open native offer.
        const legacyQuote = excerpt === undefined ? "" : `${japanese ? "元の目的（原文抜粋）: " : "Original goal (excerpt): "}${excerpt}\n\n`;
        const legacyFormattedQuestion = legacyQuote + rawQuestion.replace(/\r?\n+/gu, "\n\n");
        const options = q.options.filter(option => option.label !== label) as GripQuestion["options"];
        let offered: GripQuestion = previous ?? { callID: event.id, sessionID: id, header: String(header),
          question: formattedQuestion, inputQuestion: rawQuestion, ...(vision ? { vision } : {}), consultationLabel: label,
          options: [...options, { label, description: japanese ? "この方針を保留し、元の目的から考え直す" : "Hold this direction and reconsider the original goal" }] };
        await this.missions.update(owner.root, m => {
          if (m.id !== mission.id || !active(m)) throw new Error("mission-grip-owner-changed: preserve the successor Mission; discard this stale question and use its current user direction");
          m.grip ??= { questions: [] };
          if (m.grip.pending && header !== m.grip.pending.resumeHeader &&
              (event.id !== m.grip.pending.callID || id !== m.grip.pending.sessionID)) {
            throw new Error(`mission-grip-question-already-pending: use ${m.grip.pending.resumeHeader} for the held direction; ordinary input questions remain unchanged`);
          }
          const open = m.grip.questions.find(q => q.answered === undefined && !q.closed);
          if (open && (open.callID !== event.id || open.sessionID !== id)) {
            throw new Error("mission-grip-question-already-pending: complete or dismiss the open Grip form, or recover its native terminal, before opening a competing revision; cancellation remains available");
          }
          const current = m.grip.questions.find(q => q.callID === event.id && q.sessionID === id);
          if (current) {
            if (current.header !== header || rawQuestion !== current.question && rawQuestion !== current.inputQuestion &&
                formattedQuestion !== current.question && oldFormattedQuestion !== current.question && legacyFormattedQuestion !== current.question ||
                JSON.stringify(options) !== JSON.stringify(current.options.filter(option => option.label !== current.consultationLabel))) {
              throw new Error("mission-grip-question-call-reused: use a fresh native question call for the revised choice; the old form is not substituted");
            }
            offered = current;
          }
          if (!m.grip.questions.some(q => q.callID === offered.callID && q.sessionID === offered.sessionID)) {
            // Keep the held decision and current offer across bounded history retention.
            m.grip.questions = m.grip.questions.filter(q => q.callID === m.grip!.pending?.callID || q.answered === undefined && !q.closed ||
              m.grip!.questions.indexOf(q) >= m.grip!.questions.length - 8);
            m.grip.questions.push(offered);
          }
          if (offered.answered === undefined && !offered.closed) m.grip.pending ??= { callID: offered.callID, sessionID: offered.sessionID, consultationRequested: false,
            resumeHeader: `Grip:${createHash("sha256").update(`${id}:${offered.callID}`).digest("hex").slice(0, 12)}` };
        });
        input.questions = [{ ...q, question: offered.question, options: offered.options }];
        event.input = input;
      }
    }
    const pending = mission.grip?.pending;
    const shell = ["shell", "bash", "powershell", "pwsh"].includes(String(event.tool));
    const safeShell = shell && typeof input.command === "string" && pausedShellReads.has(input.command.trim()) &&
      isKnownReadOnlyTool("bash", input);
    const changesDirection = typeof event.tool === "string" && (
      /^(?:sortie_v010_(?:start_mission|plan_units|start_direct_unit|expand_unit|operator_next|complete_mission|complete_operator|submit_mission|review_mission|retry_mission_unit|rescue_mission_unit|repair_review)|edit|write|patch|apply_patch)$/u.test(event.tool) ||
      event.tool === "subagent" && !["dog-advisor-v010", "dog-scout-v010"].includes(String(input.agent)) || shell && !safeShell);
    if (changesDirection && (pending || this.failedWrites.get(owner.root) === mission.id)) {
      throw new Error(`mission-grip-needs-user-direction: use ${pending?.resumeHeader ?? "the retained Grip decision"}; read/status/consultation/cancel and existing Worker settlement remain available`);
    }
  }
  async after(event: ObjectValue): Promise<ObjectValue | undefined> {
    if (event.tool !== "question" || !["completed", "error", "cancelled"].includes(String(event.status))) return;
    const owner = await this.owner(String(event.sessionID ?? ""));
    if (!owner) return;
    const q = owner.mission.grip?.questions.find(q => q.callID === event.id && q.sessionID === event.sessionID);
    if (!q) return;
    let applied = false;
    try {
      await this.missions.update(owner.root, m => {
        if (m.id !== owner.mission.id || !active(m)) return;
        applied = true;
        const offered = m.grip?.questions.find(q => q.callID === event.id && q.sessionID === event.sessionID);
        if (offered && m.grip) {
          const metadata = record(event.result) && record(event.result.metadata) ? event.result.metadata : {};
          this.applyAnswer(m.grip, offered, event.status === "completed" ? metadata.answers : undefined);
          if (offered.answered === undefined) offered.closed = true;
        }
      });
      this.failedWrites.delete(owner.root);
    } catch (error) { this.failedWrites.set(owner.root, owner.mission.id); throw error; }
    if (!applied) return;
    return this.pending(String(event.sessionID));
  }
}
