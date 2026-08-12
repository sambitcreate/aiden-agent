import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMImplementation } from "@xmldom/xmldom";
import { Button, Switch } from "../ui.js";
import { AssistantAutomationApproval } from "./assistant-automation-approval.js";
import { AssistantComputerUseApproval } from "./assistant-computer-use-approval.js";
import { AssistantPanel, assistantMinimizeLabel } from "./assistant-panel.js";
import { AssistantDockPresentation } from "./assistant-dock.js";
import { AssistantThread } from "./assistant-thread.js";
import { AssistantLive, AssistantLiveSetupContent } from "./assistant-live.js";
import type { AssistantChat } from "./use-assistant-chat.js";
import type { AssistantLiveController } from "./use-assistant-live.js";

const idleAssistantChat: AssistantChat = {
  messages: [],
  streaming: false,
  streamComplete: false,
  error: null,
  ready: true,
  readiness: "ready",
  canChangeThread: true,
  threads: [],
  activeChatId: null,
  lastNotice: null,
  approvals: [],
  decidingApprovalId: null,
  send: () => undefined,
  stop: () => undefined,
  finishStreamHandoff: () => undefined,
  decideApproval: async () => undefined,
  openThread: () => undefined,
  newThread: () => undefined,
};

const idleLive: AssistantLiveController = {
  visible: true,
  available: true,
  availabilityDetail: "Approved model: gemini-live-reviewed",
  active: false,
  setupOpen: false,
  busy: false,
  microphone: true,
  microphoneActive: false,
  microphonePermission: "granted",
  microphonePermissionReady: true,
  microphonePermissionDetail:
    "Microphone permission is allowed in macOS System Settings.",
  model: "gemini-live-reviewed",
  state: "idle",
  captions: [],
  error: null,
  reconnectRequired: false,
  startBlockedReason: null,
  computerUseEnabled: false,
  computerUseReady: false,
  computerUseConversationAvailable: false,
  computerUseBusy: false,
  computerUseDetail:
    "Turn on the Computer Use beta to make it available in individual chats.",
  computerUseError: null,
  setSetupOpen: () => undefined,
  setMicrophone: () => undefined,
  setComputerUse: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
  cancelSetup: async () => undefined,
};

test("Live setup exposes explicit consent, provider privacy, and fail-closed screen state", () => {
  const html = renderToStaticMarkup(
    <AssistantLiveSetupContent
      live={{
        ...idleLive,
        setupOpen: true,
      }}
    />,
  );
  assert.match(html, /Share microphone/u);
  assert.match(html, /Enable Computer Use for this Assistant conversation/u);
  assert.match(html, /Live cannot declare the tool/u);
  assert.match(html, /Global readiness: Turn on the Computer Use beta/u);
  assert.match(html, /aria-disabled="true"/u);
  assert.doesNotMatch(html, /aria-label="Enable Computer Use[^>]*disabled=""/u);
  assert.match(html, /Screen sharing unavailable/u);
  assert.match(html, /never reconnects automatically/u);
  assert.match(html, /gemini-live-reviewed/u);
  assert.match(html, /focus-visible:ring-\[3px\]/u);
});

test("experimental Live stays visible with truthful availability and microphone gates", () => {
  const unavailableReasons = [
    "Connect Google with an API key in Settings before starting Live.",
    "The connected Google account uses OAuth. Live currently requires a Google API key.",
    "The saved Google API key is not valid for Live. Update it in Settings.",
    "No Google Live model has passed Aiden’s production contract probe yet.",
  ];
  for (const reason of unavailableReasons) {
    const html = renderToStaticMarkup(
      <AssistantLive
        live={{
          ...idleLive,
          available: false,
          availabilityDetail: reason,
          model: null,
          startBlockedReason: reason,
        }}
      />,
    );
    assert.match(html, /Gemini Live/u);
    assert.match(html, /Experimental/u);
    assert.match(
      html,
      new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.match(html, /disabled=""/u);
  }

  const denied = renderToStaticMarkup(
    <AssistantLive
      live={{
        ...idleLive,
        microphonePermission: "denied",
        microphonePermissionReady: false,
        microphonePermissionDetail:
          "Microphone permission is denied. Allow Aiden in System Settings → Privacy & Security → Microphone.",
        startBlockedReason:
          "Microphone permission is denied. Allow Aiden in System Settings → Privacy & Security → Microphone.",
      }}
    />,
  );
  assert.match(denied, /Microphone permission is denied/u);
  assert.match(denied, /disabled=""/u);
});

test("active Live state keeps Stop visible and captions semantic", () => {
  const html = renderToStaticMarkup(
    <AssistantLive
      live={{
        ...idleLive,
        active: true,
        microphoneActive: true,
        state: "open",
        captions: [{ id: 1, direction: "input", final: false, text: "Hello" }],
      }}
    />,
  );
  assert.match(html, /aria-label="Live conversation"/u);
  assert.match(html, / Stop<\/button>/u);
  assert.match(html, /aria-label="Live captions"/u);
  assert.match(html, />You</u);
  assert.match(html, /interim/u);
  assert.match(html, /role="log" aria-live="polite"/u);
  assert.match(html, /focus-visible:ring-\[3px\]/u);
});

test("active Live setup reports microphone startup instead of claiming capture is off", () => {
  const html = renderToStaticMarkup(
    <AssistantLive
      live={{
        ...idleLive,
        active: true,
        busy: true,
        microphoneActive: false,
        state: "open",
      }}
    />,
  );
  assert.match(html, /Starting microphone…/u);
  assert.match(html, /Preparing your microphone…/u);
  assert.doesNotMatch(html, /Microphone off/u);
  assert.doesNotMatch(html, /Start speaking when/u);
});

test("Live start and setup confirmation expose the exact ordinary-response collision", () => {
  for (const reason of [
    "Finish or stop the current Aiden response before starting Live.",
    "Decide the pending automation approval before starting Live.",
  ]) {
    const html = renderToStaticMarkup(
      <AssistantLive
        live={{ ...idleLive, setupOpen: true, startBlockedReason: reason }}
      />,
    );
    assert.match(
      html,
      new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.match(html, /disabled=""[^>]*>.*Start Live|disabled=""[^>]*>Start/u);
  }
});

test("Live blocks minimize with an explicit recovery action", () => {
  assert.equal(
    assistantMinimizeLabel({ ...idleLive, active: true }),
    "Stop Live before minimizing Aiden",
  );
  assert.equal(
    assistantMinimizeLabel({ ...idleLive, setupOpen: true }),
    "Cancel Live setup before minimizing Aiden",
  );
  assert.equal(assistantMinimizeLabel(idleLive), "Minimize Aiden");
});

test("shared controls retain their focus contract while Live opts into a scoped halo", () => {
  const shared = renderToStaticMarkup(
    <>
      <Button>Shared button</Button>
      <Switch aria-label="Shared switch" />
    </>,
  );
  assert.doesNotMatch(shared, /focus-visible:ring-\[3px\]/u);
  assert.match(shared, /focus-visible:outline-none/u);
});

test("mounted dock ignores minimize timers while Live is active and keeps Stop mounted", async () => {
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  body.appendChild(container);
  document.documentElement.appendChild(body);
  const elementPrototype = Object.getPrototypeOf(container) as HTMLElement &
    Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  Object.defineProperty(elementPrototype, "style", {
    configurable: true,
    get: () => ({}),
  });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", { configurable: true, value: body });
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const windowValue = {
    document,
    event: undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (callback: () => void) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  };
  Object.defineProperty(document, "defaultView", {
    configurable: true,
    value: windowValue,
  });
  const keys = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const ElementConstructor = Object.getPrototypeOf(
    document.documentElement,
  ).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowValue },
    document: { configurable: true, value: document },
    navigator: {
      configurable: true,
      value: { userAgent: "assistant-dock-test" },
    },
    Node: { configurable: true, value: ElementConstructor },
    Element: { configurable: true, value: ElementConstructor },
    HTMLElement: { configurable: true, value: ElementConstructor },
  });

  let minimize: () => void = () => undefined;
  let panelUnmounts = 0;
  function FakePanel(props: React.ComponentProps<typeof AssistantPanel>) {
    minimize = props.onMinimize;
    React.useEffect(
      () => () => {
        panelUnmounts += 1;
      },
      [],
    );
    return <button type="button">{props.live.active ? "Stop" : "Idle"}</button>;
  }
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(container);
  try {
    flushSync(() =>
      root.render(
        <AssistantDockPresentation
          chat={idleAssistantChat}
          live={{
            ...idleLive,
            active: true,
            microphoneActive: true,
            state: "open",
          }}
          initiallyOpen
          panelComponent={FakePanel}
          useCommand={() => undefined}
        />,
      ),
    );
    flushSync(() => minimize());
    for (const callback of timers.values()) callback();
    flushSync(() => undefined);
    assert.equal(
      timers.size,
      0,
      "blocked minimize must not schedule the exit timer",
    );
    assert.equal(panelUnmounts, 0, "active Live controls must remain mounted");
    assert.match(container.toString(), />Stop</u);
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("mounted dock gates every conversation action while Live owns the exact Assistant chat", async () => {
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  body.appendChild(container);
  document.documentElement.appendChild(body);
  const elementPrototype = Object.getPrototypeOf(container) as HTMLElement &
    Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  Object.defineProperty(elementPrototype, "style", {
    configurable: true,
    get: () => ({}),
  });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", { configurable: true, value: body });
  const windowValue = {
    document,
    event: undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  Object.defineProperty(document, "defaultView", {
    configurable: true,
    value: windowValue,
  });
  const keys = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const ElementConstructor = Object.getPrototypeOf(
    document.documentElement,
  ).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowValue },
    document: { configurable: true, value: document },
    navigator: {
      configurable: true,
      value: { userAgent: "assistant-thread-gate-test" },
    },
    Node: { configurable: true, value: ElementConstructor },
    Element: { configurable: true, value: ElementConstructor },
    HTMLElement: { configurable: true, value: ElementConstructor },
  });

  const presented = { chat: idleAssistantChat as AssistantChat };
  let newCalls = 0;
  let openCalls = 0;
  function CapturingPanel(props: React.ComponentProps<typeof AssistantPanel>) {
    presented.chat = props.chat;
    return <div />;
  }
  const baseChat: AssistantChat = {
    ...idleAssistantChat,
    activeChatId: "assistant-chat",
    newThread: () => {
      newCalls += 1;
    },
    openThread: () => {
      openCalls += 1;
    },
  };
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(container);
  try {
    const blockedStates: Array<{
      chat: AssistantChat;
      live: AssistantLiveController;
    }> = [
      { chat: baseChat, live: { ...idleLive, setupOpen: true } },
      { chat: baseChat, live: { ...idleLive, busy: true } },
      { chat: baseChat, live: { ...idleLive, active: true, state: "open" } },
      {
        chat: {
          ...baseChat,
          approvals: [
            {
              approvalId: "live-approval",
              toolCallId: "live-call",
              toolName: "computer_use",
              summary: "click exact target",
            },
          ],
        },
        live: idleLive,
      },
    ];
    for (const state of blockedStates) {
      flushSync(() =>
        root.render(
          <AssistantDockPresentation
            chat={state.chat}
            live={state.live}
            initiallyOpen
            panelComponent={CapturingPanel}
            useCommand={() => undefined}
          />,
        ),
      );
      assert.equal(presented.chat.canChangeThread, false);
      presented.chat.newThread();
      presented.chat.openThread("other-assistant-chat");
    }
    assert.equal(newCalls, 0);
    assert.equal(openCalls, 0);

    flushSync(() =>
      root.render(
        <AssistantDockPresentation
          chat={baseChat}
          live={idleLive}
          initiallyOpen
          panelComponent={CapturingPanel}
          useCommand={() => undefined}
        />,
      ),
    );
    presented.chat.newThread();
    presented.chat.openThread("other-assistant-chat");
    assert.equal(newCalls, 1);
    assert.equal(openCalls, 1);
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("New conversation explains the Live ownership block", () => {
  const html = renderToStaticMarkup(
    <AssistantPanel
      chat={{ ...idleAssistantChat, activeChatId: "assistant-chat" }}
      draft=""
      inputRef={React.createRef<HTMLTextAreaElement>()}
      onDraftChange={() => undefined}
      onMinimize={() => undefined}
      live={{ ...idleLive, active: true, state: "open" }}
    />,
  );
  assert.match(
    html,
    /New conversation unavailable: Stop Live before changing conversations/u,
  );
  assert.match(html, /title="Stop Live before changing conversations\."/u);
  assert.match(html, /disabled=""/u);
});

test("Aiden replies use the main chat Markdown renderer", () => {
  const html = renderToStaticMarkup(
    <AssistantThread
      messages={[
        { role: "user", content: "Show me a list" },
        {
          role: "assistant",
          content: "**Key directories**\n\n- `src`\n- `tests`",
        },
      ]}
      streaming={false}
      streamComplete={false}
      onStreamHandoffComplete={() => undefined}
      error={null}
    />,
  );
  assert.match(html, /<strong>Key directories<\/strong>/u);
  assert.match(html, /<ul>/u);
  assert.match(html, /<code[^>]*>src<\/code>/u);
  assert.doesNotMatch(html, /\*\*Key directories\*\*/u);
});

test("Aiden composer reuses chat controls and grows for wrapped multiline drafts", () => {
  const html = renderToStaticMarkup(
    <AssistantPanel
      chat={idleAssistantChat}
      draft={
        "First line\nSecond line\nThird line\nA-very-long-unbroken-value-that-must-wrap"
      }
      inputRef={React.createRef<HTMLTextAreaElement>()}
      onDraftChange={() => undefined}
      onMinimize={() => undefined}
      live={idleLive}
    />,
  );
  assert.match(html, /field-sizing-content/u);
  assert.match(html, /min-h-7/u);
  assert.match(html, /max-h-32/u);
  assert.match(html, /overflow-x-hidden/u);
  assert.match(html, /overflow-y-auto/u);
  assert.match(html, /whitespace-pre-wrap/u);
  assert.match(html, /break-words/u);
  assert.match(html, /wrap="soft"/u);
  assert.match(html, /aria-label="Send message"/u);
  assert.match(html, /First line\nSecond line\nThird line/u);
});

test("automation confirmation shows the approved scope with check and cross actions", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-1",
        toolCallId: "tool-1",
        toolName: "schedule_task",
        summary: "Create Morning brief",
        details: {
          kind: "assistant-automation",
          action: "create",
          name: "Morning brief",
          prompt: "Summarize <private> updates.",
          cron: "0 9 * * *",
          timezone: "UTC",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "read-only",
          workspaceId: null,
          workspaceName: null,
          mcpServerIds: [],
          mcpServerNames: [],
          providerId: "local-provider",
          providerName: "Local Provider",
          model: "local-model",
          modelName: "Local Model",
          schedulerEnabled: false,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /aria-label="Decline automation"/u);
  assert.match(html, /aria-label="Confirm automation"/u);
  assert.match(html, /Every day at 9:00 AM/u);
  assert.match(html, />Read-only</u);
  assert.match(html, /saved but will not run/u);
  assert.match(
    html,
    /Runs with Local Provider \(local-provider\) · Local Model \(local-model\) while Aiden is open/u,
  );
  assert.match(html, /Summarize &lt;private&gt; updates\./u);
  assert.doesNotMatch(html, /0 9 \* \* \*/u);
  assert.doesNotMatch(html, /No project|Notifications on|MCP:/u);
  assert.doesNotMatch(html, /<private>/u);
});

test("Live Computer Use confirmation is exact-action Allow once with Deny first", () => {
  const html = renderToStaticMarkup(
    <AssistantComputerUseApproval
      prompt={{
        approvalId: "live-approval",
        toolCallId: "live-call",
        toolName: "computer_use",
        summary: 'click element 2 — "Notes", pid 7, window 11',
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /Allow this Computer Use action/u);
  assert.match(html, /aria-label="Deny Computer Use action"/u);
  assert.match(html, /aria-label="Allow this Computer Use action once"/u);
  assert.match(html, /current captured target/u);
  assert.ok(
    html.indexOf("Deny Computer Use action") <
      html.indexOf("Allow this Computer Use action once"),
  );
});

test("Full automation confirmation names the project and write scope", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-full",
        toolCallId: "tool-full",
        toolName: "schedule_task",
        summary: "Update report",
        details: {
          kind: "assistant-automation",
          action: "create",
          name: "Update report",
          prompt: "Update the project report.",
          cron: "0 9 * * *",
          timezone: "UTC",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "full",
          workspaceId: "workspace-1",
          workspaceName: "Website",
          mcpServerIds: [],
          mcpServerNames: [],
          providerId: "local-provider",
          providerName: "Local Provider",
          model: "local-model",
          modelName: "Local Model",
          schedulerEnabled: true,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /Full access · Website/u);
  assert.match(html, /Can edit files and run commands in Website/u);
  assert.doesNotMatch(html, /Notifications on/u);
});

test("MCP automation confirmation names the exact unattended connector scope", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-mcp",
        toolCallId: "tool-mcp",
        toolName: "schedule_task",
        summary: "Create Morning email brief",
        details: {
          kind: "assistant-automation",
          action: "create",
          name: "Morning email brief",
          prompt: "Summarize new email.",
          cron: "0 9 * * *",
          timezone: "UTC",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "full",
          workspaceId: null,
          workspaceName: null,
          mcpServerIds: ["personal-gmail", "work-gmail"],
          mcpServerNames: ["Gmail", "Gmail"],
          providerId: "local-provider",
          providerName: "Local Provider",
          model: "local-model",
          modelName: "Local Model",
          schedulerEnabled: true,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /aria-label="Decline Full access automation"/u);
  assert.match(html, /aria-label="Confirm Full access automation"/u);
  assert.match(
    html,
    />Full access · MCP: Gmail \(personal-gmail\), Gmail \(work-gmail\)</u,
  );
  assert.match(
    html,
    /Can call Gmail \(personal-gmail\), Gmail \(work-gmail\) unattended/u,
  );
});

test("automation edits use a save confirmation and describe paused state truthfully", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-edit",
        toolCallId: "tool-edit",
        toolName: "edit_automation",
        summary: "Edit Morning email brief",
        details: {
          kind: "assistant-automation",
          action: "edit",
          taskId: "task-1",
          enabled: false,
          name: "Morning email brief",
          prompt: "Summarize new email.",
          cron: "0 9 * * *",
          timezone: "America/New_York",
          nextRunAt: 1_800_000_000_000,
          notify: true,
          mode: "llm",
          permission: "full",
          workspaceId: null,
          workspaceName: null,
          mcpServerIds: ["gmail"],
          mcpServerNames: ["Gmail"],
          providerId: "local-provider",
          providerName: "Local Provider",
          model: "local-model",
          modelName: "Local Model",
          schedulerEnabled: true,
        },
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /Save these changes\?/u);
  assert.match(html, /aria-label="Decline Full access automation changes"/u);
  assert.match(html, /aria-label="Confirm Full access automation changes"/u);
  assert.match(html, /Remains paused/u);
  assert.doesNotMatch(html, /Create this automation|Next run:/u);
});

test("automation confirmation fails closed when normalized details are missing", () => {
  const html = renderToStaticMarkup(
    <AssistantAutomationApproval
      prompt={{
        approvalId: "approval-invalid",
        toolCallId: "tool-invalid",
        toolName: "schedule_task",
        summary: "Create something else",
      }}
      deciding={false}
      onDecision={() => undefined}
    />,
  );
  assert.match(html, /invalid and cannot be confirmed/u);
  assert.match(html, /aria-label="Confirm automation"[^>]*disabled=""/u);
  assert.doesNotMatch(html, /Create something else/u);
});
