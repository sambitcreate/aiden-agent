// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { DESIGN_FIRST_PAGE_ID, type DesignFrame } from "../shared/design-canvas/schema";
import { parseDesignTweakControls, type DesignTweakControl } from "../shared/design-canvas/tweaks";
import { DesignTweaksEditor, DesignTweaksFloat, type DesignTweakOps } from "./design-tweaks-panel";
import type { DesignFramePatch } from "./nodes/design-node-context";

const CONTROLS = parseDesignTweakControls({
  controls: [
    { id: "accent", label: "Accent", type: "color", default: "#2f6fed", var: "--accent", group: "Colour" },
    { id: "radius", label: "Corners", type: "number", min: 0, max: 24, step: 2, unit: "px", default: 8, var: "--radius", group: "Shape" },
    {
      id: "shadow",
      label: "Shadow",
      type: "pad",
      group: "Shape",
      x: { label: "Distance", var: "--shadow-y", min: 0, max: 32, step: 1, unit: "px", default: 8 },
      y: { label: "Blur", var: "--shadow-blur", min: 0, max: 64, step: 2, unit: "px", default: 24 },
    },
    { id: "headline", label: "Headline", type: "text", default: "Plan less", attr: "data-headline" },
    { id: "replay", label: "Replay animation", type: "action" },
  ],
});

function page(overrides: Partial<DesignFrame> = {}): DesignFrame {
  return {
    id: "page",
    kind: "file",
    title: "Picker",
    path: "design/picker.html",
    x: 0,
    y: 0,
    w: 390,
    h: 800,
    pageId: DESIGN_FIRST_PAGE_ID,
    createdBy: "aiden",
    ...overrides,
  };
}

type Calls = { action: string[]; send: string[]; makeDefault: number; showAll: number; captures: number };

/** The editor over a frame that takes its own updates, as the canvas would. */
function Harness({
  initial,
  calls,
  controls = CONTROLS,
  pressed = true,
}: {
  initial: DesignFrame;
  calls: Calls;
  controls?: DesignTweakControl[];
  pressed?: boolean;
}) {
  const [frame, setFrame] = React.useState(initial);
  const ops: DesignTweakOps = {
    update: (_id, patch: DesignFramePatch) =>
      setFrame((current) => {
        const next: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        return next as DesignFrame;
      }),
    action: (_frameId, id) => {
      calls.action.push(id);
      return pressed;
    },
    send: (_frameId, note) => {
      calls.send.push(note);
      return true;
    },
    makeDefault: () => {
      calls.makeDefault += 1;
    },
    capture: async () => {
      calls.captures += 1;
      return "data:image/png;base64,AAAA";
    },
    showAll: () => {
      calls.showAll += 1;
    },
  };
  return (
    <>
      <DesignTweaksEditor frame={frame} controls={controls} ops={ops} />
      <output data-testid="tweaks">{JSON.stringify(frame.tweaks ?? null)}</output>
      <output data-testid="versions">{JSON.stringify(frame.tweakVersions ?? null)}</output>
    </>
  );
}

function newCalls(): Calls {
  return { action: [], send: [], makeDefault: 0, showAll: 0, captures: 0 };
}

const tweaks = () => JSON.parse(screen.getByTestId("tweaks").textContent ?? "null") as Record<string, string> | null;
const versions = () =>
  JSON.parse(screen.getByTestId("versions").textContent ?? "null") as { name: string; tweaks?: Record<string, string> }[] | null;

beforeEach(() => {
  installBotTestIpc();
  window.localStorage.clear();
});
afterEach(cleanup);

test("a typed value sets a number between the slider's steps but never past its ends", () => {
  render(<Harness initial={page()} calls={newCalls()} />);
  const typed = screen.getByRole("textbox", { name: "Corners value" });
  fireEvent.change(typed, { target: { value: "13" } });
  fireEvent.keyDown(typed, { key: "Enter" });
  assert.deepEqual(tweaks(), { "--radius": "13px" });
  fireEvent.change(typed, { target: { value: "99" } });
  fireEvent.blur(typed);
  assert.deepEqual(tweaks(), { "--radius": "24px" });
  assert.equal((typed as HTMLInputElement).value, "24");
  // Words that aren't a number put the value back.
  fireEvent.change(typed, { target: { value: "big" } });
  fireEvent.blur(typed);
  assert.equal((typed as HTMLInputElement).value, "24");
});

test("the pad moves one axis with left and right and the other with up and down, in steps", () => {
  render(<Harness initial={page()} calls={newCalls()} />);
  const point = screen.getByRole("slider", { name: "Shadow" });
  fireEvent.keyDown(point, { key: "ArrowRight" });
  fireEvent.keyUp(point, { key: "ArrowRight" });
  assert.deepEqual(tweaks(), { "--shadow-y": "9px" });
  fireEvent.keyDown(point, { key: "ArrowDown", shiftKey: true });
  fireEvent.keyUp(point, { key: "ArrowDown" });
  assert.deepEqual(tweaks(), { "--shadow-y": "9px", "--shadow-blur": "44px" });
  assert.equal(point.getAttribute("aria-valuetext"), "Distance 9px, Blur 44px");
  // Each axis can be typed too.
  const blur = screen.getByRole("textbox", { name: "Shadow Blur value" });
  fireEvent.change(blur, { target: { value: "24" } });
  fireEvent.keyDown(blur, { key: "Enter" });
  assert.deepEqual(tweaks(), { "--shadow-y": "9px" });
});

test("words typed into a text control reach the page made safe for it", () => {
  render(<Harness initial={page()} calls={newCalls()} />);
  const headline = screen.getByRole("textbox", { name: "Headline" });
  fireEvent.change(headline, { target: { value: 'Say "hi"; <b>now</b>' } });
  fireEvent.keyDown(headline, { key: "Enter" });
  assert.deepEqual(tweaks(), { "data-headline": "Say “hi” bnow/b" });
});

test("a folder folds away, and stays folded the next time the page's controls are shown", () => {
  const view = render(<Harness initial={page()} calls={newCalls()} />);
  const shape = screen.getByRole("button", { name: "Shape" });
  assert.equal(shape.getAttribute("aria-expanded"), "true");
  fireEvent.click(shape);
  assert.equal(shape.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByRole("slider", { name: "Corners" }), null);
  // Controls outside the folder stay.
  assert.ok(screen.getByRole("textbox", { name: "Headline" }));
  view.unmount();
  render(<Harness initial={page()} calls={newCalls()} />);
  assert.equal(screen.getByRole("button", { name: "Shape" }).getAttribute("aria-expanded"), "false");
  assert.equal(screen.getByRole("button", { name: "Colour" }).getAttribute("aria-expanded"), "true");
});

test("a page's button is pressed through the page", () => {
  const calls = newCalls();
  render(<Harness initial={page()} calls={calls} />);
  fireEvent.click(screen.getByRole("button", { name: "Replay animation" }));
  assert.deepEqual(calls.action, ["replay"]);
  assert.equal(tweaks(), null, "a button changes no value");
});

test("versions: the current look is saved once, V1 goes back to the file, and a version can be deleted", async () => {
  const calls = newCalls();
  render(<Harness initial={page({ tweaks: { "--accent": "#ff0055" } })} calls={calls} />);
  const save = screen.getByRole("button", { name: "Save version" });
  fireEvent.click(save);
  assert.deepEqual(
    versions()?.map((version) => [version.name, version.tweaks]),
    [["V2", { "--accent": "#ff0055" }]],
  );
  await waitFor(() => assert.equal(calls.captures, 1));
  // That look is saved, so it can't be saved twice.
  assert.equal((save as HTMLButtonElement).disabled, true);
  assert.equal(screen.getByRole("button", { name: "V2" }).getAttribute("aria-pressed"), "true");

  fireEvent.click(screen.getByRole("button", { name: "V1" }));
  assert.equal(tweaks(), null);
  assert.equal(screen.getByRole("button", { name: "V1" }).getAttribute("aria-pressed"), "true");
  assert.equal(screen.getByRole("button", { name: "V2" }).getAttribute("aria-pressed"), "false");
  fireEvent.click(screen.getByRole("button", { name: "V2" }));
  assert.deepEqual(tweaks(), { "--accent": "#ff0055" });

  fireEvent.click(screen.getByRole("button", { name: "Show all" }));
  assert.equal(calls.showAll, 1);
  fireEvent.click(screen.getByRole("button", { name: "Delete V2" }));
  assert.equal(versions(), null);
  assert.equal(screen.queryByRole("button", { name: "Show all" }), null);
});

test("Send to Aiden hands over every value and marks the changed ones; Make default and Reset need a change", () => {
  const calls = newCalls();
  render(<Harness initial={page()} calls={calls} />);
  assert.equal((screen.getByRole("button", { name: "Make default" }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "Reset tweaks" }) as HTMLButtonElement).disabled, true);
  const typed = screen.getByRole("textbox", { name: "Corners value" });
  fireEvent.change(typed, { target: { value: "16" } });
  fireEvent.keyDown(typed, { key: "Enter" });

  fireEvent.click(screen.getByRole("button", { name: "Send to Aiden" }));
  assert.equal(calls.send.length, 1);
  const note = calls.send[0]!;
  assert.match(note, /Shape \/ Corners: 16px \(changed\)/u);
  assert.match(note, /Colour \/ Accent: #2f6fed$/mu);
  assert.doesNotMatch(note, /Replay animation/u);

  fireEvent.click(screen.getByRole("button", { name: "Make default" }));
  assert.equal(calls.makeDefault, 1);
  fireEvent.click(screen.getByRole("button", { name: "Reset tweaks" }));
  assert.equal(tweaks(), null);
});

test("Shuffle changes values inside each control's limits and leaves words alone", () => {
  render(<Harness initial={page({ tweaks: { "data-headline": "Kept" } })} calls={newCalls()} />);
  fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
  const shuffled = tweaks() ?? {};
  assert.equal(shuffled["data-headline"], "Kept");
  if (shuffled["--radius"] !== undefined) {
    const radius = Number.parseFloat(shuffled["--radius"]);
    assert.ok(radius >= 0 && radius <= 24 && radius % 2 === 0, `radius ${radius}`);
  }
});

test("the floating panel shows a page's controls, folds to its title and stays folded", async () => {
  const readSource = async () => ({
    text: `<script type="application/aiden-tweaks">${JSON.stringify({
      controls: [{ id: "promo", label: "Promo banner", type: "switch", default: true, attr: "data-promo" }],
    })}</script>`,
    truncated: false,
  });
  const ops = { update() {}, action: () => true, send: () => true, makeDefault() {}, capture: async () => null, showAll() {} };
  const view = render(<DesignTweaksFloat frame={page()} readSource={readSource} versionOf={() => 0} ops={ops} />);
  const fold = await screen.findByRole("button", { name: /Tweaks/u });
  assert.ok(screen.getByRole("switch", { name: "Promo banner" }));
  assert.ok(screen.getByRole("switch", { name: "Dark" }));
  act(() => fireEvent.click(fold));
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  view.unmount();
  render(<DesignTweaksFloat frame={page()} readSource={readSource} versionOf={() => 0} ops={ops} />);
  assert.equal((await screen.findByRole("button", { name: /Tweaks/u })).getAttribute("aria-expanded"), "false");
});

test("the floating panel stays away from a page without controls", async () => {
  let asked = 0;
  const readSource = async () => {
    asked += 1;
    return { text: "<html><body>No tweaks</body></html>", truncated: false };
  };
  const ops = { update() {}, action: () => true, send: () => true, makeDefault() {}, capture: async () => null, showAll() {} };
  const view = render(<DesignTweaksFloat frame={page()} readSource={readSource} versionOf={() => 0} ops={ops} />);
  await waitFor(() => assert.equal(asked, 1));
  await act(async () => undefined);
  assert.equal(view.container.innerHTML, "");
});

test("a version's picture is kept only if the page still shows that version when it is taken", async () => {
  const calls = newCalls();
  // Its own frame id: pictures are kept for the app run, across these tests.
  render(<Harness initial={page({ id: "pictured", tweaks: { "--accent": "#ff0055" } })} calls={calls} />);
  fireEvent.click(screen.getByRole("button", { name: "Save version" }));
  await waitFor(() => assert.equal(calls.captures, 1));
  const v1 = () => screen.getByRole("button", { name: "V1" });
  // V1, then straight away another value: by the time a picture could be taken the page shows neither.
  fireEvent.click(v1());
  const typed = screen.getByRole("textbox", { name: "Corners value" });
  fireEvent.change(typed, { target: { value: "16" } });
  fireEvent.keyDown(typed, { key: "Enter" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
  assert.equal(calls.captures, 1);
  assert.ok(!v1().querySelector("img"), "V1 has no picture of another look");
  // Shown and left alone, V1 gets its own picture.
  fireEvent.click(v1());
  await waitFor(() => assert.equal(calls.captures, 2), { timeout: 2000 });
  await waitFor(() => assert.ok(v1().querySelector("img")));
});
