/** Research-only falsification of the replay's reference-retention oracle.
 * Setup from root: npm ci
 * Run: node --import tsx docs/research/experiments/context-oracle-falsification.ts
 * Uses synthetic replay providers and temporary repositories; no real inference.
 * The negated-prose case intentionally PASSING shows the oracle is not semantic.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const sourceSha256 = Object.fromEntries(['package-lock.json', 'main/services/pi-upgrade-replay-runner.ts', 'main/services/pi-upgrade-evaluation.ts', 'docs/research/experiments/context-oracle-falsification.ts'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const observations = [];
import { runPiUpgradeReplayCases } from '../../../main/services/pi-upgrade-replay-runner.js';
for (const [name, transformSummary] of [
  ['drop-all-historical-decisions', (text:string) => text.replace(/HISTORY-[a-z_]+/gu, '[decision lost]')],
  ['contradict-markers-but-retain-spelling', (text:string) => text.replace('## Key Decisions\n- ', '## Key Decisions\n- Reject these identifiers and do not preserve their associated decisions: ')],
] as const) {
 const rows=await runPiUpgradeReplayCases({transformSummary});
 if (name === 'drop-all-historical-decisions') {
   assert.equal(rows.filter(row => !row.continuationCorrect).length, 6);
   assert.ok(rows.filter(row => row.caseId !== 'attachment_heavy_first_prompt').every(row => row.pendingReferencesExpected - row.pendingReferencesRetained === 1));
 } else assert.ok(rows.every(row => row.continuationCorrect), 'this control demonstrates that marker retention does not validate decision meaning');
 observations.push({name, rows:rows.map(({caseId,continuationCorrect,pendingReferencesExpected,pendingReferencesRetained})=>({caseId,continuationCorrect,pendingReferencesExpected,pendingReferencesRetained}))});
}

console.log(JSON.stringify({ evidenceKind: 'offline-reference-oracle-falsification', generatedAt: new Date().toISOString(), node: process.version, sourceSha256, observations, limitations: 'Known negation passing is an oracle limitation; not evidence of model comprehension. No live model calls or billing.' }, null, 2));
