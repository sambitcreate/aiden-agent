import "../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, within } from "@testing-library/react";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery.js";
import { visibleOnboardingFeatures } from "../lib/onboarding-provider.js";
import { hostPlatformCapabilities } from "../../main/services/host-platform-capabilities.js";
import { BotsArt } from "./onboarding-art/control-art.js";

/** A stand-in for the browser's IntersectionObserver that the test scrolls by hand. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  scroll(target: Element, isIntersecting: boolean) {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
afterEach(cleanup);

test("Mac and Linux tours show a Calendar watch example while unsupported Bots hosts withhold the tile", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const host = hostPlatformCapabilities(platform, "x64");
    const features = visibleOnboardingFeatures(onboardingFeatures, host);
    const { container, unmount } = render(<OnboardingFeatureGallery features={features} platform={host.platform} />);
    const tile = container.querySelector('[data-onboarding-feature="botWatches"]');
    if (host.bots) {
      assert.ok(tile, `${platform} explains its available connected-app watches`);
      assert.ok(within(container).getByRole("article", { name: /^Connected-app watches\. Watch upcoming Calendar events on Mac or Linux/u }));
      assert.ok(within(tile as HTMLElement).getByText("Calendar · Team events"));
      assert.ok(within(tile as HTMLElement).getByText("Next 2 hours"));
      assert.ok(within(tile as HTMLElement).getByText(/Calendar events on Mac or Linux, or a Mail mailbox on Mac/u));
      assert.equal(tile.querySelectorAll("img").length, 0, "the Calendar example remains code-drawn");
    } else assert.equal(tile, null);
    unmount();
  }
  assert.equal(visibleOnboardingFeatures(onboardingFeatures, { ...hostPlatformCapabilities("linux"), bots: false }).some((feature) => feature.id === "botWatches"), false);
});

test("the existing Bots tile explains bounded plan approval alongside collaboration, routines, and hand-offs", () => {
  const { container, unmount } = render(<OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />);
  const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="bots"]');
  assert.ok(tile);
  assert.equal(container.querySelectorAll('[data-onboarding-feature="bots"]').length, 1);
  assert.ok(within(tile).getByText("Bots remember, ask each other for help, run routines, and hand steps back to you. Approve a whole plan on desktop or phone, follow its checklist, or stop it. Approval covers only listed actions within the Bot's access and limits, for this run and up to 60 minutes."));
  assert.match(tile.getAttribute("aria-label") ?? "", /Approve a whole plan on desktop or phone/u);
  assert.equal(tile.tabIndex, 0, "the tile remains reachable by keyboard");
  assert.ok(within(tile).getByText("COS replied"));
  unmount();
  cleanup();
});

test("the Bots illustration shows an approved plan's checklist, bounded coverage, and Stop alongside existing Bot work", () => {
  const { container, unmount } = render(<BotsArt />);
  const art = within(container);
  const plan = art.getByRole("group", { name: "Meal Planner's approved plan" });
  assert.ok(within(plan).getByText("Approved · ends in 45 min"));
  const steps = within(plan).getByRole("list", { name: "Plan steps" });
  assert.equal(within(steps).getAllByRole("listitem").length, 2);
  assert.ok(within(steps).getByRole("img", { name: "Done" }));
  assert.ok(within(steps).getByRole("img", { name: "Pending" }));
  const coverage = within(plan).getByRole("list", { name: "Plan coverage" });
  assert.ok(within(coverage).getByText("Calendar · create events (up to 5)"));
  assert.ok(within(coverage).getByText("1 of 5 used"));
  assert.ok(within(plan).getByText("Stop plan"));
  assert.ok(within(plan).getByText("Show details"));
  assert.ok(art.getByText("Needs you"));
  assert.ok(art.getByText("Every Sunday at 9:00 AM"));
  assert.ok(art.getByText("COS replied"));
  assert.equal(art.queryAllByRole("button").length, 0, "the drawing does not add fake keyboard actions");
  unmount();
  cleanup();
});

test("a feature tile scrolled out of the gallery is marked off-screen so its looping art holds still", () => {
  const { container, unmount } = render(<OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />);
  const tiles = Array.from(container.querySelectorAll("[data-onboarding-feature]"));
  assert.equal(tiles.length, onboardingFeatures.length);
  const [observer] = FakeIntersectionObserver.instances;
  assert.ok(observer, "the gallery watches its tiles");
  assert.ok(tiles.every((tile) => observer.targets.has(tile)), "every tile is watched");

  const [first, second] = tiles;
  observer.scroll(first!, false);
  observer.scroll(second!, true);
  assert.equal(first!.hasAttribute("data-offscreen"), true, "a tile scrolled away pauses");
  assert.equal(second!.hasAttribute("data-offscreen"), false, "a visible tile keeps animating");
  observer.scroll(first!, true);
  assert.equal(first!.hasAttribute("data-offscreen"), false, "back in view, it runs again");

  unmount();
  assert.equal(observer.targets.size, 0, "leaving onboarding stops watching the tiles");
  cleanup();
});

test("the Design Mode tile shows a canvas with a page, a comment pin and Send, and leaves the tour when design mode is off", () => {
  const host = hostPlatformCapabilities("linux", "x64");
  const features = visibleOnboardingFeatures(onboardingFeatures, { ...host, designMode: true });
  const { container, unmount } = render(<OnboardingFeatureGallery features={features} platform={host.platform} />);
  const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="designMode"]');
  assert.ok(tile, "design mode is part of the tour");
  assert.match(tile.getAttribute("aria-label") ?? "", /^Design Mode\. Turn a chat into a design canvas/u);
  const art = within(tile);
  assert.ok(art.getByText("hero.html"), "a live page sits on the canvas");
  assert.ok(art.getByText("1 comment"), "the tray holds the comment for Aiden");
  assert.ok(art.getByText("Send"));
  assert.equal(tile.querySelectorAll("img").length, 0, "the canvas is code-drawn");
  unmount();
  assert.equal(
    visibleOnboardingFeatures(onboardingFeatures, { ...host, designMode: false }).some((feature) => feature.id === "designMode"),
    false,
    "AIDEN_DESIGN_MODE=0 keeps the tile out",
  );
});
