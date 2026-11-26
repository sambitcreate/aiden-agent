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

test("parseBotComputerElementCapture preserves editable booleans and AT-SPI states without inventing them when absent", () => {
  const parsed = parseBotComputerElementCapture(
    captureResult([
      { element_index: 0, role: "entry", label: "Search", editable: true },
      { element_index: 1, role: "entry", label: "Read-only field", editable: false },
      { element_index: 2, role: "text", label: "Composer", states: ["focusable", "ATSPI_STATE_EDITABLE"] },
      { element_index: 3, role: "text", label: "Status log", states: ["focusable", "selectable"] },
      { element_index: 4, role: "AXButton", label: "Save" },
    ]),
  );

  assert.equal(parsed.app, "Files");
  assert.equal(parsed.windowTitle, "Home");
  assert.deepEqual(parsed.elements.get(0), { role: "entry", label: "Search", editable: true });
  assert.deepEqual(parsed.elements.get(1), { role: "entry", label: "Read-only field", editable: false });
  assert.deepEqual(parsed.elements.get(2), { role: "text", label: "Composer", editable: true });
  assert.deepEqual(parsed.elements.get(3), { role: "text", label: "Status log", editable: false });
  assert.deepEqual(parsed.elements.get(4), { role: "AXButton", label: "Save" });
  assert.equal("editable" in parsed.elements.get(4)!, false);
});
