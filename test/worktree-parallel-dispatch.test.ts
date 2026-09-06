import nodeTest, { describe } from "node:test";

import { worktreeDispatchCases } from "./integration/worktree-parallel-dispatch.test.ts?normal";

describe("worktree dispatch", { concurrency: 3 }, () => {
  for (const candidate of worktreeDispatchCases("normal")) {
    nodeTest(candidate.name, candidate.options ?? {}, candidate.run);
  }
});
