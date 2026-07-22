export const ACCEPTANCE_TEXT = "AIDEN_CUA_ACCEPTANCE_20260722";
export const ACCEPTANCE_SAVED_TEXT = `${ACCEPTANCE_TEXT}!`;
export const ACCEPTANCE_TOOL_COUNT = 9;

function exactTargetFields(target) {
  if (!target) throw new Error("The disposable TextEdit window has not been resolved yet.");
  return { pid: target.pid, window_id: target.window_id };
}

export function acceptanceToolCall(index, target) {
  switch (index) {
    case 0:
      return { action: "list_apps" };
    case 1:
      return { action: "list_windows" };
    case 2:
      return { action: "capture", mode: "ax", ...exactTargetFields(target) };
    case 3:
      return { action: "capture", mode: "vision", ...exactTargetFields(target) };
    case 4:
      return { action: "capture", mode: "som", ...exactTargetFields(target) };
    case 5:
      return { action: "type", text: ACCEPTANCE_SAVED_TEXT, capture_after: true };
    case 6:
      return { action: "key", keys: "cmd+s", capture_after: false };
    case 7:
      return { action: "click", element: 0 };
    case 8:
      return { action: "wait", seconds: 30 };
    default:
      return null;
  }
}

export function openAiToolCallChunks(index, args) {
  if (!args) return null;
  const common = {
    id: `chatcmpl-aiden-cua-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "aiden-cua-acceptance",
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
                id: `aiden-cua-call-${index}`,
                type: "function",
                function: { name: "computer_use", arguments: JSON.stringify(args) },
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

function requestMessages(request) {
  return Array.isArray(request?.messages) ? request.messages : [];
}

function correlatedToolMessage(request, callIndex) {
  const callId = `aiden-cua-call-${callIndex}`;
  const matches = requestMessages(request).filter(
    (message) => message?.role === "tool" && message.tool_call_id === callId,
  );
  if (matches.length !== 1 || typeof matches[0].content !== "string") {
    throw new Error(`Expected one tool result correlated to ${callId}.`);
  }
  return matches[0];
}

export function correlatedToolResult(request, callIndex) {
  const message = correlatedToolMessage(request, callIndex);
  let payload;
  try {
    payload = JSON.parse(message.content);
  } catch {
    throw new Error(`Tool result ${message.tool_call_id} was not structured success JSON.`);
  }
  if (!payload || payload.ok !== true) {
    throw new Error(`Tool result ${message.tool_call_id} did not report ok: true.`);
  }
  return payload;
}

function titleCandidates(expectedTitles) {
  return new Set(expectedTitles.map((title) => title.normalize("NFC")));
}

export function resolveAcceptanceTarget(request, expectedTitles) {
  const payload = correlatedToolResult(request, 1);
  if (payload.action !== "list_windows" || !Array.isArray(payload.windows)) {
    throw new Error("The correlated list_windows result was malformed.");
  }
  const titles = titleCandidates(expectedTitles);
  const matches = payload.windows.filter(
    (window) =>
      window?.app_name === "TextEdit" &&
      typeof window.title === "string" &&
      titles.has(window.title.normalize("NFC")) &&
      Number.isInteger(window.pid) &&
      window.pid > 0 &&
      Number.isInteger(window.window_id) &&
      window.window_id > 0,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one disposable TextEdit window titled ${expectedTitles.join(" or ")}, found ${matches.length}.`,
    );
  }
  return {
    pid: matches[0].pid,
    window_id: matches[0].window_id,
    app_name: matches[0].app_name,
    title: matches[0].title,
  };
}

function targetMatches(actual, expected) {
  return (
    actual?.pid === expected.pid &&
    (actual.windowId ?? actual.window_id) === expected.window_id &&
    (actual.app ?? actual.app_name) === expected.app_name &&
    actual.title === expected.title
  );
}

function hasImageAfterToolResult(request, callIndex) {
  const messages = requestMessages(request);
  const callId = `aiden-cua-call-${callIndex}`;
  const toolIndex = messages.findIndex(
    (message) => message?.role === "tool" && message.tool_call_id === callId,
  );
  if (toolIndex < 0) return false;
  return messages.slice(toolIndex + 1).some((message) => {
    if (message?.role !== "user" || !Array.isArray(message.content)) return false;
    return message.content.some(
      (part) =>
        part?.type === "image_url" &&
        typeof part.image_url?.url === "string" &&
        /^data:image\/(?:png|jpeg|webp);base64,/u.test(part.image_url.url),
    );
  });
}

function expectSuccessfulAction({
  requests,
  requestIndex,
  callIndex,
  action,
  mode,
  target,
  failures,
}) {
  try {
    const payload = correlatedToolResult(requests[requestIndex], callIndex);
    if (payload.action !== action) failures.push(`Result ${callIndex} was not ${action}.`);
    if (mode && payload.mode !== mode) failures.push(`Result ${callIndex} was not ${mode} mode.`);
    if (target && !targetMatches(payload.target, target)) {
      failures.push(`Result ${callIndex} did not retain the disposable TextEdit target.`);
    }
    return payload;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function evaluateAcceptanceRequests(requests, { expectedTitles = [], savedText = "" } = {}) {
  const failures = [];
  if (requests.length !== ACCEPTANCE_TOOL_COUNT) {
    failures.push(
      `Expected exactly ${ACCEPTANCE_TOOL_COUNT} scripted model turns, received ${requests.length}.`,
    );
  }

  const apps = expectSuccessfulAction({
    requests,
    requestIndex: 1,
    callIndex: 0,
    action: "list_apps",
    failures,
  });
  if (
    apps &&
    (!Array.isArray(apps.apps) ||
      !apps.apps.some((app) => app?.name === "TextEdit" || app?.bundle_id === "com.apple.TextEdit"))
  ) {
    failures.push("The successful list_apps result did not include TextEdit.");
  }

  let target = null;
  try {
    target = resolveAcceptanceTarget(requests[2], expectedTitles);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (target) {
    for (const [requestIndex, callIndex, mode] of [
      [3, 2, "ax"],
      [4, 3, "vision"],
      [5, 4, "som"],
    ]) {
      expectSuccessfulAction({
        requests,
        requestIndex,
        callIndex,
        action: "capture",
        mode,
        target,
        failures,
      });
    }
    if (!hasImageAfterToolResult(requests[4], 3))
      failures.push("Vision capture returned no image.");
    if (!hasImageAfterToolResult(requests[5], 4)) failures.push("SoM capture returned no image.");

    const typed = expectSuccessfulAction({
      requests,
      requestIndex: 6,
      callIndex: 5,
      action: "type",
      target,
      failures,
    });
    if (
      !typed?.capture ||
      typed.capture.ok !== true ||
      typed.capture.action !== "capture" ||
      typed.capture.mode !== "som" ||
      !targetMatches(typed.capture.target, target)
    ) {
      failures.push(
        "The approved type action did not return an exact-target capture_after result.",
      );
    } else if (!JSON.stringify(typed.capture).includes(ACCEPTANCE_TEXT)) {
      failures.push("The capture_after result did not contain the typed acceptance marker.");
    }
    if (!hasImageAfterToolResult(requests[6], 5)) {
      failures.push("The approved type action's capture_after result returned no image.");
    }

    expectSuccessfulAction({
      requests,
      requestIndex: 7,
      callIndex: 6,
      action: "key",
      target,
      failures,
    });
    if (hasImageAfterToolResult(requests[7], 6)) {
      failures.push("The save-key action ignored capture_after: false.");
    }
  }

  try {
    const stale = correlatedToolMessage(requests[8], 7).content;
    if (!/not present in the latest capture|stale element|Capture again/iu.test(stale)) {
      failures.push("The stale element action did not return the expected pre-approval rejection.");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (!savedText.includes(ACCEPTANCE_SAVED_TEXT)) {
    failures.push("The disposable TextEdit file did not contain the typed and saved marker.");
  }
  return { ok: failures.length === 0, failures, target };
}

export function acceptanceCapabilityBaseUrl(port, capability) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Acceptance loopback port is invalid.");
  }
  if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{43,}$/u.test(capability)) {
    throw new Error(
      "Acceptance loopback capability must contain at least 256 bits of URL-safe entropy.",
    );
  }
  return `http://127.0.0.1:${port}/${capability}/v1`;
}

export function acceptanceChatCompletionPath(capability) {
  acceptanceCapabilityBaseUrl(1, capability);
  return `/${capability}/v1/chat/completions`;
}

export function acceptanceFixture(port, capability, now = Date.now()) {
  const providerId = "acceptance-loopback";
  const model = "aiden-cua-acceptance";
  const chatId = "computer-use-acceptance";
  const workspaceId = "acceptance-workspace";
  const provider = {
    id: providerId,
    kind: "openai",
    label: "Computer Use acceptance loopback",
    baseUrl: acceptanceCapabilityBaseUrl(port, capability),
    models: [model],
    modelMetadata: {
      [model]: { source: "provider", vision: true, toolCall: true },
    },
    defaultModel: model,
    needsKey: false,
  };
  const workspace = {
    id: workspaceId,
    name: "Computer Use acceptance",
    permission: "none",
    createdAt: now,
    updatedAt: now,
  };
  const chat = {
    id: chatId,
    title: "Computer Use acceptance",
    workspaceId,
    providerId,
    model,
    computerUseEnabled: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  return {
    config: {
      providers: [provider],
      settings: { computerUseEnabled: false },
      seeded: true,
      mcpServers: [],
      skills: [],
      workspaces: [workspace],
    },
    chat,
    index: [
      {
        id: chat.id,
        title: chat.title,
        workspaceId,
        providerId,
        model,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}
