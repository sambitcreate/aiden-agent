/**
 * Research-only conservative trace classifier. Run from repository root after
 * npm ci: ./node_modules/.bin/tsx docs/research/experiments/pi-tool-loop-trace.ts
 * No inference/network/effects. Synthetic fixtures contain no private data.
 * Existing safe events cannot distinguish validation/authorization or prove
 * polling/change scope; explicit evidence below models future host instrumentation.
 */
import assert from 'node:assert/strict';
import { runToolCall, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { projectPiRuntimeAgentEvent, type PiRuntimeAgentEvent } from '../../../main/services/pi-runtime-events.js';
import type { DurablePiRuntimeEffectState } from '../../../main/services/pi-runtime-effect-core.js';

type End = Extract<PiRuntimeAgentEvent, { type: 'tool_execution_end' }>;
type Trace = {
  runId: string; event: End;
  effect?: { runId: string; toolCallId: string; state: DurablePiRuntimeEffectState };
  // These fields are hypothetical host-local evidence, NOT existing safe events.
  evidence?: {
    rejection?: 'validation' | 'authorization';
    opaqueAttemptKey?: string; authorityEpoch?: number; userEpoch?: number;
    successfulObservation?: 'poll' | 'verification';
    verifiedChangedSincePreviousCheck?: boolean;
  };
};
function classify(row: Trace): string {
  const effect = row.effect?.runId === row.runId && row.effect.toolCallId === row.event.toolCallId ? row.effect : undefined;
  if (effect && ['unknown', 'interrupted', 'dispatch_started', 'prepared'].includes(effect.state)) return 'unsettled_or_unknown_effect';
  if (effect?.state === 'cancelled_before_dispatch') return 'cancelled_before_dispatch';
  if (effect?.state === 'remote_error') return 'settled_tool_failure';
  if (row.event.isError) {
    if (effect?.state === 'completed') return 'conflicting_outcome_evidence';
    return row.evidence?.rejection ? `pre_dispatch_${row.evidence.rejection}` : 'unclassified_tool_error';
  }
  if (row.evidence?.successfulObservation === 'poll') return 'successful_poll';
  if (row.evidence?.successfulObservation === 'verification') return row.evidence.verifiedChangedSincePreviousCheck ? 'verification_after_change' : 'verification_need_unknown';
  return 'successful_tool_result';
}
function repeatedRejectionCandidate(a: Trace, b: Trace): boolean {
  const kind = classify(a), evidence = a.evidence, next = b.evidence;
  return (kind === 'pre_dispatch_validation' || kind === 'pre_dispatch_authorization') && classify(b) === kind &&
    a.runId === b.runId && a.event.toolCallId !== b.event.toolCallId && a.event.toolName === b.event.toolName && !!evidence?.opaqueAttemptKey &&
    evidence.opaqueAttemptKey === next?.opaqueAttemptKey && evidence.authorityEpoch !== undefined &&
    evidence.authorityEpoch === next.authorityEpoch && evidence.userEpoch !== undefined && evidence.userEpoch === next.userEpoch;
}

// Generate real Pi outcomes: required-argument failure and host refusal project
// identically despite different causes. Do not parse human error text to guess.
let executions = 0;
const tool: AgentTool = { name: 'probe', label: 'Probe', description: 'Fixture', parameters: Type.Object({ required: Type.String() }), execute: async () => { executions++; return { content: [], details: null }; } };
const assistant = fauxAssistantMessage('fixture');
async function projected(args: Record<string, string>, deny: boolean): Promise<End> {
  const outcome = await runToolCall({ type: 'toolCall', id: 'same-call', name: tool.name, arguments: args }, {
    tools: [tool], assistantMessage: assistant, context: { messages: [assistant], tools: [tool] },
    ...(deny ? { beforeToolCall: async () => ({ block: true, reason: 'Fixture refusal' }) } : {}),
  });
  return projectPiRuntimeAgentEvent({ type: 'tool_execution_end', toolCallId: 'same-call', toolName: tool.name, result: outcome.result, isError: outcome.isError }) as End;
}
const invalid = await projected({}, false), denied = await projected({ required: 'fixture' }, true);
assert.equal(executions, 0); assert.deepEqual(invalid, denied);
const base: Trace = { runId: 'fixture-run', event: invalid };
assert.equal(classify(base), 'unclassified_tool_error');
assert.equal(repeatedRejectionCandidate(base, base), false);
const rejection: Trace = { ...base, evidence: { rejection: 'validation', opaqueAttemptKey: 'synthetic-equivalence-1', authorityEpoch: 1, userEpoch: 1 } };
const cases: Array<[string, Trace, string]> = [
  ['validation with host evidence', rejection, 'pre_dispatch_validation'],
  ['authorization with host evidence', { ...rejection, evidence: { ...rejection.evidence, rejection: 'authorization' } }, 'pre_dispatch_authorization'],
  ['settled command-tool failure', { ...base, event: { ...invalid, toolName: 'run_command' }, effect: { runId: base.runId, toolCallId: invalid.toolCallId, state: 'remote_error' } }, 'settled_tool_failure'],
  ['unknown overrides apparent success', { ...base, event: { ...invalid, isError: false }, effect: { runId: base.runId, toolCallId: invalid.toolCallId, state: 'unknown' } }, 'unsettled_or_unknown_effect'],
  ['successful polling', { ...base, event: { ...invalid, isError: false }, evidence: { successfulObservation: 'poll' } }, 'successful_poll'],
  ['verification after changed files', { ...base, event: { ...invalid, isError: false }, evidence: { successfulObservation: 'verification', verifiedChangedSincePreviousCheck: true } }, 'verification_after_change'],
  ['same check without change evidence', { ...base, event: { ...invalid, isError: false }, evidence: { successfulObservation: 'verification' } }, 'verification_need_unknown'],
  ['foreign-run effect cannot supply outcome', { ...base, effect: { runId: 'other-run', toolCallId: invalid.toolCallId, state: 'remote_error' } }, 'unclassified_tool_error'],
];
for (const [name, row, expected] of cases) assert.equal(classify(row), expected, name);
const nextRejection: Trace = { ...rejection, event: { ...rejection.event, toolCallId: 'next-attempt' } };
assert.equal(repeatedRejectionCandidate(rejection, nextRejection), true);
assert.equal(repeatedRejectionCandidate(rejection, rejection), false, 'duplicate delivery is not another attempt');
for (const change of [{ opaqueAttemptKey: 'corrected-input' }, { authorityEpoch: 2 }, { userEpoch: 2 }]) assert.equal(repeatedRejectionCandidate(rejection, { ...nextRejection, evidence: { ...rejection.evidence, ...change } }), false);
for (const [, row] of cases.slice(2)) assert.equal(repeatedRejectionCandidate(row, row), false);
assert.equal(repeatedRejectionCandidate(rejection, { ...rejection, runId: 'other-run' }), false);
console.log(JSON.stringify({ actualPiOutcomesIndistinguishable: true, fixtureExecutions: executions, classifications: cases.map(([scenario, row]) => ({ scenario, classification: classify(row) })), sameCommandAloneNeverClassifiedWasteful: true, productionBehaviorChanged: false }));
