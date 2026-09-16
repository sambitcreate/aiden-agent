import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assistantLiveOrbState, assistantLiveTranscriptFollowsLatest } from "./assistant-live.js";
import {
  assistantLiveVoiceApprovalDecision,
  assistantLiveVoiceApprovalForCaption,
} from "./use-assistant-live-approvals.js";
import type { AssistantLiveController } from "./use-assistant-live.js";

const idleLive: AssistantLiveController = {
  visible: true,
  available: true,
  availabilityDetail: "Approved model: gemini-live-reviewed",
  active: false,
  setupOpen: false,
  busy: false,
  microphone: true,
  microphoneActive: false,
  microphoneLevel: 0,
  microphonePermission: "granted",
  microphonePermissionReady: true,
  microphonePermissionDetail: "Microphone permission is allowed.",
  model: "gemini-live-reviewed",
  state: "idle",
  captions: [],
  error: null,
  reconnectRequired: false,
  startBlockedReason: null,
  computerUseEnabled: true,
  computerUseActing: false,
  computerUseReady: true,
  computerUseBusy: false,
  computerUseDetail: "Ready",
  computerUsePermissions: { accessibility: true, screenRecording: true },
  computerUseError: null,
  setupComplete: true,
  setSetupOpen: () => undefined,
  setMicrophone: () => undefined,
  setComputerUse: async () => undefined,
  requestMicrophonePermission: async () => true,
  prepareComputerUse: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
  cancelSetup: async () => undefined,
};

test("Aiden Live orb state prioritizes errors, approvals, and connection work", () => {
  assert.equal(assistantLiveOrbState(idleLive), "ready");
  assert.equal(
    assistantLiveOrbState({ ...idleLive, active: true, state: "open", microphoneActive: true }),
    "listening",
  );
  assert.equal(
    assistantLiveOrbState({ ...idleLive, active: true, state: "connecting", busy: true }),
    "connecting",
  );
  assert.equal(assistantLiveOrbState({ ...idleLive, active: true }, true), "approval");
  assert.equal(
    assistantLiveOrbState({ ...idleLive, active: true, computerUseActing: true }),
    "acting",
  );
  assert.equal(assistantLiveOrbState({ ...idleLive, error: "Disconnected" }), "error");
  assert.equal(
    assistantLiveOrbState({ ...idleLive, available: false, setupComplete: false }),
    "unavailable",
  );
});

test("a final user caption moves the active orb to thinking", () => {
  assert.equal(
    assistantLiveOrbState({
      ...idleLive,
      active: true,
      state: "open",
      microphoneActive: true,
      captions: [{ id: 1, direction: "input", text: "Open settings", final: true, sealed: false }],
    }),
    "thinking",
  );
});

test("an active output caption moves the orb to speaking", () => {
  assert.equal(
    assistantLiveOrbState({
      ...idleLive,
      active: true,
      state: "open",
      microphoneActive: true,
      captions: [{ id: 1, direction: "output", text: "Opening Settings", final: false, sealed: false }],
    }),
    "speaking",
  );
});

test("Live transcript follows only when the viewport remains near the latest turn", () => {
  assert.equal(assistantLiveTranscriptFollowsLatest(1_000, 776, 200), true);
  assert.equal(assistantLiveTranscriptFollowsLatest(1_000, 700, 200), false);
});

test("voice approvals accept only the two explicit finalized command phrases", () => {
  assert.equal(assistantLiveVoiceApprovalDecision("Allow once."), "allow");
  assert.equal(assistantLiveVoiceApprovalDecision("  DENY! "), "deny");
  assert.equal(assistantLiveVoiceApprovalDecision("allow"), null);
  assert.equal(assistantLiveVoiceApprovalDecision("yes, allow once"), null);
  assert.equal(assistantLiveVoiceApprovalDecision("do not deny"), null);
});

test("voice approval ignores stale, model-spoken, interim, and consumed captions", () => {
  const caption = {
    id: 7,
    direction: "input" as const,
    final: true,
    sealed: false,
    text: "Allow once",
  };
  assert.equal(assistantLiveVoiceApprovalForCaption(caption, 6, false), "allow");
  assert.equal(assistantLiveVoiceApprovalForCaption(caption, 7, false), null);
  assert.equal(
    assistantLiveVoiceApprovalForCaption({ ...caption, direction: "output" }, 6, false),
    null,
  );
  assert.equal(assistantLiveVoiceApprovalForCaption({ ...caption, final: false }, 6, false), null);
  assert.equal(assistantLiveVoiceApprovalForCaption(caption, 6, true), null);
});

test("dock replaces the retired Assistant panel with setup logo then Live orb", () => {
  const dock = readFileSync(new URL("./assistant-dock.tsx", import.meta.url), "utf8");
  assert.match(dock, /data-kind=\{setupCompleted \? "orb" : "logo"\}/u);
  assert.match(dock, /AIDEN_LIVE_SETUP_COMPLETE_KEY/u);
  assert.match(
    dock,
    /if \(!live\.active \|\| !live\.microphoneActive \|\| setupCompleted\) return/u,
  );
  assert.match(dock, /AssistantLiveSetupDialog/u);
  assert.match(dock, /AidenLiveOrb/u);
  assert.match(dock, /AssistantComputerUseApproval/u);
  assert.match(dock, /useAssistantLiveApprovals\(live\.captions\)/u);
  assert.doesNotMatch(dock, /onDecision=/u);
  assert.doesNotMatch(dock, /useAssistantChat/u);
  assert.doesNotMatch(dock, /AssistantPanel|AssistantBubble/u);
});

test("Computer Use approvals are voice-only and keep the exact action visible", () => {
  const approval = readFileSync(
    new URL("./assistant-computer-use-approval.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(new URL("./use-assistant-live-approvals.ts", import.meta.url), "utf8");
  assert.match(approval, /Say “Allow once” or “Deny\.”/u);
  assert.match(approval, /\{prompt\.summary\}/u);
  assert.doesNotMatch(approval, /<Button|onClick/u);
  assert.match(hook, /caption\.direction !== "input"/u);
  assert.match(hook, /caption\.id <= baselineCaptionId/u);
  assert.match(hook, /latestInputCaptionId\(captionsRef\.current\)/u);
  assert.match(hook, /consumedCaptionIds/u);
});

test("setup discloses macOS access and per-action approval", () => {
  const live = readFileSync(new URL("./assistant-live.tsx", import.meta.url), "utf8");
  assert.match(live, /Google Live model/u);
  assert.match(live, /Screen and Accessibility/u);
  assert.match(live, /Scheduled tasks/u);
  assert.match(live, /still require Allow once/u);
  assert.match(live, /role="log"/u);
  assert.match(live, /aria-live="polite"/u);
});

test("Aiden Live is visibly marked beta in setup and settings", () => {
  const setup = readFileSync(new URL("./assistant-live.tsx", import.meta.url), "utf8");
  const settings = readFileSync(
    new URL("../settings/gemini-live-settings.tsx", import.meta.url),
    "utf8",
  );
  assert.match(setup, /<Badge color="blue">Beta<\/Badge>/u);
  assert.match(settings, /<Badge color="blue">Beta<\/Badge>/u);
  assert.match(settings, /Availability and\s+supported actions may change during beta\./u);
});

test("the Live orb maps all user-visible states onto the shared Libraries.dev orb", () => {
  const orb = readFileSync(new URL("./aiden-live-orb.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const packageJson = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
  for (const state of [
    "ready",
    "connecting",
    "listening",
    "thinking",
    "speaking",
    "acting",
    "approval",
    "error",
    "unavailable",
  ]) {
    assert.match(orb, new RegExp(`\\b${state}\\b`, "u"));
  }
  assert.match(orb, /import \{ AidenOrb \} from "\.\.\/aiden-orb"/u);
  assert.match(orb, /listening: \{ state: "breathing", active: true \}/u);
  assert.doesNotMatch(orb, /Rive|\.riv/u);
  assert.match(styles, /\.aiden-live-orb-canvas[\s\S]*filter:[\s\S]*hue-rotate\(209deg\)/u);
  assert.match(
    styles,
    /\.aiden-live-trigger\[data-kind="orb"\][\s\S]*background: transparent;[\s\S]*box-shadow: none;/u,
  );
  assert.match(packageJson, /"thinking-orbs": "0\.3\.1"/u);
  assert.doesNotMatch(packageJson, /@rive-app/u);
});
