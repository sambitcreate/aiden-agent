import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser } from "@xmldom/xmldom";
import { CanvasNodeChrome } from "./canvas-node-chrome";
import { CanvasToolRail } from "./canvas-tool-rail";
import { CanvasZoomControls, type CanvasZoomControlsProps } from "./canvas-zoom-controls";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "./canvas-viewport-core";

const noop = () => undefined;

function parse(element: ReactElement) {
  const document = new DOMParser().parseFromString(`<root>${renderToStaticMarkup(element)}</root>`, "text/xml");
  const all = Array.from(document.getElementsByTagName("*"));
  return {
    all,
    buttons: all.filter((node) => node.tagName === "button"),
    byRole: (role: string) => all.filter((node) => node.getAttribute("role") === role),
  };
}

test("the tool rail is a labelled toolbar of pressed toggles with their shortcuts", () => {
  const { byRole, buttons } = parse(<CanvasToolRail tool="hand" onToolChange={noop} />);
  assert.equal(byRole("toolbar")[0]?.getAttribute("aria-label"), "Canvas tools");
  assert.deepEqual(
    buttons.map((button) => [
      button.getAttribute("aria-label"),
      button.getAttribute("aria-pressed"),
      button.getAttribute("aria-keyshortcuts"),
    ]),
    [
      ["Select", "false", "V"],
      ["Hand", "true", "H"],
    ],
  );
});

const zoomProps: Omit<CanvasZoomControlsProps, "zoom"> = {
  minimapVisible: false,
  onZoomIn: noop,
  onZoomOut: noop,
  onResetZoom: noop,
  onFitView: noop,
  onToggleMinimap: noop,
};

test("zoom controls read out the zoom and disable at the limits", () => {
  const at = (zoom: number) => parse(<CanvasZoomControls zoom={zoom} {...zoomProps} />).buttons;
  const label = (zoom: number, name: string) =>
    at(zoom).find((button) => button.getAttribute("aria-label")?.startsWith(name));
  assert.equal(label(1.2, "Zoom 120%")?.textContent, "120%");
  assert.equal(label(CANVAS_MIN_ZOOM, "Zoom out")?.hasAttribute("disabled"), true);
  assert.equal(label(CANVAS_MAX_ZOOM, "Zoom in")?.hasAttribute("disabled"), true);
  assert.equal(label(1, "Zoom out")?.hasAttribute("disabled"), false);
  assert.equal(label(1, "Zoom in")?.hasAttribute("disabled"), false);
  assert.equal(label(1, "Fit to screen")?.getAttribute("aria-keyshortcuts"), "Shift+1");
});

test("the overview map toggle reports its state", () => {
  const toggle = (minimapVisible: boolean) =>
    parse(<CanvasZoomControls zoom={1} {...zoomProps} minimapVisible={minimapVisible} />).buttons.find(
      (button) => button.getAttribute("aria-label") === "Overview map",
    );
  assert.equal(toggle(false)?.getAttribute("aria-pressed"), "false");
  assert.equal(toggle(true)?.getAttribute("aria-pressed"), "true");
});

test("node chrome names the node, exposes selection, and shows status as text", () => {
  const { byRole, all } = parse(
    <CanvasNodeChrome title="Hero screen" selected status="Generating">
      <p>body</p>
    </CanvasNodeChrome>,
  );
  const group = byRole("group")[0];
  assert.equal(group?.getAttribute("aria-label"), "Hero screen");
  assert.equal(group?.getAttribute("data-selected"), "true");
  assert.ok(all.some((node) => node.textContent === "Generating"));
  assert.equal(
    parse(<CanvasNodeChrome title="Idle" selected={false}><p /></CanvasNodeChrome>).byRole("group")[0]?.getAttribute("data-selected"),
    "false",
  );
});
