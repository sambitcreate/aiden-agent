// Local fake-provider probe. Build the CLI first: cd packages/cli && npm run build.
// Run from repository root: node docs/research/experiments/cli-child-terminal-ordering.mjs
/* global AbortController */
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import * as api from '../../../packages/cli/dist/parity-test-api.js';

const originalEntry = process.env.AIDEN_CLI_ENTRY;
process.env.AIDEN_CLI_ENTRY = resolve('packages/cli/dist/app/cli.js');
const results = [];
try {
  for (const mode of ['length', 'stop', 'ordered-effects', 'duplicate-call-id']) {
    const dir = mkdtempSync(join(tmpdir(), 'aiden-child-research-'));
    const requests = [], events = [];
    let value = 'old';
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body); requests.push(parsed);
      const toolTurn = ['ordered-effects', 'duplicate-call-id'].includes(mode) && !parsed.messages.some(m => m.role === 'tool');
      const delta = toolTurn ? { role: 'assistant', tool_calls: ['set_value', 'get_value'].map((name, index) => ({ index, id: mode === 'duplicate-call-id' ? 'same-call' : `call-${index}`, type: 'function', function: { name, arguments: '{}' } })) } : { role: 'assistant', content: mode === 'length' ? 'Partial findings: the actual fix is' : 'Finished' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [deltaPart, finish] of [[delta, null], [{}, toolTurn ? 'tool_calls' : mode === 'length' ? 'length' : 'stop']]) response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', choices: [{ index: 0, delta: deltaPart, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      api.atomicJson(join(dir, 'models.json'), { providers: { 'cli-test': { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-test-only', models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
      const runtime = await api.createCliModelRuntime(dir);
      const tools = ['set_value', 'get_value'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => {
        events.push(`${name}:start`);
        if (name === 'set_value') { await new Promise(resolve => setTimeout(resolve, 100)); value = 'new'; }
        const observed = value;
        events.push(`${name}:end:${observed}`);
        return { content: [{ type: 'text', text: observed }], details: {} };
      } }));
      const result = await api.runCliSubagent(dir, { runtime: { model: runtime.getModel('cli-test', 'test') }, workspaceRoot: dir, permission: 'ask', thinkingLevel: 'off', context: { mode: 'fork', revisionHash: 'test', messages: [{ role: 'user', content: 'Local fixture', timestamp: 100 }] }, request: { role: 'scout', label: 'Probe', task: mode === 'length' ? 'Explain the fix' : 'Set the value and then read it' }, policy: { deadlineMs: mode === 'duplicate-call-id' ? 2500 : 15000 } }, mode === 'length' ? [] : tools, async () => {}, error => events.push(`diagnostic:${error.message}`));
      assert.equal(requests.length, ['ordered-effects', 'duplicate-call-id'].includes(mode) ? 2 : 1);
      const receipt = { mode, result, events, providerToolResults: requests.at(-1).messages.filter(m => m.role === 'tool').map(m => ({ tool_call_id: m.tool_call_id, content: m.content })) };
      if (mode === 'length' || mode === 'stop') {
        const bot = api.createBotSubagentTool(dir, { authority: { chatId: 'probe-chat', managedHome: { workspaceId: 'probe-workspace' }, workingDirectory: dir, provider: { sourceProviderId: 'cli-test', sourceModelId: 'test' } }, signal: new AbortController().signal, revalidateBeforeEffect: async () => {} }, [], async () => null);
        receipt.botResult = await bot.execute('probe-bot', { tasks: [{ role: 'scout', label: 'Probe', task: 'Explain the fix' }] });
        assert.equal(requests.length, 2, 'one request per direct/Bot child; no automatic retry');
      }
      results.push(receipt);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (originalEntry === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = originalEntry;
}
