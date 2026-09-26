import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LiveAudioDeviceFields } from "../settings/live-audio-settings.js";

test("Live settings expose labeled input and output selectors with system defaults", () => {
  const html = renderToStaticMarkup(<LiveAudioDeviceFields value={{ input: "default", output: "default" }} devices={[]} onChange={() => undefined} />);
  assert.match(html, /Live input device/);
  assert.match(html, /Live output device/);
  assert.match(html, /System default/);
  assert.match(html, /replies and start\/stop sounds/);
});

test("Live audio player ownership survives asynchronous capability refresh", () => {
  const source = readFileSync(new URL("./use-assistant-live.ts", import.meta.url), "utf8");
  assert.match(source, /\[audioDependencies\] = React\.useState\(\(\) => defaultDependencies\(false\)\)/);
  assert.match(source, /\.\.\.audioDependencies,\s+geminiLive,/);
});
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantDockPresentation, liveDockClickAction } from "./assistant-dock.js";
import { aidenLiveOrbVisual, AidenLiveOrb } from "./aiden-live-orb.js";
import { assistantLiveOrbState, assistantLiveTranscriptFollowsLatest } from "./assistant-live.js";
import {
  assistantLiveVoiceApprovalDecision,
  assistantLiveVoiceApprovalForReceipt,
  assistantLiveVoiceApprovalFromReceipts,
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
  voiceApprovalReceipts: [],
  latestVoiceApprovalReceiptId: () => 0,
  retainVoiceApprovalReceiptsAfter: () => undefined,
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
  screenShareAvailable: false,
  screenSourceLabel: null,
  screenActive: false,
  screenBusy: false,
  screenError: null,
  setupComplete: true,
  setSetupOpen: () => undefined,
  setMicrophone: () => undefined,
  setComputerUse: async () => undefined,
  requestMicrophonePermission: async () => true,
  prepareComputerUse: async () => undefined,
  chooseScreenSource: async () => undefined,
  releaseScreen: () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
  cancelSetup: async () => undefined,
};

test("duplex visuals remain stable through voice and action changes", () => {
  for (const state of ["listening", "thinking", "speaking", "acting"] as const) {
    assert.equal(aidenLiveOrbVisual(state), "duplex");
    const markup = renderToStaticMarkup(<AidenLiveOrb state={state} level={NaN} />);
    assert.match(markup, /data-visual="duplex"/);
    assert.doesNotMatch(markup, /NaN/);
  }
  assert.equal(aidenLiveOrbVisual("error"), "rest");
  assert.equal(aidenLiveOrbVisual("connecting"), "connecting");
  assert.equal(assistantLiveOrbState({ ...idleLive, active: true, state: "open", microphoneActive: false }), "listening");
  assert.equal(assistantLiveOrbState({ ...idleLive, active: true, busy: true, state: "closing" }), "ready");
});

test("dock requires reveal then stop, including mic-off and first-session startup", () => {
  const active = { ...idleLive, active: true, state: "open" as const };
  assert.equal(liveDockClickAction(active, true, false), "reveal-stop");
  assert.equal(liveDockClickAction(active, true, true), "stop");
  assert.equal(liveDockClickAction(active, false, false), "reveal-stop");
  assert.equal(liveDockClickAction({ ...active, state: "closing", busy: true }, true, true), "none");
  assert.equal(liveDockClickAction({ ...idleLive, busy: true }, true, false), "none");
  assert.equal(liveDockClickAction(idleLive, true, false), "start");
  assert.equal(liveDockClickAction(idleLive, false, false), "setup");
  assert.equal(liveDockClickAction({ ...idleLive, setupComplete: false }, true, false), "settings");
});

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

test("voice approval ignores stale and consumed receipts", () => {
  const receipt = {
    id: 7,
    text: "Allow once",
  };
  assert.equal(assistantLiveVoiceApprovalForReceipt(receipt, 6, false), "allow");
  assert.equal(assistantLiveVoiceApprovalForReceipt(receipt, 7, false), null);
  assert.equal(assistantLiveVoiceApprovalForReceipt(receipt, 6, true), null);
});

test("batched voice receipts are examined FIFO and the earliest exact command wins", () => {
  assert.deepEqual(
    assistantLiveVoiceApprovalFromReceipts(
      [
        { id: 2, text: "Allow once" },
        { id: 3, text: "Deny" },
      ],
      1,
      new Set(),
    ),
    {
      examinedReceiptIds: [2],
      match: { receiptId: 2, decision: "allow" },
    },
  );
  assert.deepEqual(
    assistantLiveVoiceApprovalFromReceipts(
      [
        { id: 2, text: "keep going" },
        { id: 3, text: "Deny" },
      ],
      1,
      new Set(),
    ),
    {
      examinedReceiptIds: [2, 3],
      match: { receiptId: 3, decision: "deny" },
    },
  );
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
  assert.doesNotMatch(dock, /useAssistantLiveApprovals\(/u);
  assert.match(dock, /chat=\{SESSION_ACTIONS\}/u);
  assert.match(dock, /useCommand\("assistant\.open", openPanel, live\.visible\)/u);
  assert.doesNotMatch(dock, /onDecision=/u);
  assert.doesNotMatch(dock, /useAssistantChat/u);
  assert.doesNotMatch(dock, /AssistantPanel|AssistantBubble/u);
});

test("a disabled Live capability renders no dock or setup affordance", () => {
  let commandEnabled = true;
  const markup = renderToStaticMarkup(
    <AssistantDockPresentation
      chat={{ approvals: [], decidingApprovalId: null, decideApproval: async () => undefined }}
      live={{ ...idleLive, visible: false }}
      useCommand={(_commandId, _handler, enabled = true) => {
        commandEnabled = enabled;
      }}
    />,
  );
  assert.equal(markup, "");
  assert.equal(commandEnabled, false);
});

test("a disconnected Live error stays visible and microphone status is screen-reader-only", () => {
  const render = (live: AssistantLiveController) => renderToStaticMarkup(
    <AssistantDockPresentation
      chat={{ approvals: [], decidingApprovalId: null, decideApproval: async () => undefined }}
      live={live}
      useCommand={() => undefined}
    />,
  );
  assert.match(render({ ...idleLive, state: "failed", error: "The Live provider sent an invalid event." }), /The Live provider sent an invalid event\./);
  assert.match(render({ ...idleLive, state: "open", active: true, microphoneActive: true }), /Listening · mic on/);
  assert.match(render({ ...idleLive, state: "open", active: true, microphoneActive: true }), /class="sr-only"/);
});

test("legacy voice approval presentation remains isolated from the direct-action dock", () => {
  const approval = readFileSync(
    new URL("./assistant-computer-use-approval.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(new URL("./use-assistant-live-approvals.ts", import.meta.url), "utf8");
  assert.match(approval, /Say “Allow once” or “Deny\.”/u);
  assert.match(approval, /\{prompt\.summary\}/u);
  assert.doesNotMatch(approval, /<Button|onClick/u);
  assert.match(hook, /receipt\.id <= baselineReceiptId/u);
  assert.match(hook, /latestVoiceApprovalReceiptId\(\)/u);
  assert.match(hook, /consumedReceiptIds/u);
});

test("setup discloses macOS access and direct actions until Stop", () => {
  const live = readFileSync(new URL("./assistant-live.tsx", import.meta.url), "utf8");
  assert.match(live, /Google Live model/u);
  assert.match(live, /Screen and Accessibility/u);
  assert.match(live, /Scheduled tasks/u);
  assert.match(live, /without per-action prompts until you stop/u);
  assert.match(live, /role="log"/u);
  assert.match(live, /aria-live="polite"/u);
});

test("screen sharing is opt-in, source-labelled, and visibly active in the HUD", () => {
  const live = readFileSync(new URL("./assistant-live.tsx", import.meta.url), "utf8");
  assert.match(live, /live\.screenShareAvailable/u);
  assert.match(live, /title="Screen share"/u);
  assert.match(live, /live\.chooseScreenSource/u);
  assert.match(live, /live\.releaseScreen/u);
  assert.match(live, /busy=\{live\.screenBusy \|\| live\.busy\}/u);
  assert.match(live, /disabled=\{live\.screenBusy \|\| live\.busy\}/u);
  assert.match(live, /confirmDisabled=\{!live\.setupComplete \|\| live\.busy \|\| live\.screenBusy/u);
  assert.match(live, /Sharing \{live\.screenSourceLabel \?\? "screen"\}/u);
  assert.match(live, /role="alert"[\s\S]*live\.screenError/u);
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
  assert.match(orb, /state="listening"/u);
  assert.match(orb, /state="weaving"/u);
  assert.doesNotMatch(orb, /Rive|\.riv/u);
  assert.match(styles, /\.aiden-live-orb-canvas[\s\S]*filter:[\s\S]*hue-rotate\(209deg\)/u);
  assert.match(
    styles,
    /\.aiden-live-trigger\[data-kind="orb"\][\s\S]*background: transparent;[\s\S]*box-shadow: none;/u,
  );
  assert.match(packageJson, /"thinking-orbs": "0\.3\.1"/u);
  assert.doesNotMatch(packageJson, /@rive-app/u);
});
