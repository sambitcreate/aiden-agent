// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesignCanvasRegion } from "./design-canvas-region";
import { emptyDesignCanvas } from "../shared/design-canvas/schema";
import { DESIGN_CANVAS_EMPTY_COPY } from "./design-canvas-empty";

// The lazy canvas imports React Flow's CSS, which Node cannot load; tests get an empty module.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,export%20default%20%7B%7D", shortCircuit: true };
    return next(specifier, context);
  },
});

afterEach(() => cleanup());

// Must run first in this file: once the lazy chunk has loaded, React never shows the fallback again.
test("while the canvas chunk loads, the region shows a neutral loading state, not the empty canvas", async () => {
  installBotTestIpc({
    "designCanvas:get": () => emptyDesignCanvas(),
  });
  render(<DesignCanvasRegion chatId="chat-1" workspaceId="workspace-1" width={800} placement="split" hidden={false} />);

  const loading = screen.getByRole("status", { name: "Loading canvas" });
  assert.equal(screen.queryByText(DESIGN_CANVAS_EMPTY_COPY) === null, true, "no empty-state copy while loading");
  assert.equal(loading.textContent?.trim() ?? "", "", "the skeleton draws no words");

  // The region's lazy import is this same module, so this waits for the chunk
  // itself, however long a busy machine takes to load it, and only the render
  // after it is left to waitFor.
  await import("./design-canvas");
  await waitFor(() => screen.getByText(DESIGN_CANVAS_EMPTY_COPY));
  assert.equal(screen.queryByRole("status", { name: "Loading canvas" }) === null, true);
  assert.ok(screen.getByRole("region", { name: "Design canvas" }));
});

test("a save answered moved reopens the canvas on the chat's new workspace before its metadata says so, and the next edit saves there", async () => {
  const saves: Array<{ workspaceId?: string }> = [];
  let revision = 0;
  const calls = installBotTestIpc({
    "designCanvas:get": () => ({ ...emptyDesignCanvas(), revision }),
    "designCanvas:save": (_chatId, _doc, _base, options) => {
      const named = (options as { workspaceId?: string } | undefined) ?? {};
      saves.push(named);
      if (named.workspaceId === "workspace-1") return { ok: false, reason: "moved", workspaceId: "workspace-2" };
      revision += 1;
      return { ok: true, revision };
    },
    "designCanvas:grant": () => ({ error: "unavailable" }),
    "designCanvas:watch": () => undefined,
    "designCanvas:view:get": () => null,
    "designCanvas:view": () => undefined,
  });
  render(<DesignCanvasRegion chatId="chat-1" workspaceId="workspace-1" width={800} placement="split" hidden={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Note" }));
  await waitFor(() => assert.deepEqual(saves.map((save) => save.workspaceId), ["workspace-1"]), { timeout: 3000 });
  // The canvas of workspace-2 loads in its place, with the chat's metadata still naming workspace-1.
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "designCanvas:get").length, 2), { timeout: 3000 });
  fireEvent.click(await screen.findByRole("button", { name: "Note" }));
  await waitFor(() => assert.deepEqual(saves.map((save) => save.workspaceId), ["workspace-1", "workspace-2"]), { timeout: 3000 });
  assert.equal(revision, 1, "the edit on the new workspace's canvas is saved");
});
