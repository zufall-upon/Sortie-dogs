/** A retained user decision inside the existing Mission, not execution authority. */
export interface GripQuestion {
  callID: string;
  sessionID: string;
  header: string;
  question: string;
  /** Exact producer input and display source fixed with this offer, not recomputed on retry. */
  inputQuestion?: string;
  vision?: import("./mission-vision.js").MissionVision;
  options: { label: string; description: string }[];
  consultationLabel: string;
  answered?: string;
  /** Retained steering text, never implicit permission to resume a held choice. */
  feedback?: string;
  /** Native terminal without a usable answer; preserve the hold without rereading history forever. */
  closed?: boolean;
}
export interface MissionGrip {
  questions: GripQuestion[];
  pending?: { callID: string; sessionID: string; resumeHeader: string; consultationRequested: boolean };
}

export const GRIP_POLICY = `## Grip: user-controlled direction, not more approvals
Do not create questions for routine implementation, checks or repair. At an already necessary user-only
choice about purpose, UX, implementation approach, safety policy or priorities, use one single-choice
native question with header="Grip". Do not use Grip for input paths, missing facts or native permissions.
The V2 Mission host adds the retained Mission vision (labelled AI synthesis) and a permanent external-consultation option;
never omit that escape because you believe your proposal is aligned. Unmarked questions are not inferred.
Native Form descriptions collapse newlines and blank lines. Use visible icons + text labels + the separator
" ┃ ", not layout-dependent whitespace: "❓【今回の判断】何を決める？ ┃ 💡【なぜ今】今決める理由。"
(English: "❓[Decision] What is being decided? ┃ 💡[Why now] Why decide now?"). The host prepends
"🎯【達成したい姿・AI整理】" / "🎯[Desired outcome · AI synthesis]" from the saved vision; do not write that block yourself.
In the same ordinary start_mission/plan_units turn, supply vision:{summary,source_refs,translated?} from
retained current-Mission sources. Operator supplies it at start; Coordinator fills/refines it at planning
when absent/stale. Describe the desired outcome, not the current method or a copied user fragment.
Do not add an LLM turn, mandatory migration or confirmation gate. If evidence is insufficient/conflicting,
omit vision and say what is unknown; the host displays not established, never guesses from the first line.
Start the question with "今回判断との関係：…" / "Relation to vision: …" explaining how this choice serves
that outcome (or that the relationship is unknown), then Decision/Why now. This relationship is AI interpretation,
not a user quote. Use the user's current language; mark translated:true when the summary translates sources.
Use one short sentence for the decision and one for the reason. Aim for 200–300 Japanese characters across
the initial question and options, not a long justification. Keep the concrete target, actions, exclusions and
material cost/retention conditions in the decision or option descriptions; never hide them to meet that target.
Put detailed background/evidence in ordinary chat before the Form, not another question. Do not truncate
authorization conditions or add icons to existing option labels. Keep normal option labels unchanged,
recommendation first when justified; each description states its concrete tradeoff.
The original purpose comes from retained user sources; the display summary is explicitly AI synthesis. Keep
full sources available. Never present inferred purpose or a model-written requirement as a user quote.
If the user selects external consultation, hold the dependent direction. Do not implement the old options,
kill active Workers, reset spend, or treat advice as permission. Use only an already authorized recipient
and disclosure scope; otherwise provide a consultation handoff and say it has NOT been sent. Separate
original requests, observations, unresolved choices and constraints; label the parent's proposals as proposals.
Do not dump the internal handoff into the user-facing question. Summarize consultation in four short items:
misalignment, recommendation, reason, changed direction (normally 200–300 Japanese characters; details on request).
After consultation, use the exact resume_header from retained Grip state for the corresponding revised
single-choice question. Only a fresh native answer choosing a listed normal option resolves that hold;
unrelated questions, free text, dismissal, chat, old answers and external advice cannot silently resume it.
Keep cancellation, status, reads, consultation, existing Worker settlement and cleanup reachable. Resume
ordinary work from the user's chosen direction without repeating successful checks. No new GUI, role,
external connector or separate approval ritual is implied. This first version is V2 active-Mission only.`;
