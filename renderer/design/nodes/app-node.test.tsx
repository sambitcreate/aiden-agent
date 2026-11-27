// A live app frame on the canvas (design mode v2 Phase 3a, D16). Until the
// live body lands, every app frame is a static card over its last picture,
// and what it says must be true with live apps on and off.

// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../../lib/app-capabilities";
import type { DesignFrame } from "../../shared/design-canvas/schema";
import { designFrameSnapshots } from "../frame-snapshots";
import { AppFrameBody } from "./app-node";

afterEach(() => cleanup());

function appFrame(overrides: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id: `app-${Math.random().toString(36).slice(2)}`,
    kind: "app",
    title: "Pricing",
    x: 0,
    y: 0,
    w: 640,
    h: 436,
    appRoot: ".",
    route: "/pricing",
    viewport: { width: 1280, height: 800 },
    scale: 0.5,
    pageId: "page-1",
    createdBy: "aiden",
    ...overrides,
  } as DesignFrame;
}

function mount(frame: DesignFrame, designLive: boolean) {
  return render(
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true, designLive }}>
      <AppFrameBody frame={frame} />
    </AppCapabilitiesProvider>,
  );
}

test("with live apps off, an app frame says so over its last picture, and never frames the app", () => {
  installBotTestIpc({});
  const frame = appFrame();
  designFrameSnapshots.set(frame.id, 0, "data:image/png;base64,SNAP");
  mount(frame, false);
  assert.ok(screen.getByText("Live apps are off"));
  assert.equal(document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,SNAP");
  assert.equal(document.querySelectorAll("iframe").length, 0);
});

test("with live apps on, the card doesn't claim they are off; with no picture it names the frame", () => {
  installBotTestIpc({});
  mount(appFrame({ title: "Home" }), true);
  assert.equal(screen.queryByText("Live apps are off"), null);
  assert.ok(screen.getByText("Not live on the canvas yet"));
  assert.ok(screen.getByRole("img", { name: "Home" }), "the skeleton names the frame");
  assert.equal(document.querySelectorAll("iframe").length, 0);
});
