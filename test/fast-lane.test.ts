import assert from "node:assert/strict";
import test from "node:test";

import { FastLaneController, FastLaneDeniedError } from "../dist/plugin/fast-lane.js";

const worker = { subagent_type: "dog-worker", prompt: "role: implementation" };

function expectDenial(action: () => void, code: FastLaneDeniedError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof FastLaneDeniedError);
    assert.equal(error.code, code);
    return true;
  });
}

test("normal turns permit one worker and reset only on a real turn", () => {
  const lane = new FastLaneController();
  expectDenial(() => lane.beforeTool("root", "task", worker), "TURN_STATE_REQUIRED");
  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", worker);
  expectDenial(() => lane.beforeTool("root", "task", worker), "WORKER_LIMIT");

  lane.beginTurn("root", true);
  expectDenial(() => lane.beforeTool("root", "task", worker), "WORKER_LIMIT");

  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", worker);
});

test("scout requires one concrete pre-worker evidence gap", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  expectDenial(
    () => lane.beforeTool("root", "task", { subagent_type: "dog-scout", prompt: "inspect" }),
    "SCOUT_GAP_REQUIRED",
  );
  lane.beforeTool("root", "task", {
    subagent_type: "dog-scout",
    prompt: "missing_evidence_code: validation",
  });
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-scout",
      prompt: "missing_evidence_code: manifest",
    }),
    "SCOUT_LIMIT",
  );
  lane.beforeTool("root", "task", worker);
  assert.equal(lane.manualCompactionForbidden("root"), true);
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-scout",
      prompt: "missing_evidence_code: owner-risk",
    }),
    "SCOUT_TOO_LATE",
  );
});

test("review dispatch requires canonical PASS and recognized risk tags", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  const review = {
    subagent_type: "dog-reviewer",
    prompt: "review_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [write-gate, concurrency]",
  };
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-reviewer",
      prompt: "review_phase: initial\ncanonical_validation_exit: 1\nrisk_tags: [write-gate]",
    }),
    "REVIEW_EVIDENCE_REQUIRED",
  );
  lane.beforeTool("root", "task", review);
  expectDenial(() => lane.beforeTool("root", "task", review), "CONSULTATION_RETRY_INVALID");
  lane.beforeTool("root", "task", {
    ...review,
    prompt: `${review.prompt}\nfallback_retry: true`,
  }, { consultationFallbackAuthorized: true });
  const verification = {
    subagent_type: "dog-reviewer",
    prompt: "review_phase: verification\ncanonical_validation_exit: 0\nrisk_tags: [write-gate, concurrency]",
  };
  lane.beforeTool("root", "task", verification);
  expectDenial(
    () => lane.beforeTool("root", "task", {
      ...review,
      prompt: `${review.prompt}\nfallback_retry: true`,
    }),
    "REVIEW_PHASE_INVALID",
  );
  expectDenial(() => lane.beforeTool("root", "task", verification), "CONSULTATION_RETRY_INVALID");
  lane.beforeTool("root", "task", {
    ...verification,
    prompt: `${verification.prompt}\nfallback_retry: true`,
  }, { consultationFallbackAuthorized: true });
  expectDenial(
    () => lane.beforeTool("root", "task", {
      ...verification,
      prompt: `${verification.prompt}\nfallback_retry: true`,
    }),
    "REVIEW_LIMIT",
  );
});

test("review dispatch accepts public API privacy and transaction risks", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: "review_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [public-api, privacy, transaction]",
  });
});

test("typed evidence fields reject duplicates, case changes, and unbracketed risks", () => {
  const invalidPrompts = [
    "missing_evidence_code: manifest\nmissing_evidence_code: validation",
    "Missing_Evidence_Code: manifest",
  ];
  for (const [index, prompt] of invalidPrompts.entries()) {
    const lane = new FastLaneController();
    lane.beginTurn(`scout-${index}`, false);
    expectDenial(
      () => lane.beforeTool(`scout-${index}`, "task", { subagent_type: "dog-scout", prompt }),
      "SCOUT_GAP_REQUIRED",
    );
  }

  for (const [index, riskLine] of [
    "risk_tags: write-gate",
    "risk_tags: [write-gate, write-gate]",
    "risk_tags: [write-gate,]",
  ].entries()) {
    const lane = new FastLaneController();
    lane.beginTurn(`review-${index}`, false);
    expectDenial(
      () => lane.beforeTool(`review-${index}`, "task", {
        subagent_type: "dog-reviewer",
        prompt: `review_phase: initial\ncanonical_validation_exit: 0\n${riskLine}`,
      }),
      "REVIEW_EVIDENCE_REQUIRED",
    );
  }
});

test("advisor requires a strategy trigger and manual worker compaction is denied", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  expectDenial(
    () => lane.beforeTool("root", "sortie_compact_and_continue", {}),
    "MANUAL_COMPACTION_FORBIDDEN",
  );
  expectDenial(
    () => lane.beforeTool("root", "task", { subagent_type: "dog-advisor", prompt: "question" }),
    "ADVISOR_TRIGGER_REQUIRED",
  );
  lane.beforeTool("root", "task", {
    subagent_type: "dog-advisor",
    prompt: "strategy_trigger: architecture-choice",
  });
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-advisor",
      prompt: "strategy_trigger: material-uncertainty",
    }),
    "CONSULTATION_RETRY_INVALID",
  );
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-advisor",
      prompt: "strategy_trigger: architecture-choice\nfallback_retry: true",
    }),
    "CONSULTATION_RETRY_UNAUTHORIZED",
  );
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-advisor",
      prompt: "strategy_trigger: material-uncertainty\nfallback_retry: true",
    }, { consultationFallbackAuthorized: true }),
    "CONSULTATION_RETRY_MISMATCH",
  );
  lane.beforeTool("root", "task", {
    subagent_type: "dog-advisor",
    prompt: "strategy_trigger: architecture-choice\nfallback_retry: true",
  }, { consultationFallbackAuthorized: true });
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-advisor",
      prompt: "strategy_trigger: architecture-choice\nfallback_retry: true",
    }),
    "ADVISOR_LIMIT",
  );
  lane.beforeTool("root", "task", worker);
  expectDenial(
    () => lane.beforeTool("root", "sortie_compact_and_continue", {}),
    "MANUAL_COMPACTION_FORBIDDEN",
  );
  expectDenial(
    () => lane.beforeTool("root", "compact_and_continue", {}),
    "MANUAL_COMPACTION_FORBIDDEN",
  );
  lane.beforeTool("root", "read", {});
  lane.forget("root");
  assert.equal(lane.manualCompactionForbidden("root"), false);
  expectDenial(() => lane.beforeTool("root", "task", worker), "TURN_STATE_REQUIRED");
});

test("a cold synthetic resume is fail-closed until a real turn", () => {
  const lane = new FastLaneController();
  lane.beginTurn("cold", true);
  expectDenial(() => lane.beforeTool("cold", "task", worker), "WORKER_LIMIT");
  expectDenial(
    () => lane.beforeTool("cold", "sortie_compact_and_continue", {}),
    "MANUAL_COMPACTION_FORBIDDEN",
  );
  lane.beginTurn("cold", false);
  lane.beforeTool("cold", "task", worker);
});

test("explicit backlog drain permits one worker per synthetic unit up to its bound", () => {
  const lane = new FastLaneController();
  lane.beginTurn("drain", false);
  expectDenial(() => lane.enableBacklogDrain("drain", 3), "BACKLOG_DRAIN_INVALID");
  lane.enableBacklogDrain("drain", 4);
  expectDenial(() => lane.enableBacklogDrain("drain", 4), "BACKLOG_DRAIN_TOO_LATE");
  expectDenial(
    () => lane.beforeTool("drain", "sortie_compact_and_continue", {}),
    "MANUAL_COMPACTION_FORBIDDEN",
  );
  const advisor = { subagent_type: "dog-advisor", prompt: "strategy_trigger: architecture-choice" };
  const scout = { subagent_type: "dog-scout", prompt: "missing_evidence_code: manifest" };
  const review = {
    subagent_type: "dog-reviewer",
    prompt: "review_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [write-gate]",
  };

  for (let unit = 0; unit < 4; unit += 1) {
    lane.beforeTool("drain", "task", advisor);
    lane.beforeTool("drain", "task", scout);
    lane.beforeTool("drain", "task", worker);
    lane.beforeTool("drain", "task", review);
    if (unit < 3) {
      lane.beforeTool("drain", "sortie_compact_and_continue", {});
      lane.continuationQueued("drain");
      expectDenial(
        () => lane.beforeTool("drain", "sortie_compact_and_continue", {}),
        "MANUAL_COMPACTION_FORBIDDEN",
      );
      lane.beginTurn("drain", true);
    }
  }
  expectDenial(
    () => lane.beforeTool("drain", "sortie_compact_and_continue", {}),
    "MANUAL_COMPACTION_FORBIDDEN",
  );
  expectDenial(() => lane.beforeTool("drain", "task", worker), "WORKER_LIMIT");
});

test("unknown and missing Task roles are denied", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  expectDenial(
    () => lane.beforeTool("root", "task", { subagent_type: "build", prompt: "work" }),
    "ROLE_FORBIDDEN",
  );
  expectDenial(() => lane.beforeTool("root", "task", { prompt: "work" }), "ROLE_FORBIDDEN");
});
