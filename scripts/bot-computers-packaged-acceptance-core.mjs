// The pure half of the packaged Bot computers acceptance (owner Mac only; see
// scripts/bot-computers-packaged-acceptance.mjs). A loopback OpenAI-compatible
// model scripts the Bot's `computer` and `computer_shell` calls. It derives
// each next call from the conversation it is sent, never from a counter, so a
// retried request gets the same answer. This file never touches the disk,
// processes or the network: the script passes in what it observed, and the
// facts Aiden owns (the give-back note, the base VM's name) come from the
// production modules.

import {
  acceptanceCapabilityBaseUrl,
  acceptanceChatCompletionPath,
} from "./computer-use-packaged-acceptance-core.mjs";

export { acceptanceCapabilityBaseUrl, acceptanceChatCompletionPath };

export const ACCEPTANCE_MARKER = "AIDEN_BOT_COMPUTERS_ACCEPTANCE_20261021";
export const ACCEPTANCE_PROMPT = `Run the Bot computers acceptance sequence ${ACCEPTANCE_MARKER}.`;
export const ACCEPTANCE_PROVIDER_ID = "bot-computers-acceptance-loopback";
export const ACCEPTANCE_PROVIDER_LABEL = "Bot computers acceptance loopback";
export const ACCEPTANCE_MODEL = "aiden-bot-computers-acceptance";
export const ACCEPTANCE_CALL_PREFIX = "aiden-bc-call-";
export const ACCEPTANCE_FINAL_TEXT = "The Bot computers acceptance sequence reached its end.";
/** One wait is the computer tool's longest; the operator presses Take over during one of them. */
export const ACCEPTANCE_WAIT_SECONDS = 30;
/** Waits the operator gets before the sequence gives up on Take over (three minutes). */
export const ACCEPTANCE_MAX_WAITS = 6;
/** The computer tool's capture bound. */
export const ACCEPTANCE_CAPTURE_MAX_EDGE = 1280;

const COMPUTER = "computer";
const COMPUTER_SHELL = "computer_shell";
const ATTACHED_IMAGES = "Attached image(s) from tool result:";
const CAPTURE_TEXT = /^Screenshot of .+ computer, (\d+)×(\d+) pixels\./u;
const NONCE = /^[0-9a-f]{32}$/u;

function requestMessages(request) {
  return Array.isArray(request?.messages) ? request.messages : [];
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function offeredTools(request) {
  return new Set(
    (Array.isArray(request?.tools) ? request.tools : [])
      .map((tool) => tool?.function?.name)
      .filter((name) => typeof name === "string"),
  );
}

function requireNonce(nonce) {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) {
    throw new Error("The acceptance nonce must be 32 lowercase hex characters.");
  }
  return nonce;
}

/** The file the Bot writes in its computer's ~/Shared, which must appear in its Computer folder. */
export function acceptanceSharedFileName(nonce) {
  return `aiden-acceptance-${requireNonce(nonce)}.txt`;
}

/** A Bot turn of this acceptance: the computer tools are offered and the person sent the acceptance prompt. */
export function isAcceptanceRequest(request) {
  if (!offeredTools(request).has(COMPUTER)) return false;
  return requestMessages(request).some(
    (message) => message?.role === "user" && contentText(message.content).includes(ACCEPTANCE_MARKER),
  );
}

/** How many tool-result images follow the tool message at `index`, the way pi-ai sends them. */
function imagesAfter(messages, index) {
  let next = index + 1;
  while (messages[next]?.role === "tool") next += 1;
  // Providers that need an assistant turn between tool results and a user message get a filler one.
  if (messages[next]?.role === "assistant" && !Array.isArray(messages[next].tool_calls)) next += 1;
  const follow = messages[next];
  if (follow?.role !== "user" || !Array.isArray(follow.content)) return 0;
  if (follow.content[0]?.type !== "text" || follow.content[0].text !== ATTACHED_IMAGES) return 0;
  return follow.content.filter(
    (part) =>
      part?.type === "image_url" &&
      typeof part.image_url?.url === "string" &&
      /^data:image\/(?:png|jpeg|webp);base64,/u.test(part.image_url.url),
  ).length;
}

/**
 * The acceptance calls the conversation already holds, in order, each with
 * what the Bot's model was sent for it (null while it has no result yet).
 */
export function acceptanceHistory(request) {
  const messages = requestMessages(request);
  const calls = [];
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (typeof call?.id !== "string" || !call.id.startsWith(ACCEPTANCE_CALL_PREFIX)) continue;
      let args;
      try {
        args = JSON.parse(call.function?.arguments ?? "");
      } catch {
        args = undefined;
      }
      const at = messages.findIndex((entry) => entry?.role === "tool" && entry.tool_call_id === call.id);
      calls.push({
        id: call.id,
        name: call.function?.name,
        args,
        result: at < 0 ? null : { text: contentText(messages[at].content), images: imagesAfter(messages, at) },
      });
    }
  }
  return calls;
}

/** A capture result's image size, or null when the call did not return a screenshot. */
export function captureSize(result) {
  const match = typeof result?.text === "string" ? CAPTURE_TEXT.exec(result.text) : null;
  if (!match || result.images !== 1) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function isAction(call, action) {
  return call.name === COMPUTER && call.args?.action === action;
}

function shellCommand(nonce) {
  const file = acceptanceSharedFileName(nonce);
  return `printf '%s\\n' '${nonce}' > "$HOME/Shared/${file}" && sw_vers -productVersion && cat "$HOME/Shared/${file}"`;
}

/**
 * The next call of the sequence, or null when it has ended (or cannot go on):
 *
 * 1. capture (this boots the computer);
 * 2. click the centre of that capture;
 * 3. wait, again and again, until a result is the give-back note: the
 *    operator presses Take over during a wait and then Give back;
 * 4. a fresh capture, as the note asks;
 * 5. computer_shell: the macOS version, and a file written to ~/Shared.
 */
export function acceptanceToolCall(history, { giveBackNote, nonce }) {
  if (typeof giveBackNote !== "string" || giveBackNote.length === 0) {
    throw new Error("The acceptance needs Aiden's give-back note.");
  }
  requireNonce(nonce);
  if (history.length === 0) return { name: COMPUTER, arguments: { action: "capture" } };
  const last = history[history.length - 1];
  if (!last.result) return null;
  if (!history.some((call) => isAction(call, "click"))) {
    const size = captureSize(last.result);
    if (!isAction(last, "capture") || !size) return null;
    return {
      name: COMPUTER,
      arguments: {
        action: "click",
        coordinate: [Math.floor(size.width / 2), Math.floor(size.height / 2)],
        intent: "Click an empty spot on the desktop",
      },
    };
  }
  const handedBack = history.findIndex((call) => call.result?.text === giveBackNote);
  if (handedBack < 0) {
    const waits = history.filter((call) => isAction(call, "wait")).length;
    if (waits >= ACCEPTANCE_MAX_WAITS) return null;
    return { name: COMPUTER, arguments: { action: "wait", seconds: ACCEPTANCE_WAIT_SECONDS } };
  }
  const after = history.slice(handedBack + 1);
  if (!after.some((call) => isAction(call, "capture"))) return { name: COMPUTER, arguments: { action: "capture" } };
  if (!after.some((call) => call.name === COMPUTER_SHELL)) {
    return {
      name: COMPUTER_SHELL,
      arguments: { command: shellCommand(nonce), description: "Print the macOS version and write a shared file" },
    };
  }
  return null;
}

function chunk(index, delta, finishReason) {
  return {
    id: `chatcmpl-aiden-bc-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model: ACCEPTANCE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function openAiToolCallChunks(index, call) {
  return [
    chunk(
      index,
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `${ACCEPTANCE_CALL_PREFIX}${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          },
        ],
      },
      null,
    ),
    chunk(index, {}, "tool_calls"),
  ];
}

export function openAiTextChunks(index, text) {
  return [chunk(index, { role: "assistant", content: text }, null), chunk(index, {}, "stop")];
}

/**
 * What the loopback model answers a request with. Requests that are not an
 * acceptance turn (a chat title, a Bot without its computer) get a short
 * text, so they never advance the sequence.
 */
export function acceptanceResponse(request, context) {
  if (!isAcceptanceRequest(request)) {
    const text = offeredTools(request).has(COMPUTER)
      ? `Send exactly: ${ACCEPTANCE_PROMPT}`
      : "This loopback model only runs the Bot computers acceptance.";
    return { kind: "other", history: [], call: null, chunks: openAiTextChunks("other", text) };
  }
  const history = acceptanceHistory(request);
  const call = acceptanceToolCall(history, context);
  return call
    ? { kind: "call", history, call, chunks: openAiToolCallChunks(history.length, call) }
    : { kind: "done", history, call: null, chunks: openAiTextChunks("done", ACCEPTANCE_FINAL_TEXT) };
}

/** Each call, with the result from the first request that carried it (later requests may trim old screenshots). */
function firstResults(requests) {
  const calls = [];
  for (const request of requests) {
    acceptanceHistory(request).forEach((call, index) => {
      if (!calls[index]) calls[index] = { ...call };
      else if (!calls[index].result && call.result) calls[index].result = call.result;
    });
  }
  return calls;
}

/** Whether what the Bot's model was sent shows every step of the sequence. */
export function evaluateAcceptanceRequests(requests, { giveBackNote, nonce, sharedFileText }) {
  const failures = [];
  const turns = requests.filter(isAcceptanceRequest);
  const evidence = { captureSize: null, waits: 0, interrupted: null, macosVersion: null };
  if (turns.length === 0) {
    return { ok: false, failures: ["The Bot never sent the acceptance prompt with its computer tools."], evidence };
  }
  const tools = offeredTools(turns[0]);
  if (!tools.has(COMPUTER_SHELL)) failures.push("The Bot was offered computer but not computer_shell.");
  const calls = firstResults(turns);

  const [capture, click] = calls;
  evidence.captureSize = captureSize(capture?.result);
  if (!capture || !isAction(capture, "capture") || !evidence.captureSize) {
    failures.push("The first capture did not return a screenshot of the Bot's computer.");
  } else if (Math.max(evidence.captureSize.width, evidence.captureSize.height) > ACCEPTANCE_CAPTURE_MAX_EDGE) {
    failures.push(`The capture was larger than ${ACCEPTANCE_CAPTURE_MAX_EDGE} px on its long side.`);
  }

  if (!click || !isAction(click, "click") || !click.result) {
    failures.push("The click never ran.");
  } else {
    const [x, y] = click.args.coordinate;
    if (click.result.text !== `Clicked at (${x}, ${y}).` && click.result.text !== giveBackNote) {
      failures.push(`The click did not land: ${click.result.text}`);
    }
    if (click.result.images !== 0) failures.push("The click returned an image it was not asked for.");
  }

  evidence.waits = calls.filter((call) => isAction(call, "wait")).length;
  const handedBack = calls.findIndex((call) => call.result?.text === giveBackNote);
  if (handedBack < 0) {
    failures.push("No call was interrupted by Take over and returned the give-back note after Give back.");
  } else {
    const interrupted = calls[handedBack];
    evidence.interrupted = interrupted.args?.action ?? null;
    if (interrupted.result.images !== 0) failures.push("The give-back note carried a capture of what the person did.");
    const fresh = calls.slice(handedBack + 1).find((call) => isAction(call, "capture"));
    if (!fresh || !captureSize(fresh.result)) failures.push("The capture after Give back did not return a screenshot.");
  }

  const shell = calls.find((call) => call.name === COMPUTER_SHELL);
  if (!shell?.result) {
    failures.push("computer_shell never ran in the Bot's computer.");
  } else {
    const lines = shell.result.text.split(/\r?\n/u).map((line) => line.trim());
    evidence.macosVersion = lines.find((line) => /^\d+\.\d+(?:\.\d+)?$/u.test(line)) ?? null;
    if (!evidence.macosVersion) failures.push("computer_shell did not print the guest's macOS version.");
    if (!lines.includes(nonce)) failures.push("computer_shell did not read back the file it wrote to ~/Shared.");
  }
  if (typeof sharedFileText !== "string" || sharedFileText.trim() !== nonce) {
    failures.push("The file the Bot wrote to ~/Shared did not reach its Computer folder.");
  }

  const last = acceptanceHistory(turns[turns.length - 1]);
  if (acceptanceToolCall(last, { giveBackNote, nonce }) !== null || !last.some((call) => call.name === COMPUTER_SHELL)) {
    failures.push("The acceptance sequence did not reach its end.");
  }
  return { ok: failures.length === 0, failures, evidence };
}

/** Who paused the Bot, from Aiden's `bot-service/bot-pauses.json`; undefined when it runs or the file is unreadable. */
export function pausedBy(document, botId) {
  const record = document?.bots?.[botId];
  return record && typeof record.by === "string" && Number.isSafeInteger(record.since) ? record.by : undefined;
}

function vmState(vms, name) {
  return (Array.isArray(vms) ? vms : []).find((vm) => vm?.name === name)?.state;
}

/**
 * Whether the computer's life, as Lume and Aiden's state reported it at each
 * step, is the one the person drove: the base and a stopped clone after Give,
 * running once the Bot used it, stopped by Pause, gone after Delete Bot
 * (with the base kept), nothing after Remove everything, and no Lume process
 * once Aiden quit.
 */
export function evaluateComputerTimeline(timeline, { baseVm }) {
  const failures = [];
  const { given, working, paused, deleted, removed, afterQuit } = timeline ?? {};
  const computers = Array.isArray(given?.computers) ? given.computers : [];
  const vmName = computers[0]?.vmName;
  if (!given) failures.push("The Bot's computer was never observed before the prompt.");
  else {
    if (!given.baseBuild) failures.push("Set up did not finish a base.");
    if (vmState(given.vms, baseVm) !== "stopped") failures.push("The base VM was not in Lume's list, stopped.");
    if (computers.length !== 1 || !vmName) failures.push("Exactly one Bot should have been given a computer.");
    else if (vmState(given.vms, vmName) === undefined) failures.push("Give did not clone a VM for the Bot.");
    else if (vmState(given.vms, vmName) !== "stopped") failures.push("Giving the Bot a computer started it.");
  }
  if (vmName) {
    if (vmState(working?.vms, vmName) !== "running") failures.push("The Bot's capture did not start its computer.");
    if (paused?.pausedBy !== "mac") failures.push("The Bot was not paused from this Mac.");
    if (vmState(paused?.vms, vmName) !== "stopped") failures.push("Pause did not stop the Bot's computer.");
    if (paused?.vmProcesses !== 0) failures.push("The paused computer's Lume process kept running.");
    if (!deleted || (Array.isArray(deleted.computers) ? deleted.computers.length : 1) !== 0) {
      failures.push("Deleting the Bot left its computer in Aiden's state.");
    }
    if (!deleted || vmState(deleted.vms, vmName) !== undefined) failures.push("Deleting the Bot left its VM in Lume.");
    if (!deleted || vmState(deleted.vms, baseVm) === undefined) failures.push("Deleting the Bot removed the shared base.");
  }
  if (!removed || !Array.isArray(removed.vms) || removed.vms.length !== 0 || removed.baseBuild) {
    failures.push("Remove everything left a VM or a base behind.");
  }
  if (afterQuit?.lumeProcesses !== 0) failures.push("A Lume process outlived Aiden's quit.");
  return { ok: failures.length === 0, failures, vmName: vmName ?? null };
}

/** userData seed: one loopback provider whose model takes images and tool calls. The operator creates the Bot. */
export function acceptanceFixture(port, capability) {
  return {
    config: {
      providers: [
        {
          id: ACCEPTANCE_PROVIDER_ID,
          kind: "openai",
          label: ACCEPTANCE_PROVIDER_LABEL,
          baseUrl: acceptanceCapabilityBaseUrl(port, capability),
          models: [ACCEPTANCE_MODEL],
          modelMetadata: { [ACCEPTANCE_MODEL]: { source: "provider", vision: true, toolCall: true } },
          defaultModel: ACCEPTANCE_MODEL,
          needsKey: false,
        },
      ],
      settings: {},
      seeded: true,
      mcpServers: [],
      skills: [],
      workspaces: [],
    },
  };
}
