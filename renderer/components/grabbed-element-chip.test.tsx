import "../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  GRAB_POPOVER_CLOSE_DELAY_MS,
  GRAB_POPOVER_OPEN_DELAY_MS,
  GrabbedElementChips,
  formatGrabbedComponentHierarchy,
  formatGrabbedSourceLocation,
} from "./grabbed-element-chip";
import {
  GRABBED_ELEMENT_SCHEMA_VERSION,
  grabbedElementThumbnailId,
  type GrabbedElementContextV1,
} from "../shared/browser-element-grab";
import type { Attachment } from "../lib/types";

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

function sampleReactElement(overrides: Partial<GrabbedElementContextV1> = {}): GrabbedElementContextV1 {
  const id = overrides.id ?? "el-hero";
  return {
    version: GRABBED_ELEMENT_SCHEMA_VERSION,
    id,
    label: "<LandingHeroClient />",
    framework: "react",
    componentName: "LandingHeroClient",
    componentStack: [
      { name: "LandingHeroClient", environment: "client", source: { filePath: "app/hero.tsx", line: 42, column: 5 } },
      { name: "LandingPage", environment: "server" },
      { name: "Home" },
    ],
    source: { filePath: "app/hero.tsx", line: 42, column: 5, symbolicated: true },
    props: { variant: "primary", featured: true },
    tagName: "section",
    selector: "main > section.hero",
    htmlSnippet: '<section class="hero"><h1>Hello</h1></section>',
    computedStyles: { display: "flex", gap: "16px" },
    boundingBox: { x: 24, y: 120, width: 800, height: 320 },
    pageUrl: "http://localhost:3000/",
    pageTitle: "Landing",
    thumbnailAttachmentId: grabbedElementThumbnailId(id),
    capturedAt: 1700000000000,
    ...overrides,
  };
}

function sampleThumbnailAttachment(elementId = "el-hero"): Attachment {
  return {
    id: grabbedElementThumbnailId(elementId),
    name: "LandingHeroClient.png",
    kind: "image",
    mimeType: "image/png",
    size: 68,
    data: ONE_PIXEL_PNG_B64,
  };
}

afterEach(cleanup);

test("renders two sibling buttons per chip (zero nested interactive controls) and removes via inline ×", () => {
  const removed: string[] = [];
  const element = sampleReactElement();
  const { container } = render(
    <GrabbedElementChips
      elements={[element]}
      attachments={[sampleThumbnailAttachment(element.id)]}
      onRemove={(id) => removed.push(id)}
    />,
  );

  const chip = container.querySelector<HTMLLIElement>(`[data-grabbed-element-chip="${element.id}"]`);
  assert.ok(chip, "chip list item renders");
  const trigger = screen.getByRole("button", { name: "Inspect browser element <LandingHeroClient />" });
  const remove = screen.getByRole("button", { name: "Remove <LandingHeroClient />" });
  assert.equal(trigger.contains(remove), false, "remove button is a sibling, not nested inside trigger");
  assert.equal(remove.contains(trigger), false, "trigger is not nested inside remove button");

  fireEvent.click(remove);
  assert.deepEqual(removed, [element.id]);
});

test("hover previews after 250ms and closes after 140ms grace; clicking pins and expanding details auto-pins", async () => {
  const element = sampleReactElement();
  render(
    <GrabbedElementChips
      elements={[element]}
      attachments={[sampleThumbnailAttachment(element.id)]}
      onRemove={() => undefined}
    />,
  );

  const trigger = screen.getByRole("button", { name: "Inspect browser element <LandingHeroClient />" });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  // Hover preview opens after 250ms without pinning.
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRAB_POPOVER_OPEN_DELAY_MS + 40));
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const popover = document.querySelector<HTMLElement>(`[data-grabbed-element-popover="${element.id}"]`);
  assert.ok(popover, "popover renders on hover");
  assert.equal(popover.getAttribute("data-slot"), "popover-content", "carries browser occluder slot");
  assert.equal(popover.getAttribute("data-pinned"), "false");
  const labelledBy = popover.getAttribute("aria-labelledby");
  assert.ok(labelledBy, "popover has an accessible name via aria-labelledby");
  assert.equal(document.getElementById(labelledBy)?.textContent, "Included with your message");
  assert.ok(popover.textContent?.includes("Included with your message"));
  assert.ok(popover.textContent?.includes("LandingHeroClient in LandingPage (Server) › Home"));
  assert.ok(popover.querySelector("img"), "cropped thumbnail renders inside popover");

  // Moving into popover and expanding details auto-pins so pointer leave keeps it open.
  fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
  fireEvent.pointerEnter(popover, { pointerType: "mouse" });
  const detailsToggle = popover.querySelector<HTMLButtonElement>("[data-grabbed-element-details-toggle]");
  assert.ok(detailsToggle, "disclosure toggle renders");
  assert.equal(detailsToggle.getAttribute("aria-expanded"), "false");

  fireEvent.click(detailsToggle);
  assert.equal(detailsToggle.getAttribute("aria-expanded"), "true");
  assert.equal(popover.getAttribute("data-pinned"), "true", "expanding details auto-pins popover");
  assert.ok(popover.textContent?.includes("app/hero.tsx:42:5"), "source location revealed");
  assert.ok(popover.textContent?.includes("main > section.hero"), "selector revealed");

  // Leaving the pinned popover does not close it after grace period.
  fireEvent.pointerLeave(popover, { pointerType: "mouse" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRAB_POPOVER_CLOSE_DELAY_MS + 40));
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "pinned popover stays open after leave");

  // Clicking the trigger toggles the pinned popover closed.
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("unpinned hover popover closes after grace delay on pointer leave", async () => {
  const element = sampleReactElement({ id: "el-leave" });
  render(<GrabbedElementChips elements={[element]} onRemove={() => undefined} />);

  const trigger = screen.getByRole("button", { name: "Inspect browser element <LandingHeroClient />" });
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRAB_POPOVER_OPEN_DELAY_MS + 40));
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");

  fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRAB_POPOVER_CLOSE_DELAY_MS + 40));
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("copy context auto-pins and writes deterministic prompt text to clipboard", async () => {
  const written: string[] = [];
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
  try {
    const element = sampleReactElement({ id: "el-copy" });
    render(<GrabbedElementChips elements={[element]} onRemove={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "Inspect browser element <LandingHeroClient />" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, GRAB_POPOVER_OPEN_DELAY_MS + 40));
    });
    const copyButton = screen.getByRole("button", { name: "Copy element context" });
    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });
    assert.equal(written.length, 1);
    assert.match(written[0]!, /<attached-browser-elements>/u);
    assert.match(written[0]!, /LandingHeroClient/u);
    assert.doesNotMatch(written[0]!, /1700000000000/u);
    const popover = document.querySelector<HTMLElement>(`[data-grabbed-element-popover="${element.id}"]`);
    assert.equal(popover?.getAttribute("data-pinned"), "true", "copying auto-pins popover");
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  }
});

test("text-only models show non-blocking note in composer and popover; transcript mode is read-only", () => {
  const domElement = sampleReactElement({
    id: "el-dom",
    label: "img",
    framework: "dom",
    componentName: undefined,
    componentStack: undefined,
    source: undefined,
    tagName: "img",
    selector: "figure > img.hero-photo",
  });

  const { rerender } = render(
    <GrabbedElementChips
      elements={[domElement]}
      mode="composer"
      textOnlyModel
      onRemove={() => undefined}
    />,
  );
  assert.ok(document.querySelector("[data-grabbed-elements-text-only-hint]"));
  assert.ok(screen.getByText("Text context only for this model"));

  const trigger = screen.getByRole("button", { name: "Inspect browser element img" });
  fireEvent.click(trigger);
  const popover = document.querySelector<HTMLElement>('[data-grabbed-element-popover="el-dom"]');
  assert.ok(popover?.querySelector("[data-grabbed-element-text-only-note]"));
  assert.ok(popover?.textContent?.includes("figure > img.hero-photo"), "plain DOM shows Selector row");

  rerender(<GrabbedElementChips elements={[domElement]} mode="transcript" />);
  assert.equal(screen.queryByRole("button", { name: "Remove img" }), null, "transcript hides remove button");
  assert.equal(document.querySelector("[data-grabbed-elements-text-only-hint]"), null);
  assert.ok(popover?.textContent?.includes("Included with message"));
});

test("formatting helpers produce expected source location and hierarchy strings", () => {
  assert.equal(formatGrabbedSourceLocation({ filePath: "src/App.tsx", line: 12, column: 3 }), "src/App.tsx:12:3");
  assert.equal(formatGrabbedSourceLocation({ filePath: "src/App.tsx", line: 12 }), "src/App.tsx:12");
  assert.equal(formatGrabbedSourceLocation({ filePath: "src/App.tsx" }), "src/App.tsx");
  assert.equal(
    formatGrabbedComponentHierarchy(sampleReactElement()),
    "LandingHeroClient in LandingPage (Server) › Home",
  );
  assert.equal(
    formatGrabbedComponentHierarchy(
      sampleReactElement({ componentStack: undefined, componentName: "FallbackComp" }),
    ),
    "FallbackComp",
  );
  assert.equal(
    formatGrabbedComponentHierarchy(
      sampleReactElement({ componentStack: undefined, componentName: undefined }),
    ),
    null,
  );
});

test("Escape closes an open inspection popover and returns focus to the chip trigger", () => {
  const element = sampleReactElement({ id: "el-esc" });
  render(<GrabbedElementChips elements={[element]} onRemove={() => undefined} />);

  const trigger = screen.getByRole("button", { name: "Inspect browser element <LandingHeroClient />" });
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");

  const detailsToggle = document.querySelector<HTMLButtonElement>("[data-grabbed-element-details-toggle]");
  assert.ok(detailsToggle);
  detailsToggle.focus();
  fireEvent.keyDown(detailsToggle, { key: "Escape" });

  assert.equal(trigger.getAttribute("aria-expanded"), "false", "Escape dismisses popover");
  assert.equal(document.activeElement, trigger, "focus returns to chip trigger");
});
