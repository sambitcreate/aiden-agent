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

test("parseBotComputerElementCapture derives editable from real cua-driver 0.38.0 fields without leaking value", () => {
  const parsed = parseBotComputerElementCapture(
    captureResult([
      { element_index: 0, role: "entry", label: "Search" },
      { element_index: 1, role: "ROLE_ENTRY", label: "Address" },
      { element_index: 2, role: "entry", label: "Disabled entry", enabled: false },
      { element_index: 3, role: "entry", label: "Selectable entry", selected: true },
      { element_index: 4, role: "text", label: "Composer", value: "secret draft" },
      { element_index: 5, role: "ROLE_TEXT", label: "Notes", value: "note body" },
      { element_index: 6, role: "text", label: "Read-only label" },
      { element_index: 7, role: "text", label: "Empty text", value: "" },
      { element_index: 8, role: "text", label: "Selectable text", value: "row text", selected: false },
      { element_index: 9, role: "AXButton", label: "Save" },
      { element_index: 10, role: "AXTextField", label: "URL", enabled: false },
    ]),
  );

  assert.equal(parsed.app, "Files");
  assert.equal(parsed.windowTitle, "Home");
  assert.deepEqual(parsed.elements.get(0), { role: "entry", label: "Search", editable: true });
  assert.deepEqual(parsed.elements.get(1), { role: "ROLE_ENTRY", label: "Address", editable: true });
  assert.deepEqual(parsed.elements.get(2), { role: "entry", label: "Disabled entry", editable: false });
  assert.deepEqual(parsed.elements.get(3), { role: "entry", label: "Selectable entry", editable: false });
  assert.deepEqual(parsed.elements.get(4), { role: "text", label: "Composer", editable: true });
  assert.deepEqual(parsed.elements.get(5), { role: "ROLE_TEXT", label: "Notes", editable: true });
  assert.deepEqual(parsed.elements.get(6), { role: "text", label: "Read-only label", editable: false });
  assert.deepEqual(parsed.elements.get(7), { role: "text", label: "Empty text", editable: false });
  assert.deepEqual(parsed.elements.get(8), { role: "text", label: "Selectable text", editable: false });
  assert.deepEqual(parsed.elements.get(9), { role: "AXButton", label: "Save" });
  assert.equal("editable" in parsed.elements.get(9)!, false);
  assert.deepEqual(parsed.elements.get(10), { role: "AXTextField", label: "URL", editable: false });
  for (const element of parsed.elements.values()) {
    assert.equal("value" in element, false);
  }
});
