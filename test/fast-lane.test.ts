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

test("normal turns permit autonomous sequential workers across synthetic continuation", () => {
  const lane = new FastLaneController();
  expectDenial(() => lane.beforeTool("root", "task", worker), "TURN_STATE_REQUIRED");
  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", worker);
  expectDenial(() => lane.beforeTool("root", "task", worker), "WORKER_LIMIT");
  lane.workerCompleted("root");
  lane.beforeTool("root", "task", worker);

  lane.beginTurn("root", true);
  expectDenial(() => lane.beforeTool("root", "task", worker), "WORKER_LIMIT");
  lane.workerCompleted("root");
  lane.beforeTool("root", "task", worker);

  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", worker);
});

test("only a typed parallel authorization raises the worker bound to three", () => {
  const lane = new FastLaneController();
  lane.beginTurn("parallel", false);
  lane.enableParallelDispatch("parallel", 3, 0, 0, 3);
  lane.beforeTool("parallel", "task", worker, { parallelWorkerAuthorized: true });
  expectDenial(() => lane.beforeTool("parallel", "task", worker), "WORKER_LIMIT");
  lane.beforeTool("parallel", "task", worker, { parallelWorkerAuthorized: true });
  lane.beforeTool("parallel", "task", worker, { parallelWorkerAuthorized: true });
  expectDenial(
    () => lane.beforeTool("parallel", "task", worker, { parallelWorkerAuthorized: true }),
    "WORKER_LIMIT",
  );
});

test("a typed already-bound parallel call is not counted twice", () => {
  const lane = new FastLaneController();
  lane.beginTurn("parallel", false);
  lane.enableParallelDispatch("parallel", 2, 2, 2, 2);
  lane.beforeTool("parallel", "task", worker, {
    parallelWorkerAuthorized: true,
    parallelWorkerAlreadyBound: true,
  });
  lane.beforeTool("parallel", "task", worker, {
    parallelWorkerAuthorized: true,
    parallelWorkerAlreadyBound: true,
  });
  expectDenial(
    () => lane.beforeTool("parallel", "task", worker, { parallelWorkerAuthorized: true }),
    "WORKER_LIMIT",
  );
  expectDenial(
    () => lane.beforeTool("parallel", "task", worker, { parallelWorkerAlreadyBound: true }),
    "WORKER_LIMIT",
  );
});

test("one exact handoff-uninspected result permits one same-task worker resume", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", {
    subagent_type: "dog-worker",
    prompt: "task_id: task-a\nrole: implementation",
  });
  assert.equal(lane.authorizeRecoverableWorkerResume("root", "task-a", "child-a"), true);
  lane.beforeTool("root", "task", {
    subagent_type: "dog-worker",
    task_id: "child-a",
    prompt: "task_id: task-a\nmode: same-task-resume\nrole: implementation",
  });
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-worker",
      prompt: "task_id: task-a\nmode: same-task-resume\nrole: implementation",
    }),
    "WORKER_RESUME_INVALID",
  );
});

test("worker resume stays scoped to the original task and one use", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", { subagent_type: "dog-worker", prompt: "task_id: task-a" });
  assert.equal(lane.authorizeRecoverableWorkerResume("root", "task-a", "child-a"), true);
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-worker",
      prompt: "task_id: task-b\nmode: same-task-resume",
    }),
    "WORKER_RESUME_INVALID",
  );
});

test("worker resume rejects a different child with the same task identity", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", { subagent_type: "dog-worker", prompt: "task_id: task-a" });
  assert.equal(lane.authorizeRecoverableWorkerResume("root", "task-a", "child-a"), true);
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-worker",
      task_id: "child-b",
      prompt: "task_id: task-a\nmode: same-task-resume",
    }),
    "WORKER_RESUME_INVALID",
  );
});

test("scout requires a concrete gap and remains available after earlier scouts and workers", () => {
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
  lane.beforeTool("root", "task", {
    subagent_type: "dog-scout",
    prompt: "missing_evidence_code: manifest",
  });
  lane.beforeTool("root", "task", worker);
  assert.equal(lane.manualCompactionForbidden("root"), true);
  lane.beforeTool("root", "task", {
    subagent_type: "dog-scout",
    prompt: "missing_evidence_code: owner-risk",
  });
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

test("distinct review candidates have independent phases and retry budgets", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: "candidate_id: candidate-a\nreview_phase: final\ncanonical_validation_exit: 0\nrisk_tags: [time, timezone, public-logic]",
  });
  const candidateB = {
    subagent_type: "dog-reviewer",
    prompt: "candidate_id: candidate-b\nreview_phase: initial\ncanonical_validation_exit: 0\nrisk_tags: [storage-compatibility]",
  };
  lane.beforeTool("root", "task", candidateB);
  expectDenial(() => lane.beforeTool("root", "task", candidateB), "CONSULTATION_RETRY_INVALID");
});

test("materially revised verification artifacts continue while exact duplicates are denied", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  const evidence = "canonical_validation_exit: 0\nrisk_tags: [public-logic]\ncandidate_id: corrected";
  lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: `review_phase: final\n${evidence}`,
  });
  expectDenial(() => lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: `review_phase: initial\n${evidence}\nartifact_revision: alternate-initial`,
  }), "REVIEW_PHASE_INVALID");
  lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: `review_phase: verification\n${evidence}\nartifact_revision: r1`,
  });
  lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: `review_phase: verification\n${evidence}\nartifact_revision: r2`,
  });
  expectDenial(() => lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: `review_phase: verification\n${evidence}\nartifact_revision: r2`,
  }), "CONSULTATION_RETRY_INVALID");
  for (let revision = 3; revision <= 35; revision += 1) {
    lane.beforeTool("root", "task", {
      subagent_type: "dog-reviewer",
      prompt: `review_phase: verification\n${evidence}\nartifact_revision: r${revision}`,
    });
  }
  expectDenial(() => lane.beforeTool("root", "task", {
    subagent_type: "dog-reviewer",
    prompt: `review_phase: verification\n${evidence}\nartifact_revision: r1`,
  }), "CONSULTATION_RETRY_INVALID");
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

test("advisor requires a strategy trigger while plugin-owned compaction bypasses fast-lane", () => {
  const lane = new FastLaneController();
  lane.beginTurn("root", false);
  assert.equal(lane.manualCompactionForbidden("root"), true);
  assert.equal(lane.terminalInstructionRequired("root"), false);
  lane.beforeTool("root", "sortie_compact_and_continue", {});
  expectDenial(
    () => lane.beforeTool("root", "task", { subagent_type: "dog-advisor", prompt: "question" }),
    "ADVISOR_TRIGGER_REQUIRED",
  );
  lane.beforeTool("root", "task", {
    subagent_type: "dog-advisor",
    prompt: "strategy_trigger: architecture-choice",
  });
  assert.equal(lane.terminalInstructionRequired("root"), true);
  lane.beforeTool("root", "task", {
    subagent_type: "dog-advisor",
    prompt: "strategy_trigger: material-uncertainty",
  });
  expectDenial(
    () => lane.beforeTool("root", "task", {
      subagent_type: "dog-advisor",
      prompt: "strategy_trigger: architecture-choice\nfallback_retry: true",
    }),
    "CONSULTATION_RETRY_UNAUTHORIZED",
  );
  lane.beforeTool("root", "task", {
    subagent_type: "dog-advisor",
    prompt: "strategy_trigger: material-uncertainty\nfallback_retry: true",
  }, { consultationFallbackAuthorized: true });
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
  lane.beforeTool("root", "sortie_compact_and_continue", {});
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
  expectDenial(() => lane.beforeTool("cold", "task", worker), "TURN_STATE_REQUIRED");
  lane.beforeTool("cold", "sortie_compact_and_continue", {});
  lane.beginTurn("cold", false);
  lane.beforeTool("cold", "task", worker);
});

test("explicit backlog drain does not treat serial worker attempts as queue-unit capacity", () => {
  const wider = new FastLaneController();
  wider.beginTurn("wider", false);
  wider.enableBacklogDrain("wider", 12);

  const lane = new FastLaneController();
  lane.beginTurn("drain", false);
  expectDenial(() => lane.enableBacklogDrain("drain", 0), "BACKLOG_DRAIN_INVALID");
  lane.enableBacklogDrain("drain", 4);
  expectDenial(() => lane.enableBacklogDrain("drain", 4), "BACKLOG_DRAIN_TOO_LATE");
  lane.beforeTool("drain", "sortie_compact_and_continue", {});
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
    lane.workerCompleted("drain");
    lane.beforeTool("drain", "task", review);
    if (unit < 3) {
      lane.beforeTool("drain", "sortie_compact_and_continue", {});
      lane.continuationQueued("drain");
      lane.beginTurn("drain", true);
    }
  }
  lane.beforeTool("drain", "task", worker);
  expectDenial(() => lane.beforeTool("drain", "task", worker), "WORKER_LIMIT");
  lane.workerCompleted("drain");
  lane.beforeTool("drain", "sortie_compact_and_continue", {});
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
