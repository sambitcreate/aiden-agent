import { readFileSync } from "node:fs";
import { FORM_FILL_MUTATION_AVAILABLE } from "../../../renderer/shared/form-fill-availability.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ComputerUseController } from "./controller.js";
import { ComputerUseSafetyError } from "./safety.js";
import {
  FORM_FILL_BATCH_VERSION,
  type FormFillBatchPlan,
} from "../form-fill/batch-core.js";

/**
 * Scripted cua-driver session. Every callTool records its args and pulls the
 * next scripted payload for that tool name (last payload repeats).
 */
class FakeSession {
  ready = true;
  toolCatalog = new Map();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  closed = false;

  constructor(
    private readonly script: Record<string, Record<string, unknown>[]>,
  ) {}

  supports(): boolean {
    return false;
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    this.calls.push({ name, args });
    const list = this.script[name];
    const payload = list && list.length > 1 ? list.shift()! : list?.[0];
    return {
      content: [{ type: "text", text: "{}" }],
      structuredContent: payload ?? {},
    };
  }

  async close() {
    this.closed = true;
  }
}

const WINDOWS = {
  windows: [
    {
      pid: 42,
      window_id: 7,
      app_name: "Safari",
      title: "Registration",
      z_index: 0,
      is_on_screen: true,
    },
  ],
};

function element(index: number, label: string, value = "", token?: string) {
  return {
    element_index: index,
    element_token: token,
    role: "AXTextField",
    label,
    value,
  };
}

function windowState(elements: unknown[]) {
  return { elements, element_count: elements.length };
}

function makeController(script: Record<string, Record<string, unknown>[]>) {
  const session = new FakeSession(script);
  const controller = new ComputerUseController("gen-1", false, async () => ({
    createSession: async () => session,
    shutdown: async () => {},
  }));
  return { controller, session };
}

function stalePlan(): FormFillBatchPlan {
  return {
    version: FORM_FILL_BATCH_VERSION,
    planId: "ffp-1",
    chatId: "chat-1",
    generationId: "gen-1",
    documentId: "doc-1",
    attachmentId: "att-1",
    attachmentHash: "a".repeat(64),
    attachmentName: "patient.txt",
    window: { pid: 42, windowId: 7, appName: "Safari", title: "Registration" },
    controllerEpoch: 1,
    actions: [
      {
        order: 0,
        elementIndex: 0,
        elementToken: "tok-0",
        role: "AXTextField",
        label: "First name",
        action: "fill",
        entityIndex: 0,
        value: "Ada",
        source: { attachmentId: "att-1", label: "First name", line: 1 },
      },
      {
        order: 1,
        elementIndex: 1,
        elementToken: "tok-1",
        role: "AXTextField",
        label: "Last name",
        action: "fill",
        entityIndex: 1,
        value: "Lovelace",
        source: { attachmentId: "att-1", label: "Last name", line: 2 },
      },
    ],
    maxActions: 2,
    submit: false,
    expiresAt: Date.now() + 60_000,
  };
}

const FILL_ELEMENTS_PRE = () => [
  element(0, "First name", "", "tok-0"),
  element(1, "Last name", "", "tok-1"),
];


for (const nextDocument of ["same-url-reload", "same-title-new-origin", "native-document-switch"]) {
  test(`fails closed before capture or writes for ${nextDocument} with identical window and form`, async () => {
    const { controller, session } = makeController({ list_windows: [WINDOWS],
      get_window_state: [windowState(FILL_ELEMENTS_PRE()), windowState(FILL_ELEMENTS_PRE())],
      set_value: [{ effect: "confirmed" }],
    });
    const unavailable = (error: unknown) => error instanceof ComputerUseSafetyError && error.code === "form_fill_unavailable";
    await assert.rejects(controller.formFillCapture({ pid: 42, windowId: 7 }), unavailable);
    await assert.rejects(controller.executeFormFillBatch(stalePlan()), unavailable);
    assert.deepEqual(session.calls, [], "no driver capability or structure can substitute for document authority");
    await controller.close();
  });
}

test("desktop and Bot share disabled specialist admission, with no enable/download or tour affordance", () => {
  assert.equal(FORM_FILL_MUTATION_AVAILABLE, false);
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(read("../llm-client.ts"), /if \(FORM_FILL_MUTATION_AVAILABLE && computerUse && settings.formFillSpecialistEnabled/u);
  assert.match(read("../form-fill/settings.ts"), /if \(enabled && !FORM_FILL_MUTATION_AVAILABLE\) throw/u);
  assert.match(read("../../handlers/form-fill.ts"), /if \(!FORM_FILL_MUTATION_AVAILABLE\) throw/u);
  const settings = read("../../../renderer/components/settings/computer-use-settings.tsx");
  const field = settings.slice(settings.indexOf("function FormFillSpecialistField"), settings.indexOf("export function ComputerUseSettings"));
  assert.doesNotMatch(field, /formFillApi\.(download|setEnabled)|<Switch/u);
  assert.match(field, /Unavailable until Computer Use/u);
  assert.match(field, /formFillApi\.remove/u);
});
