import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import * as React from "react";
import {
  CREATE_IMAGES_SELECTED_NODE_ONLY_CHOICE,
  createImagesRunScopeForPathChoice,
  type CreateImagesDownstreamPathChoiceView,
} from "./run-path-core";
import { CreateImagesDownstreamPathChooser } from "./run-path-chooser";
import { CreateImagesAmbiguityAcknowledgement } from "./run-ambiguity-confirmation";
import { CreateImagesDegradedRunDiscardConfirmation } from "./run-degraded-discard-confirmation";

const component = readFileSync(new URL("./run-ui.tsx", import.meta.url), "utf8");
const core = readFileSync(new URL("./run-ui-core.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./run-ui.css", import.meta.url), "utf8");

function installMountedDom(): {
  document: Document;
  container: HTMLElement;
  restore(): void;
} {
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  body.appendChild(container);
  document.documentElement.appendChild(body);

  const elementPrototype = Object.getPrototypeOf(document.createElement("div")) as HTMLElement &
    Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  elementPrototype.focus = function focus() {
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      value: this,
      writable: true,
    });
  };
  Object.defineProperty(elementPrototype, "style", {
    configurable: true,
    get: () => ({}),
  });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", { configurable: true, value: body });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    value: body,
    writable: true,
  });
  const window = {
    document,
    event: undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
  };
  Object.defineProperty(document, "defaultView", { configurable: true, value: window });
  const globals = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const elementConstructor = Object.getPrototypeOf(document.documentElement).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    navigator: { configurable: true, value: { userAgent: "node-create-images-path-test" } },
    Node: { configurable: true, value: elementConstructor },
    Element: { configurable: true, value: elementConstructor },
    HTMLElement: { configurable: true, value: elementConstructor },
    requestAnimationFrame: { configurable: true, value: window.requestAnimationFrame },
    cancelAnimationFrame: { configurable: true, value: window.cancelAnimationFrame },
  });
  return {
    document,
    container,
    restore: () => {
      for (const key of globals) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function mountedOnChange(
  input: HTMLInputElement,
): (event: { target: { value: string; checked?: boolean } }) => void {
  const propertyKey = Object.getOwnPropertyNames(input).find((key) =>
    key.startsWith("__reactProps$"),
  );
  assert.ok(propertyKey, "mounted input exposes React event props");
  const props = (input as unknown as Record<string, unknown>)[propertyKey] as {
    onChange?: (event: { target: { value: string; checked?: boolean } }) => void;
  };
  assert.ok(props.onChange, "mounted input has an onChange handler");
  return props.onChange;
}

test("run and stop confirmations are controlled Radix dialogs that gate shortcuts", () => {
  assert.ok((component.match(/<DialogPrimitive\.Root/gu) ?? []).length >= 2);
  assert.ok((component.match(/<DialogPrimitive\.Content/gu) ?? []).length >= 2);
  assert.ok((component.match(/data-slot="dialog-content"/gu) ?? []).length >= 2);
  assert.match(component, /open=\{open\}/u);
  assert.match(component, /onOpenChange\(nextOpen\)/u);
  assert.match(
    component,
    /onCloseAutoFocus=\{\(event\) => restoreFocus\(event, returnFocusRef\)\}/u,
  );
  assert.match(component, /reviewRef\.current\?\.focus\(\)/u);
  assert.match(component, /firstPathChoiceRef\.current\?\.focus\(\)/u);
  assert.match(component, /cancelRef\.current\?\.focus\(\)/u);
  assert.match(component, /disabled=\{!pathSelectionComplete \|\| !reviewed \|\| submitting\}/u);
  assert.match(component, /onReviewedChange\(false\)/u);
  assert.match(component, /No network request or billable provider work will occur\./u);
  assert.match(component, /may still complete or incur cost/u);
});

test("mounted downstream chooser requires one explicit path and preserves controlled focus", async () => {
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  const choices: readonly CreateImagesDownstreamPathChoiceView[] = [
    {
      id: "path:generate-2>output-1",
      downstreamPath: ["generate-2", "output-1"],
      title: "Path 1 · to Output · output-1",
      detail: "2 downstream nodes · Generate Image · generate-2 → Output · output-1",
    },
    {
      id: "path:gallery-1",
      downstreamPath: ["gallery-1"],
      title: "Path 2 · to Output Gallery · gallery-1",
      detail: "1 downstream node · Output Gallery · gallery-1",
    },
  ];

  function Harness() {
    const [selectedChoiceId, setSelectedChoiceId] = React.useState<string>();
    const [reviewed, setReviewed] = React.useState(true);
    return (
      <>
        <CreateImagesDownstreamPathChooser
          startNodeLabel="Prompt · prompt-1"
          choices={choices}
          selectedChoiceId={selectedChoiceId}
          truncated
          overflowReason="choice-limit"
          unavailablePathCount={1}
          onSelectionChange={(choiceId) => {
            setReviewed(false);
            setSelectedChoiceId(choiceId);
          }}
        />
        <output data-run-selection-state>
          {selectedChoiceId ?? "none"}:{reviewed ? "reviewed" : "review-required"}
        </output>
      </>
    );
  }

  try {
    flushSync(() => root.render(<Harness />));
    const inputs = Array.from(
      mounted.container.getElementsByTagName("input"),
    ) as HTMLInputElement[];
    const labels = Array.from(mounted.container.getElementsByTagName("label"));
    assert.equal(inputs.length, 3);
    assert.equal(new Set(inputs.map((input) => input.getAttribute("id"))).size, inputs.length);
    assert.deepEqual(
      labels.map((label) => label.getAttribute("for")),
      inputs.map((input) => input.getAttribute("id")),
    );
    assert.ok(inputs.every((input) => input.checked === false));
    assert.match(mounted.container.textContent ?? "", /Choose one option/u);
    assert.match(mounted.container.textContent ?? "", /Only the first 2 connected paths/u);
    assert.match(mounted.container.textContent ?? "", /additional branch work/u);

    inputs[1]!.focus();
    flushSync(() => mountedOnChange(inputs[1]!)({ target: { value: "path:generate-2>output-1" } }));
    assert.equal(mounted.document.activeElement, inputs[1]);
    assert.equal(inputs[1]?.checked, true);
    assert.equal(inputs[0]?.checked, false);
    assert.match(mounted.container.textContent ?? "", /path:generate-2>output-1:review-required/u);
    assert.doesNotMatch(mounted.container.textContent ?? "", /Choose one option/u);

    inputs[0]!.focus();
    flushSync(() =>
      mountedOnChange(inputs[0]!)({
        target: { value: CREATE_IMAGES_SELECTED_NODE_ONLY_CHOICE },
      }),
    );
    assert.equal(mounted.document.activeElement, inputs[0]);
    assert.equal(inputs[0]?.checked, true);
    assert.equal(inputs[1]?.checked, false);
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
  }

  assert.deepEqual(
    createImagesRunScopeForPathChoice("prompt-1", CREATE_IMAGES_SELECTED_NODE_ONLY_CHOICE, choices),
    { kind: "from-node", nodeId: "prompt-1" },
  );
  const pathScope = createImagesRunScopeForPathChoice(
    "prompt-1",
    "path:generate-2>output-1",
    choices,
  );
  assert.deepEqual(pathScope, {
    kind: "from-node",
    nodeId: "prompt-1",
    downstreamPath: ["generate-2", "output-1"],
  });
  assert.notEqual(
    pathScope?.kind === "from-node" ? pathScope.downstreamPath : undefined,
    choices[0]?.downstreamPath,
  );
  assert.equal(createImagesRunScopeForPathChoice("prompt-1", "forged", choices), undefined);
});

test("mounted ambiguity acknowledgement is explicit, controlled, and consequence-complete", async () => {
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);

  function Harness() {
    const [reviewed, setReviewed] = React.useState(false);
    return (
      <>
        <CreateImagesAmbiguityAcknowledgement reviewed={reviewed} onReviewedChange={setReviewed} />
        <output>{reviewed ? "acknowledgement-reviewed" : "review-required"}</output>
      </>
    );
  }

  try {
    flushSync(() => root.render(<Harness />));
    const input = mounted.container.getElementsByTagName("input")[0] as HTMLInputElement;
    assert.equal(input.checked, false);
    assert.match(
      mounted.container.textContent ?? "",
      /does not cancel, reconcile, retry, or resubmit/u,
    );
    assert.match(mounted.container.textContent ?? "", /may still complete/u);
    assert.match(mounted.container.textContent ?? "", /duplicate images and incur another charge/u);
    assert.match(mounted.container.textContent ?? "", /\$0 local mock/u);
    assert.match(mounted.container.textContent ?? "", /sends no network request/u);
    assert.match(mounted.container.textContent ?? "", /review-required/u);

    input.focus();
    flushSync(() => mountedOnChange(input)({ target: { value: "ignored", checked: true } }));
    assert.equal(mounted.document.activeElement, input);
    assert.equal(input.checked, true);
    assert.match(mounted.container.textContent ?? "", /acknowledgement-reviewed/u);
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
  }
});

test("mounted degraded-run discard requires explicit irreversible-consequence review", async () => {
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);

  function Harness() {
    const [reviewed, setReviewed] = React.useState(false);
    return (
      <>
        <CreateImagesDegradedRunDiscardConfirmation
          plan={{
            status: "ready",
            runId: "run-unassociated-1",
            reason: "current-corrupt",
            association: "unassociated",
            authorizationToken: "a".repeat(64),
            mayLoseOutputs: true,
            mayDuplicateProviderWork: true,
          }}
          reviewed={reviewed}
          onReviewedChange={setReviewed}
        />
        <output>{reviewed ? "discard-reviewed" : "discard-review-required"}</output>
      </>
    );
  }

  try {
    flushSync(() => root.render(<Harness />));
    const input = mounted.container.getElementsByTagName("input")[0] as HTMLInputElement;
    assert.equal(input.checked, false);
    assert.match(mounted.container.textContent ?? "", /permanently removes/u);
    assert.match(mounted.container.textContent ?? "", /only durable evidence/u);
    assert.match(mounted.container.textContent ?? "", /duplicate images and incur another charge/u);
    assert.match(mounted.container.textContent ?? "", /does not cancel provider work/u);
    assert.match(mounted.container.textContent ?? "", /Unassociated run/u);
    assert.match(mounted.container.textContent ?? "", /imported inputs and generated outputs/u);
    assert.match(
      mounted.container.textContent ?? "",
      /Imported-input and generated-output references may be released/u,
    );
    assert.match(
      mounted.container.textContent ?? "",
      /unique imported-input or generated-output references may be lost/u,
    );
    assert.match(mounted.container.textContent ?? "", /\$0 local mock with no network request/u);
    assert.match(mounted.container.textContent ?? "", /discard-review-required/u);

    input.focus();
    flushSync(() => mountedOnChange(input)({ target: { value: "ignored", checked: true } }));
    assert.equal(mounted.document.activeElement, input);
    assert.equal(input.checked, true);
    assert.match(mounted.container.textContent ?? "", /discard-reviewed/u);
  } finally {
    flushSync(() => root.unmount());
    await new Promise<void>((resolve) => setImmediate(resolve));
    mounted.restore();
  }
});

test("all node states carry a glyph and text rather than relying on color", () => {
  for (const status of [
    "queued",
    "running",
    "retry",
    "blocked",
    "failed",
    "cancelled",
    "succeeded",
  ]) {
    assert.match(component, new RegExp(`${status}: \\{ label:`, "u"));
  }
  assert.match(component, /data-status=\{status\}/u);
  assert.match(styles, /\.create-images-run-status\[data-status="running"\]/u);
  assert.match(component, /aria-label=\{`Node status: \$\{label\}`\}/u);
  assert.match(component, /aria-label=\{`Run status: \$\{presentation\.label\}`\}/u);
  assert.match(component, /<progress/u);
});

test("run progress and terminal history retain accessible semantics", () => {
  assert.match(component, /aria-live="polite"/u);
  assert.match(component, /aria-atomic="true"/u);
  assert.match(component, /aria-label="Node run progress"/u);
  assert.match(component, /Terminal run history/u);
  assert.match(component, /Durable summaries only\. History never repeats a request\./u);
  assert.match(component, /<time dateTime=\{item\.finishedAt\}/u);
  assert.match(component, /className="create-images-run-history-row"/u);
  assert.match(component, /aria-pressed=\{selectedRunId === item\.runId\}/u);
  assert.match(component, /onSelectRun\?\.\(item\.runId/u);
  assert.match(component, /Selected durable run details/u);
  assert.match(component, /Restore last-known-good/u);
  assert.match(component, /Repair recovery copy/u);
  assert.match(component, /expectedCandidateJournalRevision/u);
  assert.match(component, /Verified.*last-known-good.*source/u);
  assert.match(component, /aria-label="Clear oldest Create Images run history"/u);
  assert.match(component, /key=\{`\$\{assetId\}:\$\{index\}`\}/u);
  assert.match(component, /role="alert"/u);
  assert.match(component, /data-create-images-ambiguity-confirmation/u);
  assert.match(component, /cancelRef\.current\?\.focus\(\)/u);
  assert.match(component, /Acknowledge & allow new run/u);
  assert.match(component, /disabled=\{!reviewed \|\| submitting\}/u);
  assert.match(
    component,
    /onCloseAutoFocus=\{\(event\) => restoreFocus\(event, returnFocusRef\)\}/u,
  );
  assert.match(component, /Review acknowledgement/u);
  assert.match(component, /Unresolved submission acknowledged/u);
  assert.match(component, /data-create-images-degraded-discard/u);
  assert.match(
    component,
    /data-create-images-degraded-discard[\s\S]{0,500}cancelRef\.current\?\.focus\(\)/u,
  );
  assert.match(component, /Keep record/u);
  assert.match(component, /disabled=\{!reviewed \|\| submitting\}/u);
  assert.match(component, /Permanently discard record/u);
});

test("run-all and run-from-here validity are independent", () => {
  assert.match(component, /runAllDisabledReason\?: string/u);
  assert.match(component, /runFromHereDisabledReason\?: string/u);
  assert.match(component, /aria-disabled=\{Boolean\(runAllDisabledReason\)\}/u);
  assert.match(component, /runFromHereDisabledReason \?\?[\s\S]{0,180}!selectedNodeLabel/u);
  assert.match(
    component,
    /aria-describedby=\{runAllDisabledReason \? runAllReasonId : undefined\}/u,
  );
  assert.match(
    component,
    /aria-describedby=\{runFromHereReason \? runFromHereReasonId : undefined\}/u,
  );
  assert.doesNotMatch(component, /disabledReason\?: string/u);
});

test("paid retry is explicit while only local mock retry-wait may resume", () => {
  assert.match(core, /automatic: false/u);
  assert.match(core, /will not submit a paid retry automatically/u);
  assert.match(core, /node\.retryMode !== "automatic-mock"/u);
  assert.match(core, /event\.attempt !== node\.attempt \+ 1/u);
  assert.match(core, /retryMode\?: "automatic-mock" \| "manual-review"/u);
  assert.doesNotMatch(component, /setTimeout|setInterval/u);
  assert.doesNotMatch(component, /useEffect[\s\S]{0,160}onRetry/u);
});

test("styles use semantic tokens with responsive, forced-color, and reduced-motion contracts", () => {
  assert.match(styles, /@media \(max-width: 760px\)/u);
  assert.match(styles, /@media \(max-width: 560px\)/u);
  assert.match(styles, /@media \(max-width: 390px\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(styles, /:root\[data-reduce-motion="true"\]/u);
  assert.match(
    styles,
    /:root\[data-reduce-motion="true"\] \.create-images-run-path-option[\s\S]{0,80}transition: none/u,
  );
  assert.match(styles, /@media \(forced-colors: active\)/u);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/iu);
  for (const token of [
    "--surface-popover",
    "--surface-control",
    "--border-field",
    "--text-primary",
    "--support-red",
    "--support-green",
    "--support-warning",
    "--accent",
    "--focus-ring",
  ]) {
    assert.match(styles, new RegExp(token, "u"));
  }
});
