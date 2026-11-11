// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  render(<DesignCanvasRegion chatId="chat-1" width={800} placement="split" hidden={false} />);

  const loading = screen.getByRole("status", { name: "Loading canvas" });
  assert.equal(screen.queryByText(DESIGN_CANVAS_EMPTY_COPY) === null, true, "no empty-state copy while loading");
  assert.equal(loading.textContent?.trim() ?? "", "", "the skeleton draws no words");

  await waitFor(() => screen.getByText(DESIGN_CANVAS_EMPTY_COPY));
  assert.equal(screen.queryByRole("status", { name: "Loading canvas" }) === null, true);
  assert.ok(screen.getByRole("region", { name: "Design canvas" }));
});
