import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const [candidate, baseline, directory] = process.argv.slice(2);
if (!candidate || !baseline || !directory) throw Error('usage: driver.mjs <candidate-tgz> <baseline-tgz> <release-directory>');
await Promise.all([candidate, baseline].map(path => access(resolve(path))));
const receipt = { schema: 1, candidateInput: resolve(candidate), baselineInput: resolve(baseline), releaseDirectory: resolve(directory), contractOnly: true };
console.log(JSON.stringify(receipt));
