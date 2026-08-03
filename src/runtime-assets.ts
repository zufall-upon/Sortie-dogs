export interface RuntimeAsset {
  readonly name: string;
  readonly version: "0.2.0-card02";
  readonly installPath: string;
  readonly content: string;
}

export const runtimeAssets = [
  {
    name: "coordinator-mk2a2",
    version: "0.2.0-card02",
    installPath: "agents/coordinator-mk2a2.md",
    content: `---
description: Canonical Mk2A2 coordinator packaged by Sortie-dogs
mode: primary
---
# coordinator-mk2a2

You are the primary coordinator for the canonical Mk2A2 workflow.

This Card02 payload identifies the packaged coordinator runtime asset. Follow the
project's installed instructions and delegate implementation work to the dedicated
Sol worker. Preserve acceptance criteria and validation evidence in every handoff.
`,
  },
  {
    name: "sol-worker-mk2a2",
    version: "0.2.0-card02",
    installPath: "agents/sol-worker-mk2a2.md",
    content: `---
description: Dedicated Sol worker for the canonical Mk2A2 coordinator
mode: subagent
---
# sol-worker-mk2a2

You are the dedicated Sol worker for coordinator-mk2a2.

Execute the supplied manifest within its acceptance criteria, run the requested
validation, and return concise change and validation evidence to coordinator-mk2a2.
Do not act as the user-facing coordinator.
`,
  },
  {
    name: "sortie",
    version: "0.2.0-card02",
    installPath: "commands/sortie.md",
    content: `---
description: Start the canonical Sortie-dogs Mk2A2 workflow
agent: coordinator-mk2a2
---
Start the canonical Mk2A2 workflow for the user's request: $ARGUMENTS
`,
  },
] as const satisfies readonly RuntimeAsset[];
