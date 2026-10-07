import { parseCommand } from './anko-benchmark/core.mjs';

async function main(argv) {
  const { command, version, packagePath, attempt = null } = parseCommand(argv);
  switch (command) {
    case 'prepare': return (await import('./anko-benchmark/prepare.mjs')).prepareCommand(version, packagePath);
    case 'profile': return (await import('./anko-benchmark/prepare.mjs')).showProfile();
    case 'diagnose': return (await import('./anko-benchmark/diagnostic-owned.mjs')).diagnoseVersion(version);
    case 'inspect': return (await import('./anko-benchmark/inspect.mjs')).inspectVersion(version, { attempt });
    case 'verify': return (await import('./anko-benchmark/verify.mjs')).verifyVersion(version, { attempt });
    case 'run': return (await import('./anko-benchmark/run.mjs')).runVersion(version, { attempt });
    default: throw new Error(`Unsupported command: ${command}`);
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
