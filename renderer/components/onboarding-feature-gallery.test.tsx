import "../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, within } from "@testing-library/react";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery.js";
import { visibleOnboardingFeatures } from "../lib/onboarding-provider.js";
import { hostPlatformCapabilities } from "../../main/services/host-platform-capabilities.js";

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
