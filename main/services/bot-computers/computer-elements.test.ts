import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { parseBotComputerElementCapture } from "./computer-elements.js";

function captureResult(elements: Array<Record<string, unknown>>): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          target: { app: "Files", title: "Home" },
          elements,
        }),
      },
    ],
    details: {},
  };
}

test("parseBotComputerElementCapture fails closed for ambiguous cua-driver 0.38.0 entry/text roles without leaking value", () => {
  const parsed = parseBotComputerElementCapture(
    captureResult([
      { element_index: 0, role: "entry", label: "Search" },
      { element_index: 1, role: "ROLE_ENTRY", label: "Address", value: "https://example.com" },
      { element_index: 2, role: "entry", label: "Disabled entry", enabled: false },
      { element_index: 3, role: "entry", label: "Selectable entry", selected: true },
      { element_index: 4, role: "text", label: "Composer", value: "secret draft" },
      { element_index: 5, role: "ROLE_TEXT", label: "Notes", value: "note body" },
      { element_index: 6, role: "text", label: "Read-only label" },
      { element_index: 7, role: "text", label: "Selectable text", value: "row text", selected: false },
      { element_index: 8, role: "AXButton", label: "Save" },
      { element_index: 9, role: "AXTextField", label: "URL", enabled: false },
      { element_index: 10, role: "entry", label: "Driver editable", editable: true },
    ]),
  );

  assert.equal(parsed.app, "Files");
  assert.equal(parsed.windowTitle, "Home");
  assert.deepEqual(parsed.elements.get(0), { role: "entry", label: "Search" });
  assert.deepEqual(parsed.elements.get(1), { role: "ROLE_ENTRY", label: "Address" });
  assert.deepEqual(parsed.elements.get(2), { role: "entry", label: "Disabled entry", editable: false });
  assert.deepEqual(parsed.elements.get(3), { role: "entry", label: "Selectable entry", editable: false });
  assert.deepEqual(parsed.elements.get(4), { role: "text", label: "Composer" });
  assert.deepEqual(parsed.elements.get(5), { role: "ROLE_TEXT", label: "Notes" });
  assert.deepEqual(parsed.elements.get(6), { role: "text", label: "Read-only label" });
  assert.deepEqual(parsed.elements.get(7), { role: "text", label: "Selectable text", editable: false });
  assert.deepEqual(parsed.elements.get(8), { role: "AXButton", label: "Save" });
  assert.equal("editable" in parsed.elements.get(8)!, false);
  assert.deepEqual(parsed.elements.get(9), { role: "AXTextField", label: "URL", editable: false });
  assert.deepEqual(parsed.elements.get(10), { role: "entry", label: "Driver editable", editable: true });
  for (const element of parsed.elements.values()) {
    assert.equal("value" in element, false);
  }
});
