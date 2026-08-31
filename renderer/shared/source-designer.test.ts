import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSourceDesignTurnContext,
  parseSourceElementDescriptor,
  SOURCE_DESIGNER_VERSION,
} from "./source-designer.js";

const selection = {
  version: 1 as const,
  tagName: "button",
  label: "Save",
  selector: "main > button:nth-of-type(1)",
};

test("parses bounded exact source descriptors", () => {
  assert.deepEqual(
    parseSourceElementDescriptor({
      version: SOURCE_DESIGNER_VERSION,
      selection,
      filePath: "/workspace/src/App.tsx",
      lineNumber: 12,
      columnNumber: 5,
      componentName: "App",
    }),
    {
      version: SOURCE_DESIGNER_VERSION,
      selection,
      filePath: "/workspace/src/App.tsx",
      lineNumber: 12,
      columnNumber: 5,
      componentName: "App",
    },
  );
  assert.equal(
    parseSourceElementDescriptor({
      version: SOURCE_DESIGNER_VERSION,
      selection,
      filePath: "/workspace/src/App.tsx",
      lineNumber: 0,
    }),
    undefined,
  );
});

test("accepts only opaque source selection handles", () => {
  assert.deepEqual(
    parseSourceDesignTurnContext({
      version: SOURCE_DESIGNER_VERSION,
      selectionId: "selection_1234567890",
    }),
    { version: SOURCE_DESIGNER_VERSION, selectionId: "selection_1234567890" },
  );
  assert.equal(
    parseSourceDesignTurnContext({
      version: SOURCE_DESIGNER_VERSION,
      selectionId: "../../source",
    }),
    undefined,
  );
});
