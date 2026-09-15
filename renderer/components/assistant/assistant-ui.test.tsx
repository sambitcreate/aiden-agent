import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assistantLiveOrbState, assistantLiveTranscriptFollowsLatest } from "./assistant-live.js";
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
  computerUseReady: true,
  computerUseConversationAvailable: true,
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

test("Gemini Live orb state prioritizes errors, approvals, and connection work", () => {
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

test("Live transcript follows only when the viewport remains near the latest turn", () => {
  assert.equal(assistantLiveTranscriptFollowsLatest(1_000, 776, 200), true);
  assert.equal(assistantLiveTranscriptFollowsLatest(1_000, 700, 200), false);
});

test("dock replaces the retired Assistant panel with setup logo then Live orb", () => {
  const dock = readFileSync(new URL("./assistant-dock.tsx", import.meta.url), "utf8");
  assert.match(dock, /data-kind=\{setupCompleted \? "orb" : "logo"\}/u);
  assert.match(dock, /GEMINI_LIVE_SETUP_COMPLETE_KEY/u);
  assert.match(
    dock,
    /if \(!live\.active \|\| !live\.microphoneActive \|\| setupCompleted\) return/u,
  );
  assert.match(dock, /AssistantLiveSetupDialog/u);
  assert.match(dock, /AidenLiveOrb/u);
  assert.doesNotMatch(dock, /AssistantPanel|AssistantBubble/u);
});

test("setup discloses macOS access and per-action approval", () => {
  const live = readFileSync(new URL("./assistant-live.tsx", import.meta.url), "utf8");
  assert.match(live, /Google Live model/u);
  assert.match(live, /Screen and Accessibility/u);
  assert.match(live, /Scheduled tasks/u);
  assert.match(live, /still require Allow once/u);
});

test("the Live orb maps all eight states onto the shared Libraries.dev orb", () => {
  const orb = readFileSync(new URL("./aiden-live-orb.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const packageJson = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
  for (const state of [
    "ready",
    "connecting",
    "listening",
    "thinking",
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
  assert.match(packageJson, /"thinking-orbs": "0\.3\.1"/u);
  assert.doesNotMatch(packageJson, /@rive-app/u);
});
