/** A retained user decision inside the existing Mission, not execution authority. */
export interface GripQuestion {
  callID: string;
  sessionID: string;
  header: string;
  question: string;
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
The V2 Mission host adds a short original-request excerpt and a permanent external-consultation option;
never omit that escape because you believe your proposal is aligned. Unmarked questions are not inferred.
Write only the current decision and why it is necessary now (normally two short lines). Aim for 200–300
Japanese characters across the initial question and options, not a long justification. Keep normal option
labels unchanged, recommendation first when justified; each description states its concrete tradeoff.
The original purpose comes from retained user text, not your rewritten summary. Label excerpts and keep
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
