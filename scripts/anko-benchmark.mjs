import { diagnoseVersion } from './anko-benchmark/diagnostic-owned.mjs';
import { parseCommand } from './anko-benchmark/core.mjs';
import { prepareCommand, showProfile } from './anko-benchmark/prepare.mjs';
import { runVersion } from './anko-benchmark/run.mjs';
import { verifyVersion } from './anko-benchmark/verify.mjs';
import { inspectVersion } from './anko-benchmark/inspect.mjs';

async function main(argv) {
  const { command, version, packagePath } = parseCommand(argv);
  switch (command) {
    case 'prepare': return prepareCommand(version, packagePath);
    case 'profile': return showProfile();
    case 'diagnose': return diagnoseVersion(version);
    case 'inspect': return inspectVersion(version);
    case 'verify': return verifyVersion(version);
    case 'run': return runVersion(version);
    default: throw new Error(`Unsupported command: ${command}`);
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
