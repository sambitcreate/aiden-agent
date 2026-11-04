import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, within } from "@testing-library/react";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery.js";
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
