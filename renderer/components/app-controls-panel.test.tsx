import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppControlsView, appControlsSpec } from "./app-controls-panel";
import type { AppControlSnapshot } from "../shared/app-controls";

const snapshot: AppControlSnapshot = {
  version: 1,
  title: "Memory",
  target: "This desktop",
  policy: "safe",
  rows: [
    {
      id: "memory.enabled",
      label: "Memory",
      description: "Turning off does not delete facts.",
      scope: "This desktop",
      value: false,
      revision: "revision",
    },
    {
      id: "memory.workspace",
      label: "Workspace memory",
      description: "The global gate also applies.",
      scope: "Workspace — Demo",
      value: true,
      revision: "revision",
      disabledReason: "Permission required",
    },
  ],
};
test("host catalog renders accessible real switches and preserves scope and disabled state without effects", () => {
  let changes = 0;
  const html = renderToStaticMarkup(
    <AppControlsView
      snapshot={snapshot}
      change={() => {
        changes += 1;
      }}
    />,
  );
  assert.match(html, /aria-label="Memory — This desktop"/u);
  assert.match(html, /aria-checked="false"/u);
  assert.match(html, /aria-label="Workspace memory — Workspace — Demo"/u);
  assert.match(html, /disabled=""/u);
  assert.match(html, /Permission required/u);
  assert.equal(changes, 0);
  const spec = appControlsSpec(snapshot);
  assert.deepEqual(Object.keys(spec.elements), ["group", "memory.enabled", "memory.workspace"]);
  assert.equal(JSON.stringify(spec).includes("revision"), false);
});
