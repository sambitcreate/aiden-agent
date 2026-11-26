import { Buffer } from "node:buffer";

export const ACCEPTANCE_TEXT = "AIDEN_CUA_ACCEPTANCE_20260722";
export const ACCEPTANCE_SAVED_TEXT = `${ACCEPTANCE_TEXT}!`;
export const ACCEPTANCE_DENIED_TEXT = "AIDEN_CUA_DENIED_MUST_NOT_APPEAR";
export const ACCEPTANCE_TYPED_PREFIX = "AIDEN_CUA";
export const ACCEPTANCE_TARGET_INITIAL_TEXT = "Aiden Computer Use disposable acceptance window.\n";
export const ACCEPTANCE_DECOY_INITIAL_TEXT =
  "Aiden Computer Use decoy window — must stay unchanged.\n";
export const ACCEPTANCE_TOOL_COUNT = 9;
export const ACCEPTANCE_TWO_WINDOW_TOOL_COUNT = 10;
export const ACCEPTANCE_MODEL = "aiden-cua-acceptance";
export const ACCEPTANCE_DENIED_MODEL = "aiden-cua-acceptance-denied";

export const ACCEPTANCE_CHECK_STATUSES = Object.freeze([
  "pass",
  "failed",
  "environment problem",
  "unsupported",
]);

export const REAL_DESKTOP_CHECK_IDS = Object.freeze([
  "textedit_saves_marker",
  "two_windows_isolation_and_cursor",
  "stop_leaves_no_helper",
  "denied_permission_changes_nothing",
]);

export const MIN_SUPPORTED_MACOS_VERSION = Object.freeze({ major: 14, minor: 4 });
export const DEFAULT_CURSOR_TOLERANCE_PX = 1;

const VALID_STATUS_SET = new Set(ACCEPTANCE_CHECK_STATUSES);

const ACCEPTED_DENIAL_PHRASES = Object.freeze([
  "The user declined Computer Use in this chat.",
  "Finish Computer Use setup on your Mac (Accessibility and Screen Recording), then ask again.",
]);

const ACCEPTED_DENIAL_ERROR_CODES = new Set([
  "permission_required",
  "access_denied",
  "approval_denied",
]);

function exactTargetFields(target, label = "The disposable TextEdit window") {
  if (!target) throw new Error(`${label} has not been resolved yet.`);
  return { pid: target.pid, window_id: target.window_id };
}

export function acceptanceToolCall(index, target, decoy = null) {
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
      return decoy
        ? {
            action: "capture",
            mode: "ax",
            ...exactTargetFields(decoy, "The decoy TextEdit window"),
          }
        : { action: "wait", seconds: 30 };
    case 9:
      return decoy ? { action: "wait", seconds: 30 } : null;
    default:
      return null;
  }
}

export function acceptanceDeniedToolCall(index) {
  if (index === 0) {
    return { action: "type", text: ACCEPTANCE_DENIED_TEXT, capture_after: false };
  }
  return null;
}

export function openAiToolCallChunks(index, args, { model = ACCEPTANCE_MODEL, callPrefix = "aiden-cua-call" } = {}) {
  if (!args) return null;
  const common = {
    id: `chatcmpl-${callPrefix}-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model,
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
                id: `${callPrefix}-${index}`,
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

export function correlatedToolMessage(request, callIndex, callPrefix = "aiden-cua-call") {
  const callId = `${callPrefix}-${callIndex}`;
  const matches = requestMessages(request).filter(
    (message) => message?.role === "tool" && message.tool_call_id === callId,
  );
  if (matches.length !== 1 || typeof matches[0].content !== "string") {
    throw new Error(`Expected one tool result correlated to ${callId}.`);
  }
  return matches[0];
}

export function correlatedToolResult(request, callIndex, callPrefix = "aiden-cua-call") {
  const message = correlatedToolMessage(request, callIndex, callPrefix);
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

function resolveNamedTextEditWindow(windows, expectedTitles, description) {
  const titles = titleCandidates(expectedTitles);
  const matches = windows.filter(
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
      `Expected exactly one ${description} titled ${expectedTitles.join(" or ")}, found ${matches.length}.`,
    );
  }
  return {
    pid: matches[0].pid,
    window_id: matches[0].window_id,
    app_name: matches[0].app_name,
    title: matches[0].title,
  };
}

export function resolveAcceptanceTarget(request, expectedTitles) {
  const payload = correlatedToolResult(request, 1);
  if (payload.action !== "list_windows" || !Array.isArray(payload.windows)) {
    throw new Error("The correlated list_windows result was malformed.");
  }
  return resolveNamedTextEditWindow(payload.windows, expectedTitles, "disposable TextEdit window");
}

export function resolveAcceptanceWindows(request, { targetTitles, decoyTitles }) {
  const payload = correlatedToolResult(request, 1);
  if (payload.action !== "list_windows" || !Array.isArray(payload.windows)) {
    throw new Error("The correlated list_windows result was malformed.");
  }
  const target = resolveNamedTextEditWindow(
    payload.windows,
    targetTitles,
    "disposable TextEdit target window",
  );
  const decoy = resolveNamedTextEditWindow(
    payload.windows,
    decoyTitles,
    "disposable TextEdit decoy window",
  );
  if (target.window_id === decoy.window_id) {
    throw new Error("Target and decoy TextEdit windows must have distinct window IDs.");
  }
  return { target, decoy };
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

export function evaluateAcceptanceRequests(
  requests,
  { expectedTitles = [], decoyTitles = null, savedText = "", decoySavedText = null } = {},
) {
  const failures = [];
  const twoWindow = Array.isArray(decoyTitles) && decoyTitles.length > 0;
  const expectedCount = twoWindow ? ACCEPTANCE_TWO_WINDOW_TOOL_COUNT : ACCEPTANCE_TOOL_COUNT;
  if (requests.length !== expectedCount) {
    failures.push(
      `Expected exactly ${expectedCount} scripted model turns, received ${requests.length}.`,
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
  let decoy = null;
  try {
    if (twoWindow) {
      ({ target, decoy } = resolveAcceptanceWindows(requests[2], {
        targetTitles: expectedTitles,
        decoyTitles,
      }));
    } else {
      target = resolveAcceptanceTarget(requests[2], expectedTitles);
    }
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
      failures.push("The type action did not return an exact-target capture_after result.");
    } else if (!JSON.stringify(typed.capture).includes(ACCEPTANCE_TEXT)) {
      failures.push("The capture_after result did not contain the typed acceptance marker.");
    }
    if (!hasImageAfterToolResult(requests[6], 5)) {
      failures.push("The type action's capture_after result returned no image.");
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
      failures.push("The stale element action was not rejected before it ran.");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  let decoyLiveCaptureText = null;
  if (twoWindow && decoy) {
    const decoyCapture = expectSuccessfulAction({
      requests,
      requestIndex: 9,
      callIndex: 8,
      action: "capture",
      mode: "ax",
      target: decoy,
      failures,
    });
    if (decoyCapture) {
      decoyLiveCaptureText = JSON.stringify(decoyCapture);
      if (decoyLiveCaptureText.includes(ACCEPTANCE_TEXT)) {
        failures.push("The decoy TextEdit window capture contained the typed target marker.");
      }
    }
  }

  if (!savedText.includes(ACCEPTANCE_SAVED_TEXT)) {
    failures.push("The disposable TextEdit file did not contain the typed and saved marker.");
  }
  if (twoWindow && typeof decoySavedText === "string" && decoySavedText.includes(ACCEPTANCE_TEXT)) {
    failures.push("The decoy TextEdit file on disk was unexpectedly modified.");
  }
  return { ok: failures.length === 0, failures, target, decoy, decoyLiveCaptureText };
}

export function parseMacOSVersion(versionString) {
  if (typeof versionString !== "string") return null;
  const match = /^\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/u.exec(versionString);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
  };
}

export function evaluateHostSupport({ platform, macOSVersion }) {
  if (platform !== "darwin") {
    return {
      supported: false,
      reason: `Computer Use requires macOS ${MIN_SUPPORTED_MACOS_VERSION.major}.${MIN_SUPPORTED_MACOS_VERSION.minor} or newer; host platform is ${platform}.`,
    };
  }
  const parsed = parseMacOSVersion(macOSVersion);
  if (!parsed) {
    return {
      supported: false,
      reason: `Could not parse macOS version (${String(macOSVersion ?? "unknown")}); Computer Use requires macOS ${MIN_SUPPORTED_MACOS_VERSION.major}.${MIN_SUPPORTED_MACOS_VERSION.minor} or newer.`,
    };
  }
  const meetsMinimum =
    parsed.major > MIN_SUPPORTED_MACOS_VERSION.major ||
    (parsed.major === MIN_SUPPORTED_MACOS_VERSION.major &&
      parsed.minor >= MIN_SUPPORTED_MACOS_VERSION.minor);
  if (!meetsMinimum) {
    return {
      supported: false,
      reason: `Computer Use requires macOS ${MIN_SUPPORTED_MACOS_VERSION.major}.${MIN_SUPPORTED_MACOS_VERSION.minor} or newer; host is macOS ${macOSVersion}.`,
    };
  }
  return { supported: true, reason: null };
}

function makeCheckRow(id, status, detail, metadata, evidence = undefined) {
  if (!VALID_STATUS_SET.has(status)) {
    throw new Error(`Invalid check status '${String(status)}' for ${id}.`);
  }
  return {
    id,
    status,
    detail,
    appVersion: metadata.appVersion,
    driverVersion: metadata.driverVersion,
    macOSVersion: metadata.macOSVersion,
    ...(evidence ? { evidence } : {}),
  };
}

function isFinitePoint(point) {
  return (
    point !== null &&
    typeof point === "object" &&
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  );
}

export function evaluateTextEditMarkerCheck({
  metadata,
  targetFileText,
  initialText = ACCEPTANCE_TARGET_INITIAL_TEXT,
  expectedMarker = ACCEPTANCE_SAVED_TEXT,
  targetMatched = true,
  environmentError = null,
}) {
  const id = "textedit_saves_marker";
  if (environmentError) {
    return makeCheckRow(id, "environment problem", String(environmentError), metadata);
  }
  if (!targetMatched) {
    return makeCheckRow(
      id,
      "failed",
      "Computer Use did not bind to the newly launched disposable TextEdit process.",
      metadata,
    );
  }
  if (typeof targetFileText !== "string") {
    return makeCheckRow(id, "failed", "The target TextEdit file could not be read from disk.", metadata);
  }
  const changed = targetFileText !== initialText;
  const hasMarker = targetFileText.includes(expectedMarker);
  if (!changed || !hasMarker) {
    return makeCheckRow(
      id,
      "failed",
      !hasMarker
        ? "The target TextEdit file on disk did not contain the expected saved marker."
        : "The target TextEdit file on disk did not change from its initial contents.",
      metadata,
      { changed, hasMarker, byteLength: Buffer.byteLength(targetFileText, "utf8") },
    );
  }
  return makeCheckRow(
    id,
    "pass",
    "TextEdit saved the expected marker text to disk.",
    metadata,
    { changed, hasMarker, byteLength: Buffer.byteLength(targetFileText, "utf8") },
  );
}

export function evaluateTwoWindowsIsolationCheck({
  metadata,
  targetWindow,
  decoyWindow,
  targetFileText,
  decoyFileBefore = ACCEPTANCE_DECOY_INITIAL_TEXT,
  decoyFileAfter,
  decoyLiveCaptureText = null,
  expectedMarker = ACCEPTANCE_SAVED_TEXT,
  typedToken = ACCEPTANCE_TEXT,
  typedPrefix = ACCEPTANCE_TYPED_PREFIX,
  cursorBefore,
  cursorAfter,
  cursorTolerancePx = DEFAULT_CURSOR_TOLERANCE_PX,
  environmentError = null,
}) {
  const id = "two_windows_isolation_and_cursor";
  const distinctWindows =
    Number.isInteger(targetWindow?.window_id) &&
    targetWindow.window_id > 0 &&
    Number.isInteger(decoyWindow?.window_id) &&
    decoyWindow.window_id > 0 &&
    targetWindow.window_id !== decoyWindow.window_id;
  if (!distinctWindows) {
    return makeCheckRow(
      id,
      "failed",
      "Expected two distinct TextEdit windows (target and decoy).",
      metadata,
      { targetWindowId: targetWindow?.window_id ?? null, decoyWindowId: decoyWindow?.window_id ?? null },
    );
  }
  if (
    (targetWindow?.pid !== undefined || decoyWindow?.pid !== undefined) &&
    (!Number.isInteger(targetWindow?.pid) ||
      targetWindow.pid <= 0 ||
      targetWindow.pid !== decoyWindow?.pid)
  ) {
    return makeCheckRow(
      id,
      "failed",
      "Target and decoy windows did not belong to the same disposable TextEdit process.",
      metadata,
      { targetPid: targetWindow?.pid ?? null, decoyPid: decoyWindow?.pid ?? null },
    );
  }
  if (typeof targetFileText !== "string" || !targetFileText.includes(expectedMarker)) {
    return makeCheckRow(
      id,
      "failed",
      "The target window's file on disk did not contain the expected marker.",
      metadata,
    );
  }
  if (
    typeof decoyFileAfter !== "string" ||
    decoyFileAfter !== decoyFileBefore ||
    decoyFileAfter.includes(typedToken) ||
    (typedPrefix && decoyFileAfter.includes(typedPrefix))
  ) {
    return makeCheckRow(
      id,
      "failed",
      "The decoy window's file on disk changed during target-window actions.",
      metadata,
      { decoyDiskUnchanged: decoyFileAfter === decoyFileBefore },
    );
  }
  if (typeof decoyLiveCaptureText !== "string" || decoyLiveCaptureText.trim().length === 0) {
    return makeCheckRow(
      id,
      "failed",
      "The decoy window's live accessibility capture was missing, so live window isolation could not be verified.",
      metadata,
      { decoyLiveUnchanged: null },
    );
  }
  const expectedDecoyLine = typeof decoyFileBefore === "string" ? decoyFileBefore.trim() : "";
  if (
    decoyLiveCaptureText.includes(typedToken) ||
    (typedPrefix && decoyLiveCaptureText.includes(typedPrefix))
  ) {
    return makeCheckRow(
      id,
      "failed",
      "The decoy window's live accessibility state received text intended for the target window.",
      metadata,
      { decoyLiveUnchanged: false },
    );
  }
  if (expectedDecoyLine.length > 0 && !decoyLiveCaptureText.includes(expectedDecoyLine)) {
    return makeCheckRow(
      id,
      "failed",
      "The decoy window's live accessibility capture did not contain its initial text.",
      metadata,
      { decoyLiveUnchanged: false },
    );
  }
  if (environmentError) {
    return makeCheckRow(id, "environment problem", String(environmentError), metadata, {
      targetWindowId: targetWindow.window_id,
      decoyWindowId: decoyWindow.window_id,
      decoyDiskUnchanged: true,
      decoyLiveUnchanged: true,
    });
  }
  if (!isFinitePoint(cursorBefore) || !isFinitePoint(cursorAfter)) {
    return makeCheckRow(
      id,
      "environment problem",
      "Could not sample host mouse cursor coordinates before and after background actions.",
      metadata,
      { cursorBefore: cursorBefore ?? null, cursorAfter: cursorAfter ?? null },
    );
  }
  const distancePx = Math.hypot(cursorAfter.x - cursorBefore.x, cursorAfter.y - cursorBefore.y);
  if (distancePx > cursorTolerancePx) {
    return makeCheckRow(
      id,
      "failed",
      `Host mouse cursor moved by ${distancePx.toFixed(1)} px during background Computer Use actions (tolerance ${cursorTolerancePx} px).`,
      metadata,
      { cursorBefore, cursorAfter, distancePx: Number(distancePx.toFixed(2)) },
    );
  }
  return makeCheckRow(
    id,
    "pass",
    "Only the target window changed (decoy unchanged on disk and live capture) and the host cursor did not move.",
    metadata,
    {
      targetWindowId: targetWindow.window_id,
      decoyWindowId: decoyWindow.window_id,
      decoyDiskUnchanged: true,
      decoyLiveUnchanged: true,
      cursorBefore,
      cursorAfter,
      distancePx: Number(distancePx.toFixed(2)),
    },
  );
}

export function evaluateStopCleanupCheck({
  metadata,
  observedHelperBeforeStop,
  observedUserStop,
  helpersAfterStop = [],
  helpersAfterQuit = [],
  environmentError = null,
}) {
  const id = "stop_leaves_no_helper";
  if (environmentError) {
    return makeCheckRow(id, "environment problem", String(environmentError), metadata);
  }
  if (!observedHelperBeforeStop) {
    return makeCheckRow(
      id,
      "failed",
      "No packaged Computer Use helper process was observed running before Stop.",
      metadata,
      { observedHelperBeforeStop: false },
    );
  }
  if (!observedUserStop) {
    return makeCheckRow(
      id,
      "failed",
      "No explicit renderer user-Stop event was observed.",
      metadata,
      { observedUserStop: false },
    );
  }
  if (!Array.isArray(helpersAfterStop) || helpersAfterStop.length > 0) {
    return makeCheckRow(
      id,
      "failed",
      `Helper process(es) remained running after Stop: ${helpersAfterStop.map((p) => p?.pid ?? p).join(", ")}.`,
      metadata,
      { helpersAfterStopCount: helpersAfterStop.length },
    );
  }
  if (!Array.isArray(helpersAfterQuit) || helpersAfterQuit.length > 0) {
    return makeCheckRow(
      id,
      "failed",
      `Helper process(es) remained running after Aiden quit: ${helpersAfterQuit.map((p) => p?.pid ?? p).join(", ")}.`,
      metadata,
      { helpersAfterQuitCount: helpersAfterQuit.length },
    );
  }
  return makeCheckRow(
    id,
    "pass",
    "Stop reaped every packaged Computer Use helper while Aiden stayed alive, and none remained after quit.",
    metadata,
    { observedHelperBeforeStop: true, observedUserStop: true, helpersAfterStopCount: 0, helpersAfterQuitCount: 0 },
  );
}

export function evaluateDeniedPermissionCheck({
  metadata,
  deniedResponseText,
  deniedToolResultMissing = false,
  accessGranted,
  targetFileBefore = ACCEPTANCE_TARGET_INITIAL_TEXT,
  targetFileAfter,
  decoyFileBefore = ACCEPTANCE_DECOY_INITIAL_TEXT,
  decoyFileAfter = null,
  targetWindowTextBefore = null,
  targetWindowTextAfter = null,
  deniedMarker = ACCEPTANCE_DENIED_TEXT,
  deniedMarkerPrefix = ACCEPTANCE_TYPED_PREFIX,
  windowProbeError = null,
  environmentError = null,
}) {
  const id = "denied_permission_changes_nothing";
  if (accessGranted === true) {
    return makeCheckRow(
      id,
      "failed",
      "The denied-permission chat unexpectedly recorded an allowed Computer Use grant.",
      metadata,
      { accessGranted: true },
    );
  }
  if (
    typeof targetFileAfter === "string" &&
    (targetFileAfter !== targetFileBefore ||
      targetFileAfter.includes(deniedMarker) ||
      (deniedMarkerPrefix && targetFileAfter.includes(deniedMarkerPrefix)))
  ) {
    return makeCheckRow(
      id,
      "failed",
      "The target TextEdit file on disk changed after a denied permission.",
      metadata,
      { targetDiskUnchanged: false },
    );
  }
  if (
    typeof decoyFileAfter === "string" &&
    (decoyFileAfter !== decoyFileBefore ||
      decoyFileAfter.includes(deniedMarker) ||
      (deniedMarkerPrefix && decoyFileAfter.includes(deniedMarkerPrefix)))
  ) {
    return makeCheckRow(
      id,
      "failed",
      "The decoy TextEdit file on disk changed after a denied permission.",
      metadata,
      { decoyDiskUnchanged: false },
    );
  }
  if (
    typeof targetWindowTextBefore === "string" &&
    typeof targetWindowTextAfter === "string" &&
    (targetWindowTextAfter !== targetWindowTextBefore ||
      targetWindowTextAfter.includes(deniedMarker) ||
      (deniedMarkerPrefix && targetWindowTextAfter.includes(deniedMarkerPrefix)))
  ) {
    return makeCheckRow(
      id,
      "failed",
      "The target TextEdit window content changed after a denied permission.",
      metadata,
      { targetWindowUnchanged: false },
    );
  }
  if (deniedToolResultMissing) {
    return makeCheckRow(
      id,
      "failed",
      "No correlated tool result was received for the denied-permission attempt.",
      metadata,
      { deniedToolResultMissing: true },
    );
  }
  if (environmentError) {
    return makeCheckRow(id, "environment problem", String(environmentError), metadata);
  }
  if (typeof deniedResponseText !== "string" || deniedResponseText.trim().length === 0) {
    return makeCheckRow(
      id,
      "failed",
      "No tool refusal response was observed for the denied-permission attempt.",
      metadata,
    );
  }
  let parsedOk = false;
  let structuredRefusal = false;
  try {
    const parsed = JSON.parse(deniedResponseText);
    parsedOk = parsed?.ok === true;
    structuredRefusal =
      parsed?.ok === false &&
      typeof parsed?.error?.code === "string" &&
      ACCEPTED_DENIAL_ERROR_CODES.has(parsed.error.code);
  } catch {
    // Plain-text refusal is expected.
  }
  if (parsedOk) {
    return makeCheckRow(
      id,
      "failed",
      "A denied Computer Use call unexpectedly reported ok: true.",
      metadata,
      { parsedOk: true },
    );
  }
  const sanitizedResponse = deniedResponseText
    .replaceAll(deniedMarker, "")
    .replaceAll("aiden-cua-denied", "");
  const refusalRecognized =
    structuredRefusal ||
    ACCEPTED_DENIAL_PHRASES.some((phrase) => sanitizedResponse.includes(phrase)) ||
    /\b(?:permission_required|access_denied|approval_denied)\b/u.test(sanitizedResponse);
  if (!refusalRecognized) {
    return makeCheckRow(
      id,
      "failed",
      "The denied-permission tool response did not match an expected Aiden Computer Use denial or permission refusal.",
      metadata,
      { refusalRecognized: false },
    );
  }
  if (typeof targetFileAfter !== "string") {
    return makeCheckRow(
      id,
      "failed",
      "The target TextEdit file on disk was not captured after the denied permission.",
      metadata,
      { targetDiskUnchanged: null },
    );
  }
  if (decoyFileAfter !== null && typeof decoyFileAfter !== "string") {
    return makeCheckRow(
      id,
      "failed",
      "The decoy TextEdit file on disk was not captured after the denied permission.",
      metadata,
      { decoyDiskUnchanged: null },
    );
  }
  if (typeof targetWindowTextBefore !== "string" || typeof targetWindowTextAfter !== "string") {
    const probeNote = windowProbeError ? ` (${windowProbeError})` : "";
    return makeCheckRow(
      id,
      "failed",
      `The target TextEdit window's live text was not captured before and after the denied permission${probeNote}.`,
      metadata,
      { targetWindowUnchanged: null },
    );
  }
  return makeCheckRow(
    id,
    "pass",
    "Denied permission refused the action and left the target window and files unchanged.",
    metadata,
    {
      accessGranted: false,
      refusalRecognized: true,
      targetDiskUnchanged: true,
      decoyDiskUnchanged: decoyFileAfter === null ? null : true,
      targetWindowUnchanged: true,
    },
  );
}

export function applyRunGateFailuresToChecks(
  checkRows,
  {
    issuedCallCount,
    expectedCallCount = ACCEPTANCE_TWO_WINDOW_TOOL_COUNT,
    gateEvidence,
    targetMatched,
    evidence,
  },
) {
  const failuresByCheck = new Map([
    ["textedit_saves_marker", []],
    ["two_windows_isolation_and_cursor", []],
  ]);

  if (issuedCallCount !== expectedCallCount) {
    failuresByCheck
      .get("textedit_saves_marker")
      .push(`Only ${issuedCallCount} of ${expectedCallCount} scripted Computer Use calls were issued.`);
  }
  if (!gateEvidence?.globalEnabled || !gateEvidence?.accessGranted) {
    failuresByCheck
      .get("textedit_saves_marker")
      .push("The operator did not turn on Computer Use and allow the acceptance chat.");
  }
  if (!targetMatched) {
    failuresByCheck
      .get("textedit_saves_marker")
      .push("Computer Use did not bind to the newly launched disposable TextEdit process.");
  }
  if (evidence && !evidence.ok && Array.isArray(evidence.failures)) {
    for (const failure of evidence.failures) {
      const checkId = /decoy/iu.test(failure)
        ? "two_windows_isolation_and_cursor"
        : "textedit_saves_marker";
      failuresByCheck.get(checkId).push(failure);
    }
  }

  return checkRows.map((row) => {
    const added = failuresByCheck.get(row.id) ?? [];
    if (added.length === 0) return row;
    const summary = added.join(" ");
    if (row.status === "pass") {
      return {
        ...row,
        status: "failed",
        detail: summary,
        evidence: { ...(row.evidence ?? {}), gateFailures: added },
      };
    }
    return {
      ...row,
      status: "failed",
      detail: row.detail.includes(summary) ? row.detail : `${row.detail} ${summary}`,
      evidence: { ...(row.evidence ?? {}), gateFailures: added },
    };
  });
}

export function classifyAcceptanceError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (
    /macOS-only|requires macOS \d+\.\d+|host platform is|Could not determine host macOS version/iu.test(
      message,
    )
  ) {
    return "unsupported";
  }
  if (
    /Quit every running Aiden|already running|Could not resolve.*TextEdit|TextEdit process did not start|Disposable TextEdit document did not become readable|Not authorized to send Apple events|\(-1743\)|errAEEventNotPermitted|Automation permission to control TextEdit|Expected exactly one unpacked Aiden macOS package|mkdtemp|permission_required|Accessibility and Screen Recording|missing permissions|ENOENT|No packaged app|Could not (?:parse|sample) host mouse cursor|Host mouse cursor position was not a finite/iu.test(
      message,
    )
  ) {
    return "environment problem";
  }
  return "failed";
}

export function buildUnsupportedRealDesktopReport(metadata, reason) {
  return {
    schemaVersion: 1,
    appVersion: metadata.appVersion,
    driverVersion: metadata.driverVersion,
    macOSVersion: metadata.macOSVersion,
    checks: REAL_DESKTOP_CHECK_IDS.map((id) => makeCheckRow(id, "unsupported", reason, metadata)),
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function evaluateRealDesktopReport(report, requiredIds = REAL_DESKTOP_CHECK_IDS) {
  const failures = [];
  const missingChecks = [];
  const counts = {
    pass: 0,
    failed: 0,
    "environment problem": 0,
    unsupported: 0,
  };

  if (!Array.isArray(requiredIds) || requiredIds.length === 0) {
    return {
      ok: false,
      overallStatus: "failed",
      missingChecks: [],
      failures: ["At least one required check ID must be specified."],
      counts,
    };
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      ok: false,
      overallStatus: "failed",
      missingChecks: [...requiredIds],
      failures: ["Real-desktop acceptance report must be a JSON object."],
      counts,
    };
  }
  for (const field of ["appVersion", "driverVersion", "macOSVersion"]) {
    if (!isNonEmptyString(report[field])) {
      failures.push(`Report metadata is missing required field '${field}'.`);
    }
  }
  if (!Array.isArray(report.checks)) {
    return {
      ok: false,
      overallStatus: "failed",
      missingChecks: [...requiredIds],
      failures: [...failures, "Report must contain a checks array."],
      counts,
    };
  }

  const seen = new Map();
  for (const [index, row] of report.checks.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      failures.push(`Check row ${index} must be an object.`);
      continue;
    }
    if (!isNonEmptyString(row.id)) {
      failures.push(`Check row ${index} is missing a valid id.`);
      continue;
    }
    if (seen.has(row.id)) {
      failures.push(`Duplicate check row for '${row.id}'.`);
      continue;
    }
    seen.set(row.id, row);
    if (!VALID_STATUS_SET.has(row.status)) {
      failures.push(`Check '${row.id}' has invalid status '${String(row.status)}'.`);
    } else {
      counts[row.status] += 1;
    }
    for (const field of ["appVersion", "driverVersion", "macOSVersion"]) {
      if (!isNonEmptyString(row[field])) {
        failures.push(`Check '${row.id}' is missing required version field '${field}'.`);
      } else if (isNonEmptyString(report[field]) && row[field] !== report[field]) {
        failures.push(`Check '${row.id}' field '${field}' does not match report metadata.`);
      }
    }
  }

  for (const requiredId of requiredIds) {
    if (!seen.has(requiredId)) {
      missingChecks.push(requiredId);
      failures.push(`Required check row '${requiredId}' is missing.`);
    }
  }

  let overallStatus = "pass";
  if (failures.length > 0 || missingChecks.length > 0 || counts.failed > 0) {
    overallStatus = "failed";
  } else if (counts.unsupported > 0) {
    overallStatus = "unsupported";
  } else if (counts["environment problem"] > 0) {
    overallStatus = "environment problem";
  } else if (counts.pass !== seen.size || seen.size === 0) {
    overallStatus = "failed";
  }

  return {
    ok: overallStatus === "pass" && failures.length === 0 && missingChecks.length === 0,
    overallStatus,
    missingChecks,
    failures,
    counts,
  };
}

export function renderRealDesktopReport(report, requiredIds = REAL_DESKTOP_CHECK_IDS) {
  const evaluation = evaluateRealDesktopReport(report, requiredIds);
  const rows = Array.isArray(report?.checks) ? report.checks : [];
  const escapeCell = (value) => String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]/gu, " ");
  const lines = [
    "## Computer Use real-desktop acceptance",
    "",
    `- **Overall:** ${evaluation.overallStatus}`,
    `- **App version:** ${escapeCell(report?.appVersion ?? "unavailable")}`,
    `- **Driver version:** ${escapeCell(report?.driverVersion ?? "unavailable")}`,
    `- **macOS version:** ${escapeCell(report?.macOSVersion ?? "unavailable")}`,
    "",
    "| Check | Status | Detail |",
    "| --- | --- | --- |",
    ...rows.map(
      (row) => `| ${escapeCell(row.id)} | ${escapeCell(row.status)} | ${escapeCell(row.detail)} |`,
    ),
  ];
  if (evaluation.missingChecks.length > 0) {
    lines.push("", `Missing required checks (never counted as pass): ${evaluation.missingChecks.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
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

/**
 * Computer Use runs in a chat when the beta is on and the chat was allowed on
 * its access card (or Always allow is on). There is no per-chat toggle.
 */
export function acceptanceGateEvidence(config, chat) {
  const settings = config?.settings;
  return {
    globalEnabled: settings?.computerUseEnabled === true,
    accessGranted:
      settings?.computerUseEnabled === true &&
      (chat?.computerUseAllowed === true || settings?.computerUseAlwaysAllow === true),
  };
}

export function acceptanceFixture(port, capability, now = Date.now()) {
  const providerId = "acceptance-loopback";
  const model = ACCEPTANCE_MODEL;
  const deniedModel = ACCEPTANCE_DENIED_MODEL;
  const chatId = "computer-use-acceptance";
  const deniedChatId = "computer-use-acceptance-denied";
  const workspaceId = "acceptance-workspace";
  const provider = {
    id: providerId,
    kind: "openai",
    label: "Computer Use acceptance loopback",
    baseUrl: acceptanceCapabilityBaseUrl(port, capability),
    models: [model, deniedModel],
    modelMetadata: {
      [model]: { source: "provider", vision: true, toolCall: true },
      [deniedModel]: { source: "provider", vision: true, toolCall: true },
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
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  const deniedChat = {
    id: deniedChatId,
    title: "Computer Use acceptance (denied)",
    workspaceId,
    providerId,
    model: deniedModel,
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
    deniedChat,
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
      {
        id: deniedChat.id,
        title: deniedChat.title,
        workspaceId,
        providerId,
        model: deniedModel,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}
