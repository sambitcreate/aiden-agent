import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { LiveActivityStore } from "../../../../renderer/lib/live-activity.js";
import { LiveAppControlController } from "../../../../renderer/lib/live-app-control.js";
import { LiveSessionBus } from "../../../../renderer/lib/live-session-bus.js";
import { LIVE_APP_CONTROL_RENDERER_TOOL } from "../../../../renderer/shared/live-app-control.js";
import type { RendererDocumentOwner } from "../../renderer-document-owner.js";
import { LiveRendererToolBroker, type LiveToolResponse } from "../live-tools.js";
import { createAidenAppControlToolFactory } from "./factory.js";
import { AidenAppControlProvider, AidenWindowInspectedError, type AidenWindowPort } from "./provider.js";

// A happy-dom page behind a fake DevTools port: the accessibility tree and
// DOM snapshot are read from the live document, and Runtime.callFunctionOn
// really runs main's page function on the element.
class FakeWindowPort implements AidenWindowPort {
  readonly window = new Window({ url: "http://localhost/" });
  readonly document = this.window.document as unknown as Document;
  inspected = false;
  closed = false;
  /** Holds the next call of this method until released. */
  gate: { method: string; opened: Promise<void> } | null = null;
  private readonly ids = new Map<Element, number>();
  private readonly elements = new Map<number, Element>();
  private readonly navigation = new Set<() => void>();

  constructor(html: string) {
    this.document.title = "Aiden";
    this.document.body.innerHTML = html;
  }

  navigate(): void {
    for (const listener of [...this.navigation]) listener();
  }

  onNavigate(listener: () => void): () => void {
    this.navigation.add(listener);
    return () => this.navigation.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  private id(element: Element): number {
    let id = this.ids.get(element);
    if (id === undefined) {
      id = this.ids.size + 1;
      this.ids.set(element, id);
      this.elements.set(id, element);
    }
    return id;
  }

  private walk(): Element[] {
    const out: Element[] = [];
    const visit = (element: Element) => {
      out.push(element);
      for (const child of Array.from(element.children)) visit(child);
    };
    visit(this.document.documentElement);
    return out;
  }

  private role(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === "html") return "RootWebArea";
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "ComboBoxSelect";
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (tag === "input") {
      const type = element.getAttribute("type") ?? "text";
      return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox";
    }
    return "generic";
  }

  private axTree() {
    const elements = this.walk();
    return {
      nodes: elements.map((element) => {
        const role = this.role(element);
        const field = element as HTMLInputElement;
        const name =
          role === "RootWebArea"
            ? this.document.title
            : (element.getAttribute("aria-label") ?? (role === "generic" ? "" : (element.textContent ?? "").trim()));
        const checked = element.getAttribute("aria-checked") ?? (field.type === "checkbox" ? String(field.checked) : null);
        return {
          nodeId: `ax${this.id(element)}`,
          backendDOMNodeId: this.id(element),
          ...(element.parentElement ? { parentId: `ax${this.id(element.parentElement)}` } : {}),
          ...(element.hasAttribute("hidden") ? { ignored: true } : {}),
          role: { type: "role", value: role },
          name: { type: "computedString", value: name },
          ...("value" in field && typeof field.value === "string" && role === "textbox" ? { value: { type: "string", value: field.value } } : {}),
          properties: [
            ...(checked !== null ? [{ name: "checked", value: { type: "tristate", value: checked } }] : []),
            ...(this.document.activeElement === element ? [{ name: "focused", value: { type: "booleanOrUndefined", value: true } }] : []),
          ],
          childIds: Array.from(element.children).map((child) => `ax${this.id(child)}`),
        };
      }),
    };
  }

  private domSnapshot() {
    const elements = this.walk();
    const strings: string[] = [];
    const string = (value: string) => {
      const at = strings.indexOf(value);
      return at >= 0 ? at : strings.push(value) - 1;
    };
    return {
      strings,
      documents: [
        {
          nodes: {
            parentIndex: elements.map((element) => (element.parentElement ? elements.indexOf(element.parentElement) : -1)),
            nodeName: elements.map((element) => string(element.localName.toUpperCase())),
            backendNodeId: elements.map((element) => this.id(element)),
            attributes: elements.map((element) =>
              Array.from(element.attributes).flatMap((attribute) => [string(attribute.name), string(attribute.value)]),
            ),
          },
          layout: { nodeIndex: elements.map((_, index) => index), bounds: elements.map((_, index) => [0, index, 100, 20]) },
        },
      ],
    };
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.inspected) throw new AidenWindowInspectedError();
    if (this.gate?.method === method) {
      const gate = this.gate;
      this.gate = null;
      await gate.opened;
    }
    switch (method) {
      case "Accessibility.getFullAXTree":
        return this.axTree();
      case "DOMSnapshot.captureSnapshot":
        return this.domSnapshot();
      case "Page.getLayoutMetrics":
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1200, clientHeight: 800 } };
      case "DOM.resolveNode": {
        const element = this.elements.get(params.backendNodeId as number);
        if (!element?.isConnected) throw new Error("No node with given id found");
        return { object: { objectId: `o${params.backendNodeId}` } };
      }
      case "Runtime.callFunctionOn": {
        const element = this.elements.get(Number(String(params.objectId).slice(1)));
        const fn = new Function(`return (${String(params.functionDeclaration)})`)() as (this: Element, request: unknown) => unknown;
        const argument = (params.arguments as Array<{ value: unknown }>)[0]!.value;
        return { result: { value: JSON.parse(JSON.stringify(fn.call(element!, argument))) } };
      }
      case "Runtime.releaseObject":
        return {};
      default:
        throw new Error(`Unexpected ${method}`);
    }
  }
}

const PROMPT = /^Ask the user to say confirm or tap Confirm/u;

function harness(
  html: string,
  options: { confirmTimeoutMs?: number; maxActions?: number; sessionCalls?: number; refusePrompts?: boolean } = {},
) {
  const port = new FakeWindowPort(html);
  const bus = new LiveSessionBus();
  const notes: string[] = [];
  const noteWaiters: Array<() => void> = [];
  const broker: LiveRendererToolBroker = new LiveRendererToolBroker("s1", (request) => {
    if (request.type === "tool_request") void bus.runToolRequest(request);
    else bus.cancelToolRequest(request.sessionId, request.requestId);
  });
  bus.setSession("s1", {
    toolResult: async (_sessionId, requestId, response) => broker.resolve(requestId, response),
    note: async (_sessionId, text) => {
      // Live's note queue can refuse a note; a refused prompt leaves tap only.
      if (options.refusePrompts && PROMPT.test(text)) return false;
      notes.push(text);
      for (const waiter of noteWaiters.splice(0)) waiter();
      return true;
    },
  });
  const activity = new LiveActivityStore();
  const controller = new LiveAppControlController({
    bus,
    activity,
    lingerMs: 0,
    confirmTimeoutMs: options.confirmTimeoutMs ?? 5_000,
    maxActions: options.maxActions,
  });
  bus.registerTool(LIVE_APP_CONTROL_RENDERER_TOOL, controller.handle);
  const opened: string[] = [];
  const provider = new AidenAppControlProvider({
    port,
    renderer: broker,
    open: async (place) => {
      opened.push(place);
      return { status: "opened" };
    },
    settleMs: 0,
    idleMs: 1,
    sessionCalls: options.sessionCalls,
  });
  let sequence = 0;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    provider.handle(
      { id: `c${++sequence}`, name, args },
      { sessionId: "s1", owner: {} as RendererDocumentOwner, signal: new AbortController().signal },
    );
  const look = async () => String(((await call("look_at_aiden")) as { screen: string }).screen);
  /** The number of the first listed element whose line includes `text`. */
  const ref = async (text: string) => {
    const line = (await look()).split("\n").find((entry) => /^\d+ /u.test(entry) && entry.includes(text));
    assert.ok(line, `${text} is listed`);
    return Number(line.split(" ")[0]);
  };
  /** Resolves with the first note (already sent or still to come) after `from` that matches. */
  const noteMatching = async (pattern: RegExp, from = 0): Promise<string> => {
    for (;;) {
      const found = notes.slice(from).find((text) => pattern.test(text));
      if (found) return found;
      await new Promise<void>((resolve) => noteWaiters.push(resolve));
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const say = (text: string) => bus.publishVoiceInput(text);
  const dispose = () => {
    provider.close();
    broker.close();
    controller.dispose();
  };
  return { port, document: port.document, activity, controller, provider, opened, notes, call, look, ref, noteMatching, settle, say, dispose };
}

function code(response: LiveToolResponse): unknown {
  return (response.error as { code?: unknown } | undefined)?.code;
}

test("a press acts on the live page by its number and returns a fresh look with what is new", async () => {
  const h = harness(`<main><h1>Home</h1><button id="open">Open settings</button></main>`);
  try {
    h.document.getElementById("open")!.addEventListener("click", () => {
      const back = h.document.createElement("button");
      back.textContent = "Back to app";
      h.document.body.append(back);
    });
    const screen = await h.look();
    assert.match(screen, /^# Home$/mu);
    const response = await h.call("use_aiden", { element: await h.ref("Open settings"), action: "press" });
    assert.equal(response.ok, true);
    assert.equal(response.result, "Pressed “Open settings”.");
    assert.match(String(response.screen), /button “Back to app” \(new\)/u);
    assert.equal(h.controller.get().acting, true, "the outline shows while Live acts");
  } finally {
    h.dispose();
  }
});

test("numbers expire on the next look and after a navigation", async () => {
  const h = harness(`<button>Chats</button><button>Settings</button>`);
  try {
    const settings = await h.ref("Settings");
    h.port.navigate();
    assert.equal(code(await h.call("use_aiden", { element: settings, action: "press" })), "stale_element");
    await h.look();
    h.document.querySelector("button")!.remove();
    await h.look();
    // "Settings" is now number 1; the old number 2 is gone with the old look.
    assert.equal(code(await h.call("use_aiden", { element: 2, action: "press" })), "stale_element");
    assert.equal(code(await h.call("use_aiden", { element: 1, action: "jump" })), "invalid_arguments");
  } finally {
    h.dispose();
  }
});

test("controls only the user may use are refused with a fixed error, even when they became guarded after the look", async () => {
  const h = harness(`
    <div data-live-guard="you"><button id="allow">Allow</button></div>
    <div id="later"><button id="usage" role="switch" aria-checked="true">Usage data</button></div>
    <input id="key" type="password" aria-label="API key">
    <textarea id="note" aria-label="Message"></textarea>`);
  try {
    let pressed = 0;
    for (const id of ["allow", "usage"]) h.document.getElementById(id)!.addEventListener("click", () => (pressed += 1));
    const screen = await h.look();
    assert.match(screen, /button “Allow” \(only you can use this\)/u);
    assert.deepEqual(await h.call("use_aiden", { element: await h.ref("Allow"), action: "press" }), {
      ok: false,
      error: { code: "user_only", message: "Only the user can use this. Ask them to do it themselves." },
    });
    const usage = await h.ref("Usage data");
    h.document.getElementById("later")!.setAttribute("data-live-guard", "you");
    assert.equal(code(await h.call("use_aiden", { element: usage, action: "toggle" })), "user_only");
    assert.equal(pressed, 0, "nothing was pressed");
    assert.equal(code(await h.call("use_aiden", { element: await h.ref("API key"), action: "type", text: "sk-1" })), "user_only");
    assert.equal((h.document.getElementById("key") as HTMLInputElement).value, "");
    const typed = await h.call("use_aiden", { element: await h.ref("Message"), action: "type", text: "Hello from Live" });
    assert.equal(typed.ok, true);
    assert.equal((h.document.getElementById("note") as HTMLTextAreaElement).value, "Hello from Live");
  } finally {
    h.dispose();
  }
});

test("a guarded control waits for the user's own spoken confirm after the prompt, acts once and tells Live", async () => {
  const h = harness(`<div role="alertdialog" aria-label="Delete chat?"><button id="delete" data-live-guard="confirm">Delete</button></div>`);
  try {
    let deleted = 0;
    h.document.getElementById("delete")!.addEventListener("click", () => (deleted += 1));
    h.say("confirm"); // Spoken before the prompt: it can't answer it.
    const waiting = await h.call("use_aiden", { element: await h.ref("Delete"), action: "press" });
    assert.equal(waiting.status, "waiting_for_user");
    assert.equal(deleted, 0);
    const shown = h.activity.get();
    assert.equal(shown?.kind, "confirm");
    assert.equal(shown?.kind === "confirm" ? shown.label : "", "Delete chat? — “Delete”");
    assert.match(await h.noteMatching(PROMPT), /Delete chat\? — “Delete”/u, "Live is told to ask");
    assert.equal(code(await h.call("use_aiden", { element: 1, action: "press" })), "waiting_for_user");
    h.say("Yes, do it!");
    assert.match(await h.noteMatching(/^The user confirmed/u), /^The user confirmed\. Pressed “Delete”\./u);
    assert.equal(deleted, 1);
    assert.equal(h.activity.get()?.kind === "confirm", false, "the confirm prompt is gone");
    // The OK was used up: a second confirm phrase or a late tap acts on nothing.
    h.say("confirm");
    if (shown?.kind === "confirm") shown.confirm();
    await h.settle();
    assert.equal(deleted, 1);
  } finally {
    h.dispose();
  }
});

test("a guarded control is refused on Cancel, on other speech, on Escape and when nobody answers", async () => {
  for (const answer of ["tap cancel", "other speech", "escape", "timeout"] as const) {
    const h = harness(`<button id="out" data-live-guard="confirm">Sign out</button>`, { confirmTimeoutMs: 40 });
    try {
      let pressed = 0;
      h.document.getElementById("out")!.addEventListener("click", () => (pressed += 1));
      assert.equal((await h.call("use_aiden", { element: await h.ref("Sign out"), action: "press" })).status, "waiting_for_user");
      await h.noteMatching(PROMPT);
      const shown = h.activity.get();
      if (answer === "tap cancel" && shown?.kind === "confirm") shown.cancel();
      if (answer === "other speech") h.say("Actually what's the weather like?");
      if (answer === "escape") h.controller.userInput({ type: "keydown", key: "Escape", isTrusted: true });
      const outcome = await h.noteMatching(/was not used/u);
      assert.equal(pressed, 0, answer);
      assert.match(outcome, answer === "timeout" ? /didn't answer in time/u : /didn't confirm/u, answer);
      assert.equal(h.activity.get(), null, answer);
    } finally {
      h.dispose();
    }
  }
});

test("a refused prompt leaves Confirm by tap only, and a page change drops the pending OK", async () => {
  const h = harness(`<button id="out" data-live-guard="confirm">Sign out</button>`, { refusePrompts: true });
  try {
    let pressed = 0;
    h.document.getElementById("out")!.addEventListener("click", () => (pressed += 1));
    assert.equal((await h.call("use_aiden", { element: await h.ref("Sign out"), action: "press" })).status, "waiting_for_user");
    await h.settle();
    h.say("confirm");
    await h.settle();
    assert.equal(pressed, 0, "speech can't answer a prompt Live never got");
    const shown = h.activity.get();
    assert.equal(shown?.kind, "confirm");
    if (shown?.kind === "confirm") shown.confirm();
    await h.noteMatching(/^The user confirmed/u);
    assert.equal(pressed, 1);

    const before = h.notes.length;
    assert.equal((await h.call("use_aiden", { element: await h.ref("Sign out"), action: "press" })).status, "waiting_for_user");
    const second = h.activity.get();
    h.port.navigate();
    assert.match(await h.noteMatching(/was not used/u, before), /^The page changed before the user answered/u);
    assert.equal(h.activity.get(), null);
    if (second?.kind === "confirm") second.confirm();
    await h.settle();
    assert.equal(pressed, 1, "nothing acts after the page changed");
  } finally {
    h.dispose();
  }
});

test("Live takes at most 30 actions per request; the user's next words start a new count", async () => {
  const h = harness(`<button id="b">More</button>`);
  try {
    for (let step = 0; step < 30; step += 1) {
      assert.equal((await h.call("use_aiden", { element: await h.ref("More"), action: "press" })).ok, true, `step ${step + 1}`);
    }
    const capped = await h.call("use_aiden", { element: await h.ref("More"), action: "press" });
    assert.equal(code(capped), "action_limit");
    h.say("Keep going");
    assert.equal((await h.call("use_aiden", { element: await h.ref("More"), action: "press" })).ok, true);
  } finally {
    h.dispose();
  }
});

test("the user's own input takes over at once; Live's untrusted events never do", async () => {
  const h = harness(`<button id="go">Go</button>`);
  try {
    let pressed = 0;
    h.document.getElementById("go")!.addEventListener("click", () => (pressed += 1));
    const go = await h.ref("Go");
    let release!: () => void;
    h.port.gate = { method: "DOM.resolveNode", opened: new Promise<void>((resolve) => (release = resolve)) };
    const pending = h.call("use_aiden", { element: go, action: "press" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.activity.get()?.kind, "acting");
    h.controller.userInput({ type: "pointerdown", isTrusted: false });
    assert.equal(h.controller.get().acting, true, "an untrusted event is Live's own");
    h.controller.userInput({ type: "pointerdown", isTrusted: true });
    await new Promise((resolve) => setTimeout(resolve, 5)); // The take-over reaches main.
    release();
    assert.equal(code(await pending), "taken_over");
    assert.equal(pressed, 0, "the in-flight press never ran");
    assert.equal(h.activity.get(), null);
    assert.equal(h.controller.get().acting, false, "the outline is gone");
    assert.equal(code(await h.call("use_aiden", { element: go, action: "press" })), "taken_over");
    h.say("ok continue");
    assert.equal((await h.call("use_aiden", { element: go, action: "press" })).ok, true);
    assert.equal(pressed, 1);
  } finally {
    h.dispose();
  }
});

test("a barge-in stops the running action, and DevTools holding the window is a fixed error", async () => {
  const h = harness(`<button id="go">Go</button>`);
  try {
    let pressed = 0;
    h.document.getElementById("go")!.addEventListener("click", () => (pressed += 1));
    const go = await h.ref("Go");
    let release!: () => void;
    h.port.gate = { method: "DOM.resolveNode", opened: new Promise<void>((resolve) => (release = resolve)) };
    const pending = h.call("use_aiden", { element: go, action: "press" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.provider.interrupt();
    release();
    assert.equal(code(await pending), "cancelled");
    assert.equal(pressed, 0);
    h.port.inspected = true;
    assert.equal(code(await h.call("look_at_aiden")), "window_inspected");
  } finally {
    h.dispose();
  }
  assert.equal(h.port.closed, true, "closing the provider releases the window");
});

test("open_in_aiden goes through Aiden's own destinations and returns a look", async () => {
  const h = harness(`<h1>Providers</h1>`, { sessionCalls: 2 });
  try {
    const response = await h.call("open_in_aiden", { place: "providers" });
    assert.equal(response.result, "Opened Providers settings.");
    assert.match(String(response.screen), /# Providers/u);
    assert.deepEqual(h.opened, ["providers"]);
    assert.equal(code(await h.call("open_in_aiden", { place: "terminal" })), "invalid_arguments");
    assert.deepEqual(h.opened, ["providers"]);
    assert.equal(code(await h.call("look_at_aiden")), "session_budget", "the session keeps room under Gemini's tool-call cap");
  } finally {
    h.dispose();
  }
});

test("the tools are offered only while Let Live move through Aiden is on", async () => {
  const owner = { id: 1, documentId: "d1", isDestroyed: () => false } as RendererDocumentOwner;
  const ports: string[] = [];
  const factory = createAidenAppControlToolFactory(async () => {
    ports.push("attached");
    return new FakeWindowPort("");
  });
  const input = {
    owner,
    sessionId: "s1",
    signal: new AbortController().signal,
    renderer: new LiveRendererToolBroker("s1", () => undefined),
  };
  assert.equal(await factory(input, { aidenLiveAppControl: false }), null);
  assert.deepEqual(ports, [], "a switched-off session never touches the window");
  const provider = await factory(input, {});
  assert.deepEqual(
    provider?.declarations.map((declaration) => declaration.name),
    ["look_at_aiden", "use_aiden", "open_in_aiden"],
  );
  provider?.close?.();
});
