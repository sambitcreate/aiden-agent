/* global Buffer */

import { createServer } from "node:http";

export const SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION = 1;
export const SUBAGENT_PACKAGED_SOAK_CHAT_ID = "subagent-soak";
export const SUBAGENT_PACKAGED_SOAK_WORKSPACE_ID = "subagent-soak-workspace";
export const SUBAGENT_PACKAGED_SOAK_PROVIDER_ID = "subagent-soak-loopback";
export const SUBAGENT_PACKAGED_SOAK_MODEL_ID = "aiden-subagent-soak";
// The packaged fixture must admit Aiden's real parent prompt plus its complete
// tool surface before exercising the child lifecycle.
export const SUBAGENT_PACKAGED_SOAK_CONTEXT_LENGTH = 128_000;
export const SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME = "control.json";
export const SUBAGENT_PACKAGED_SOAK_RECEIPT_FILENAME = "receipt.json";
export const SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX = "aiden-subagent-soak-";
export const SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH = "--aiden-subagent-soak-control";
export const SUBAGENT_PACKAGED_SOAK_ENV = "AIDEN_SUBAGENT_SOAK";
export const SUBAGENT_PACKAGED_SOAK_MODES = Object.freeze(["user_stop", "navigate", "quit"]);

const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CYCLE = 100_000;
const MIN_SOAK_CYCLES = 3;
const METRIC_KEYS = Object.freeze([
  "starts",
  "completions",
  "failures",
  "timeouts",
  "peakConcurrency",
  "cleanupFailures",
]);

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCycle(value) {
  return nonNegativeInteger(value) && value >= 1 && value <= MAX_CYCLE;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validPackagedArtifactIdentity(value) {
  return (
    isRecord(value) &&
    nonEmptyString(value.bundleIdentifier) &&
    nonEmptyString(value.bundleVersion) &&
    nonEmptyString(value.shortVersion) &&
    typeof value.cdHash === "string" &&
    /^[a-f0-9]{40}$/iu.test(value.cdHash) &&
    typeof value.appAsarSha256 === "string" &&
    /^[a-f0-9]{64}$/iu.test(value.appAsarSha256)
  );
}

function validNonce(value) {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}

function validMode(value) {
  return SUBAGENT_PACKAGED_SOAK_MODES.includes(value);
}

function invalidControl() {
  return new Error("Invalid packaged subagent soak control.");
}

function invalidReceipt() {
  return new Error("Invalid packaged subagent soak receipt.");
}

export function soakCapabilityBaseUrl(port, capability) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Packaged subagent soak loopback port is invalid.");
  }
  if (!validNonce(capability)) {
    throw new Error(
      "Packaged subagent soak loopback capability must contain exactly 256 bits of URL-safe entropy.",
    );
  }
  return `http://127.0.0.1:${port}/${capability}/v1`;
}

export function soakChatCompletionPath(capability) {
  soakCapabilityBaseUrl(1, capability);
  return `/${capability}/v1/chat/completions`;
}

export function createSubagentPackagedSoakControl({ nonce, cycle, mode }) {
  return parseSubagentPackagedSoakControl({
    version: SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION,
    nonce,
    cycle,
    mode,
  });
}

export function parseSubagentPackagedSoakControl(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "nonce", "cycle", "mode"])) {
    throw invalidControl();
  }
  if (
    value.version !== SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION ||
    !validNonce(value.nonce) ||
    !validCycle(value.cycle) ||
    !validMode(value.mode)
  ) {
    throw invalidControl();
  }
  return {
    version: SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION,
    nonce: value.nonce,
    cycle: value.cycle,
    mode: value.mode,
  };
}

export function parseSubagentPackagedSoakMetrics(value) {
  if (!isRecord(value) || !hasExactKeys(value, METRIC_KEYS)) throw invalidReceipt();
  if (METRIC_KEYS.some((key) => !nonNegativeInteger(value[key]))) throw invalidReceipt();
  return {
    starts: value.starts,
    completions: value.completions,
    failures: value.failures,
    timeouts: value.timeouts,
    peakConcurrency: value.peakConcurrency,
    cleanupFailures: value.cleanupFailures,
  };
}

export function expectedSubagentPackagedSoakReceiptPhase(mode) {
  if (!validMode(mode)) throw invalidControl();
  return mode === "quit" ? "action_dispatched" : "settled";
}

export function createSubagentPackagedSoakReceipt(control, metrics) {
  const parsedControl = parseSubagentPackagedSoakControl(control);
  return {
    ...parsedControl,
    phase: expectedSubagentPackagedSoakReceiptPhase(parsedControl.mode),
    metrics: parseSubagentPackagedSoakMetrics(metrics),
  };
}

export function parseSubagentPackagedSoakReceipt(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "nonce", "cycle", "mode", "phase", "metrics"])
  ) {
    throw invalidReceipt();
  }
  const control = parseSubagentPackagedSoakControl({
    version: value.version,
    nonce: value.nonce,
    cycle: value.cycle,
    mode: value.mode,
  });
  if (value.phase !== expectedSubagentPackagedSoakReceiptPhase(control.mode)) {
    throw invalidReceipt();
  }
  return {
    ...control,
    phase: value.phase,
    metrics: parseSubagentPackagedSoakMetrics(value.metrics),
  };
}

export function assertSubagentPackagedSoakReceipt(receipt, control) {
  const parsedReceipt = parseSubagentPackagedSoakReceipt(receipt);
  const parsedControl = parseSubagentPackagedSoakControl(control);
  if (
    parsedReceipt.nonce !== parsedControl.nonce ||
    parsedReceipt.cycle !== parsedControl.cycle ||
    parsedReceipt.mode !== parsedControl.mode
  ) {
    throw invalidReceipt();
  }
  if (
    parsedReceipt.metrics.starts !== 1 ||
    parsedReceipt.metrics.completions !== 0 ||
    parsedReceipt.metrics.peakConcurrency !== 1 ||
    parsedReceipt.metrics.failures !== 0 ||
    parsedReceipt.metrics.timeouts !== 0 ||
    parsedReceipt.metrics.cleanupFailures !== 0
  ) {
    throw new Error("Packaged subagent soak did not report clean aggregate lifecycle metrics.");
  }
  return parsedReceipt;
}

/**
 * Seed the current split portable/local configuration rather than relying on
 * a migration-era monolithic config. Nothing here is sent to the receipt.
 */
export function subagentPackagedSoakFixture({ port, capability, workspacePath, now = Date.now() }) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    throw new Error("Packaged subagent soak workspace path is invalid.");
  }
  const baseUrl = soakCapabilityBaseUrl(port, capability);
  const provider = {
    id: SUBAGENT_PACKAGED_SOAK_PROVIDER_ID,
    kind: "openai",
    label: "Subagent soak loopback",
    baseUrl,
    defaultModel: SUBAGENT_PACKAGED_SOAK_MODEL_ID,
    needsKey: false,
    deployment: "local",
  };
  const workspace = {
    id: SUBAGENT_PACKAGED_SOAK_WORKSPACE_ID,
    name: "Subagent soak workspace",
    folderPath: workspacePath,
    permission: "full",
    createdAt: now,
    updatedAt: now,
  };
  const chat = {
    id: SUBAGENT_PACKAGED_SOAK_CHAT_ID,
    title: "Subagent lifecycle soak",
    workspaceId: workspace.id,
    providerId: provider.id,
    model: SUBAGENT_PACKAGED_SOAK_MODEL_ID,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  return {
    portableConfig: {
      providers: [provider],
      providerIdAliases: {},
      mcpServers: [],
      skills: [],
    },
    localConfig: {
      workspaces: [workspace],
      seeded: true,
      aidenDirMigratedAt: now,
    },
    settings: {
      settings: {
        lastProviderId: provider.id,
        lastModel: SUBAGENT_PACKAGED_SOAK_MODEL_ID,
      },
    },
    providerModelCache: {
      byProvider: {
        [provider.id]: {
          models: [SUBAGENT_PACKAGED_SOAK_MODEL_ID],
          modelMetadata: {
            [SUBAGENT_PACKAGED_SOAK_MODEL_ID]: {
              source: "provider",
              toolCall: true,
              contextLength: SUBAGENT_PACKAGED_SOAK_CONTEXT_LENGTH,
            },
          },
        },
      },
    },
    chat,
    chatIndex: [
      {
        id: chat.id,
        title: chat.title,
        workspaceId: chat.workspaceId,
        providerId: chat.providerId,
        model: chat.model,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      },
    ],
  };
}

function hasSubagentTool(request) {
  return Array.isArray(request?.tools)
    ? request.tools.some((tool) => {
        const functionName = tool?.function?.name ?? tool?.name;
        return functionName === "subagent";
      })
    : false;
}

function writeSse(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function parentToolCallChunks() {
  const common = {
    id: "chatcmpl-aiden-subagent-soak-parent",
    object: "chat.completion.chunk",
    created: 0,
    model: SUBAGENT_PACKAGED_SOAK_MODEL_ID,
  };
  const tasks = {
    tasks: [
      {
        role: "scout",
        label: "Lifecycle probe",
        task: "Wait until the parent cancels this bounded child.",
      },
    ],
  };
  return [
    {
      ...common,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "aiden-subagent-soak-call",
                type: "function",
                function: { name: "subagent", arguments: JSON.stringify(tasks) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

async function readJsonRequest(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Packaged subagent soak request exceeded 4 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * A capability-authenticated loopback OpenAI fixture. It keeps exactly one
 * child stream open until Aiden cancels it, but retains only aggregate facts.
 */
export async function startSubagentPackagedSoakModel({ capability }) {
  const completionPath = soakChatCompletionPath(capability);
  const evidence = {
    parentToolCalls: 0,
    childStarts: 0,
    childAborts: 0,
    unexpectedRequests: 0,
  };
  let parentToolIssued = false;
  let childActive = false;
  let resolveChildStarted;
  let resolveChildAborted;
  const childStarted = new Promise((resolve) => {
    resolveChildStarted = resolve;
  });
  const childAborted = new Promise((resolve) => {
    resolveChildAborted = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== completionPath) {
        response.writeHead(404).end();
        return;
      }
      const body = await readJsonRequest(request);
      if (!parentToolIssued && hasSubagentTool(body)) {
        parentToolIssued = true;
        evidence.parentToolCalls += 1;
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/event-stream",
        });
        for (const chunk of parentToolCallChunks()) writeSse(response, chunk);
        response.end("data: [DONE]\n\n");
        return;
      }

      if (parentToolIssued && !hasSubagentTool(body) && !childActive) {
        childActive = true;
        evidence.childStarts += 1;
        resolveChildStarted();
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/event-stream",
        });
        writeSse(response, {
          id: "chatcmpl-aiden-subagent-soak-child",
          object: "chat.completion.chunk",
          created: 0,
          model: SUBAGENT_PACKAGED_SOAK_MODEL_ID,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Working." },
              finish_reason: null,
            },
          ],
        });
        let closed = false;
        const observeAbort = () => {
          if (closed) return;
          closed = true;
          evidence.childAborts += 1;
          resolveChildAborted();
        };
        request.once("aborted", observeAbort);
        response.once("close", observeAbort);
        return;
      }

      evidence.unexpectedRequests += 1;
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unexpected soak model request." } }));
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Loopback soak fixture failed." } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Packaged subagent soak loopback did not bind TCP.");
  }
  return {
    port: address.port,
    childStarted,
    childAborted,
    evidence: () => ({ ...evidence }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((caught) => (caught ? reject(caught) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export function createSubagentPackagedSoakAggregate({ cycles, artifact }) {
  if (!validCycle(cycles) || cycles < MIN_SOAK_CYCLES) {
    throw new Error("Packaged subagent soak cycle count is invalid.");
  }
  if (!validPackagedArtifactIdentity(artifact)) {
    throw new Error("Packaged subagent soak artifact identity is invalid.");
  }
  return {
    schemaVersion: SUBAGENT_PACKAGED_SOAK_SCHEMA_VERSION,
    cyclesRequested: cycles,
    cyclesCompleted: 0,
    userStops: 0,
    navigations: 0,
    quits: 0,
    requestAborts: 0,
    starts: 0,
    completions: 0,
    failures: 0,
    timeouts: 0,
    peakConcurrency: 0,
    cleanupFailures: 0,
    artifact: {
      bundleIdentifier: artifact.bundleIdentifier,
      bundleVersion: artifact.bundleVersion,
      shortVersion: artifact.shortVersion,
      cdHash: artifact.cdHash,
      appAsarSha256: artifact.appAsarSha256,
    },
  };
}

/** Add only totals; control nonce, temporary paths, chat ids, and output never leave a cycle. */
export function recordSubagentPackagedSoakCycle(aggregate, { receipt, requestAborts }) {
  const parsed = parseSubagentPackagedSoakReceipt(receipt);
  if (!nonNegativeInteger(requestAborts) || requestAborts < 1) {
    throw new Error("Packaged subagent soak did not observe child request cancellation.");
  }
  aggregate.cyclesCompleted += 1;
  if (parsed.mode === "user_stop") aggregate.userStops += 1;
  else if (parsed.mode === "navigate") aggregate.navigations += 1;
  else aggregate.quits += 1;
  aggregate.requestAborts += requestAborts;
  aggregate.starts += parsed.metrics.starts;
  aggregate.completions += parsed.metrics.completions;
  aggregate.failures += parsed.metrics.failures;
  aggregate.timeouts += parsed.metrics.timeouts;
  aggregate.peakConcurrency = Math.max(aggregate.peakConcurrency, parsed.metrics.peakConcurrency);
  aggregate.cleanupFailures += parsed.metrics.cleanupFailures;
  return aggregate;
}

export function assertCompletedSubagentPackagedSoakAggregate(aggregate) {
  if (
    !isRecord(aggregate) ||
    !validPackagedArtifactIdentity(aggregate.artifact) ||
    aggregate.cyclesCompleted !== aggregate.cyclesRequested
  ) {
    throw new Error("Packaged subagent soak did not complete every requested cycle.");
  }
  if (
    aggregate.userStops < 1 ||
    aggregate.navigations < 1 ||
    aggregate.quits < 1 ||
    aggregate.requestAborts !== aggregate.cyclesRequested ||
    aggregate.starts !== aggregate.cyclesRequested ||
    aggregate.completions !== 0 ||
    aggregate.peakConcurrency !== 1 ||
    aggregate.failures !== 0 ||
    aggregate.timeouts !== 0 ||
    aggregate.cleanupFailures !== 0
  ) {
    throw new Error("Packaged subagent soak aggregate did not meet the clean lifecycle gate.");
  }
  return aggregate;
}
