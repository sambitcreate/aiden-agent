import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import {
  BrowserAnnotationPreview,
  buildBrowserAnnotationPreviewApplyExpression,
  buildBrowserAnnotationPreviewResetExpression,
} from "./annotation-preview.js";

// A small CSSOM test boundary executes the actual emitted page expression. In
// particular, shorthand declarations expand and can replace existing longhands.
class InlineStyle {
  private readonly values = new Map<
    string,
    { value: string; priority: string }
  >();
  get length() {
    return this.values.size;
  }
  item(index: number) {
    return [...this.values.keys()][index] ?? "";
  }
  getPropertyValue(property: string): string {
    if (property === "margin")
      return ["top", "right", "bottom", "left"]
        .map((side) => this.getPropertyValue(`margin-${side}`))
        .join(" ")
        .trim();
    return this.values.get(property)?.value ?? "";
  }
  getPropertyPriority(property: string) {
    return this.values.get(property)?.priority ?? "";
  }
  setProperty(property: string, value: string, priority = "") {
    if (!value) {
      this.values.delete(property);
      return;
    }
    if (property === "margin") {
      for (const side of ["top", "right", "bottom", "left"])
        this.setProperty(`margin-${side}`, value, priority);
    } else this.values.set(property, { value, priority });
  }
  get cssText() {
    return [...this.values]
      .map(
        ([property, item]) =>
          `${property}: ${item.value}${item.priority ? " !important" : ""};`,
      )
      .join(" ");
  }
  set cssText(value: string) {
    this.values.clear();
    for (const declaration of value.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const input = declaration.slice(colon + 1).trim();
      this.setProperty(
        property,
        input.replace(/\s*!important$/, ""),
        input.endsWith("!important") ? "important" : "",
      );
    }
  }
}

function element(cssText = "", computed: Record<string, string> = {}) {
  const style = new InlineStyle();
  style.cssText = cssText;
  return { style, computed, isConnected: true };
}

function fixture() {
  const first = element("color: blue !important; margin-left: 6px;", {
    width: "120px",
    "font-size": "16px",
  });
  const second = element("color: green;", { width: "220px" });
  const targets = new Map<string, ReturnType<typeof element>[]>([
    ["#first", [first]],
    ["#second", [second]],
    [".many", [first, second]],
  ]);
  const parsed: string[] = [];
  const document = {
    querySelectorAll: (selector: string) => targets.get(selector) ?? [],
  };
  const context = createContext({
    document,
    CSS: {
      supports: (property: string, value: string) =>
        !property.includes("unsupported") && value !== "not-valid-css",
    },
    getComputedStyle: (target: ReturnType<typeof element>) => ({
      getPropertyValue: (property: string) =>
        target.style.getPropertyValue(property) ||
        target.computed[property] ||
        "",
    }),
    __aidenPlaywright: {
      parseSelector(selector: string) {
        parsed.push(selector);
        return selector;
      },
      querySelectorAll: (selector: string) => targets.get(selector) ?? [],
    },
  });
  const service = new BrowserAnnotationPreview({
    execute: async (expression) => runInContext(expression, context),
  });
  return { first, second, targets, parsed, context, service };
}

test("previews independent elements and reports original computed values while preserving inline priority on reset", async () => {
  const f = fixture();
  const original = [f.first.style.cssText, f.second.style.cssText];
  const metadata = await f.service.apply([
    {
      ref: "1-0",
      selector: "#first",
      styles: { color: "red", width: "200px" },
    },
    {
      ref: "1-1",
      selector: "#second",
      styles: { color: "purple", width: "300px" },
    },
  ]);
  assert.equal(f.first.style.getPropertyValue("color"), "red");
  assert.equal(f.second.style.getPropertyValue("color"), "purple");
  assert.equal(f.first.style.getPropertyPriority("width"), "important");
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), [
    {
      ref: "1-0",
      selector: "#first",
      changes: {
        color: { previous: "blue", current: "red" },
        width: { previous: "120px", current: "200px" },
      },
    },
    {
      ref: "1-1",
      selector: "#second",
      changes: {
        color: { previous: "green", current: "purple" },
        width: { previous: "220px", current: "300px" },
      },
    },
  ]);
  await f.service.reset();
  assert.deepEqual([f.first.style.cssText, f.second.style.cssText], original);
  assert.equal(f.first.style.getPropertyPriority("color"), "important");
  assert.equal(f.context.__aidenBrowserAnnotationPreview_v1, undefined);
  await f.service.reset();
});

test("complete desired updates restore removed targets/properties and keep the first baseline across new snapshot refs", async () => {
  const f = fixture();
  await f.service.apply([
    { ref: "1", selector: "#first", styles: { color: "red", width: "200px" } },
    { ref: "2", selector: "#second", styles: { color: "purple" } },
  ]);
  const result = await f.service.apply([
    { ref: "new-ref", selector: "#first", styles: { color: "orange" } },
  ]);
  assert.equal(result[0].ref, "new-ref");
  assert.equal(result[0].changes.color.previous, "blue");
  assert.equal(f.first.style.getPropertyValue("width"), "");
  assert.equal(f.second.style.getPropertyValue("color"), "green");
  await f.service.apply([
    { ref: "new-ref", selector: "#first", styles: { color: "" } },
  ]);
  assert.equal(f.first.style.getPropertyValue("color"), "blue");
});

test("shorthand updates restore original longhands and unrelated page style changes survive cancellation", async () => {
  const f = fixture();
  await f.service.apply([
    {
      ref: "first",
      selector: "#first",
      styles: { margin: "20px", color: "red" },
    },
  ]);
  assert.equal(f.first.style.getPropertyValue("margin-left"), "20px");
  f.first.style.setProperty("background-color", "yellow");
  f.first.style.setProperty("color", "pink");
  await f.service.reset();
  assert.equal(f.first.style.getPropertyValue("margin-left"), "6px");
  assert.equal(f.first.style.getPropertyValue("margin-top"), "");
  assert.equal(f.first.style.getPropertyValue("color"), "blue");
  assert.equal(f.first.style.getPropertyValue("background-color"), "yellow");
});

test("resolves strict Playwright selectors including shadow targets and refuses ambiguous/replaced selectors atomically", async () => {
  const f = fixture();
  const shadowSelector = 'internal:role=button[name="Save"s]';
  f.targets.set(shadowSelector, [f.first]);
  await f.service.apply([
    { ref: "shadow", selector: shadowSelector, styles: { color: "red" } },
  ]);
  assert.equal(f.parsed[0], shadowSelector);
  for (const selector of [".many", "#missing"]) {
    await assert.rejects(
      f.service.apply([
        { ref: "first", selector: "#first", styles: { color: "orange" } },
        { ref: "bad", selector, styles: { color: "purple" } },
      ]),
      /exactly one/,
    );
    assert.equal(f.first.style.getPropertyValue("color"), "red");
  }
  await assert.rejects(
    f.service.apply([
      { ref: "first", selector: "#first", styles: { color: "orange" } },
      { ref: "same", selector: shadowSelector, styles: { color: "purple" } },
    ]),
    /same style target/,
  );
  f.first.isConnected = false;
  await assert.rejects(
    f.service.apply([
      { ref: "old", selector: "#first", styles: { color: "orange" } },
    ]),
    /no longer/,
  );
  await f.service.reset();
  assert.equal(f.first.style.getPropertyValue("color"), "blue");
});

test("invalid CSS never partially updates existing previews or a second element", async () => {
  const f = fixture();
  await f.service.apply([
    { ref: "first", selector: "#first", styles: { color: "red" } },
  ]);
  await assert.rejects(
    f.service.apply([
      { ref: "first", selector: "#first", styles: { color: "orange" } },
      {
        ref: "second",
        selector: "#second",
        styles: { color: "not-valid-css" },
      },
    ]),
    /Unsupported CSS/,
  );
  assert.equal(f.first.style.getPropertyValue("color"), "red");
  assert.equal(f.second.style.getPropertyValue("color"), "green");
  await f.service.reset();
  assert.equal(f.first.style.getPropertyValue("color"), "blue");
});

test("a forcibly terminated page evaluation can still restore its pre-published baseline", async () => {
  const f = fixture();
  f.context.previewTestTarget = f.first;
  runInContext(
    `(() => {
    const original = previewTestTarget.style.setProperty.bind(previewTestTarget.style);
    previewTestTarget.style.setProperty = (property, value, priority) => {
      original(property, value, priority);
      if (property === 'color' && value === 'red') while (true) {}
    };
  })()`,
    f.context,
  );
  assert.throws(
    () =>
      runInContext(
        buildBrowserAnnotationPreviewApplyExpression([
          { ref: "first", selector: "#first", styles: { color: "red" } },
        ]),
        f.context,
        { timeout: 20 },
      ),
    /timed out/,
  );
  assert.equal(f.first.style.getPropertyValue("color"), "red");
  await f.service.reset();
  assert.equal(f.first.style.getPropertyValue("color"), "blue");
  assert.equal(f.first.style.getPropertyPriority("color"), "important");
  assert.equal(f.context.__aidenBrowserAnnotationPreview_v1, undefined);
});

test("bounded builders reject invalid inputs and quote selectors instead of executing them", async () => {
  const input = { ref: "first", selector: "#first", styles: { color: "red" } };
  assert.throws(
    () =>
      buildBrowserAnnotationPreviewApplyExpression(
        Array.from({ length: 51 }, (_, i) => ({ ...input, selector: `#${i}` })),
      ),
    /50/,
  );
  assert.throws(
    () =>
      buildBrowserAnnotationPreviewApplyExpression([
        {
          ...input,
          styles: Object.fromEntries(
            Array.from({ length: 41 }, (_, i) => [`--x${i}`, "1"]),
          ),
        },
      ]),
    /40/,
  );
  assert.throws(
    () =>
      buildBrowserAnnotationPreviewApplyExpression([
        { ...input, styles: { "color;display": "red" } },
      ]),
    /valid CSS/,
  );
  assert.throws(
    () =>
      buildBrowserAnnotationPreviewApplyExpression([
        { ...input, styles: { color: "x".repeat(2001) } },
      ]),
    /2000/,
  );
  assert.throws(
    () => buildBrowserAnnotationPreviewApplyExpression([input, input]),
    /only once/,
  );
  const f = fixture();
  const quoted = '#first");globalThis.injected=true;//';
  f.targets.set(quoted, [f.first]);
  await f.service.apply([{ ...input, selector: quoted }]);
  assert.equal(f.context.injected, undefined);
  // Fresh page contexts and the plain-CSS test fallback need no existing preview state.
  delete f.context.__aidenPlaywright;
  await f.service.reset();
  await f.service.apply([input]);
  runInContext(buildBrowserAnnotationPreviewResetExpression(), f.context);
  assert.equal(f.first.style.getPropertyValue("color"), "blue");
});
