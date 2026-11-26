import "../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, within } from "@testing-library/react";
import { OnboardingFeatureGallery, onboardingFeatures } from "./onboarding-feature-gallery.js";
import { visibleOnboardingFeatures } from "../lib/onboarding-provider.js";
import { hostPlatformCapabilities } from "../../main/services/host-platform-capabilities.js";
import { BotsArt, KeepGoingArt, ScheduledAutomationsArt } from "./onboarding-art/control-art.js";
import { ChatsThatRunChatsArt } from "./onboarding-art/chats-that-run-chats-art.js";

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

test("the Bots tile introduces the first Bot's set-up chat and still explains bounded plan approval", () => {
  const { container, unmount } = render(<OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />);
  const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="bots"]');
  assert.ok(tile);
  assert.equal(container.querySelectorAll('[data-onboarding-feature="bots"]').length, 1);
  assert.ok(within(tile).getByText("Your first Bot asks what you need and sets itself up. Bots remember, ask each other for help, run routines, hand steps back to you, and shrink into floating bubbles. Approve a whole plan in Aiden Agent or on your phone, follow its checklist, or stop it. Approval covers only listed actions within the Bot's access and limits, for this run and up to 60 minutes."));
  assert.match(tile.getAttribute("aria-label") ?? "", /Approve a whole plan in Aiden Agent or on your phone/u);
  assert.equal(tile.tabIndex, 0, "the tile remains reachable by keyboard");
  assert.ok(within(tile).getByText("COS replied"));
  unmount();
  cleanup();
});

test("the Bots illustration is the first Bot's chat: it asks, the person answers, it sets itself up, and it can float as a bubble", () => {
  const { container, unmount } = render(<BotsArt />);
  const art = within(container);
  const chat = art.getByRole("group", { name: "Chief's first chat" });
  assert.ok(art.getByText("Chief"));
  const ask = within(chat).getByRole("group", { name: "Chief asks what it should help with" });
  assert.ok(within(ask).getByText("What should I help with?"));
  assert.equal(within(within(ask).getByRole("list", { name: "Replies to tap" })).getAllByRole("listitem").length, 2);
  assert.ok(within(chat).getByRole("group", { name: "Your answer" }));
  assert.ok(within(within(chat).getByRole("group", { name: "Chief set itself up" })).getByText("Instructions updated · Undo"));
  assert.ok(art.getByText("Every Sunday at 9:00 AM"));
  assert.ok(art.getByText("COS replied"));
  // The chat can shrink into a floating head, which shows how many replies are unread.
  assert.ok(within(art.getByRole("group", { name: "Chief in a bubble" })).getByText("2"));
  assert.equal(art.queryAllByRole("button").length, 0, "the drawing does not add fake keyboard actions");
  // Only the shared oa-anim-* classes move, so Reduce Motion leaves a still pose.
  for (const element of container.querySelectorAll<HTMLElement>("[class*='anim']")) {
    for (const name of element.className.split(/\s+/u).filter((part) => part.includes("anim"))) {
      assert.match(name, /^oa-anim-[a-z]+$/u);
    }
  }
  unmount();
  cleanup();
});

test("the Helpers tile shows the helper list beside one helper's own chat: its task, its steps and its reply", () => {
  const { container, unmount } = render(<OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />);
  const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="subagents"]');
  assert.ok(tile);
  assert.match(tile.getAttribute("aria-label") ?? "", /^Helpers\. .*Each helper has its own chat/u);
  // The tile's art is aria-hidden, so look for the drawn chat with hidden elements included.
  const chat = within(tile).getByRole("group", { name: "Implementer's chat", hidden: true });
  assert.ok(within(chat).getByText("Implementer"), "the chat names the helper it belongs to");
  assert.ok(within(chat).getByRole("group", { name: "Task", hidden: true }), "the helper's task sits in the chat as its first message");
  assert.equal(within(within(chat).getByRole("list", { name: "Steps", hidden: true })).getAllByRole("listitem", { hidden: true }).length, 2);
  assert.ok(within(chat).getByRole("group", { name: "Reply", hidden: true }));
  assert.ok(within(tile).getByText("Running"), "the helper list is still drawn beside the chat");
  assert.equal(tile.querySelectorAll("img").length, 0, "the helper chat is code-drawn");
  for (const element of tile.querySelectorAll<HTMLElement>("[class*='anim']")) {
    for (const name of element.className.split(/\s+/u).filter((part) => part.includes("anim"))) {
      assert.match(name, /^oa-anim-[a-z]+$/u, "only the shared motion classes move, so Reduce Motion leaves a still pose");
    }
  }
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

test("Mac and Linux tours introduce Apps using Aiden with its local-only switch and access levels; other hosts leave it out", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const host = hostPlatformCapabilities(platform, "x64");
    const features = visibleOnboardingFeatures(onboardingFeatures, host);
    const { container, unmount } = render(<OnboardingFeatureGallery features={features} platform={host.platform} />);
    const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="otherApps"]');
    if (host.mcpServer) {
      assert.ok(tile, `${platform} can host the MCP server, so the tour shows it`);
      assert.match(tile.getAttribute("aria-label") ?? "", /^Apps using Aiden\. .*Settings → Connections → Apps using Aiden; nothing listens until you do\./u);
      const art = within(tile);
      assert.ok(art.getByText("Let apps use Aiden"), "the drawing shows the real switch label");
      assert.ok(art.getByText(platform === "darwin" ? "This Mac only" : "This computer only"), "the local-only chip names this computer as the platform does");
      assert.match(tile.getAttribute("aria-label") ?? "", platform === "darwin" ? /on this Mac/u : /on this computer/u);
      assert.ok(art.getByText("Supervised"));
      assert.ok(art.getByText("Read only"));
      assert.equal(tile.querySelectorAll("img").length, 0, "the settings slice is code-drawn");
    } else assert.ok(tile === null, `${platform} has no MCP server to point at`);
    unmount();
  }
  assert.equal(
    visibleOnboardingFeatures(onboardingFeatures, { ...hostPlatformCapabilities("darwin", "arm64"), mcpServer: false }).some((feature) => feature.id === "otherApps"),
    false,
  );
});

test("the Browser & Annotations tile introduces React/DOM element grabbing with code-drawn art", () => {
  const { container, unmount } = render(<OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />);
  const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="browser"]');
  assert.ok(tile, "browser tile renders");
  assert.match(tile.getAttribute("aria-label") ?? "", /grab React or DOM components directly into the composer/u);
  const art = within(tile);
  assert.ok(art.getByText("<PricingCard />"), "code-drawn art shows a grabbed component chip");
  assert.equal(tile.querySelectorAll("img").length, 0, "browser tile art stays code-drawn");
  for (const element of tile.querySelectorAll<HTMLElement>("[class*='anim']")) {
    for (const name of element.className.split(/\s+/u).filter((part) => part.includes("anim"))) {
      assert.match(name, /^oa-anim-[a-z]+$/u);
    }
  }
  unmount();
  cleanup();
});

test("the Scheduled Automations tile shows a task's result posted in its chat and the chat's check-back", () => {
  const { container, unmount } = render(<OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />);
  const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="schedules"]');
  assert.ok(tile);
  assert.match(tile.getAttribute("aria-label") ?? "", /A task made in a chat posts each result there, and Aiden can check back in a chat later\./u);
  unmount();
  cleanup();

  const art = render(<ScheduledAutomationsArt />);
  const view = within(art.container);
  const chat = view.getByRole("group", { name: "A scheduled task's run in the chat it was made in" });
  const card = within(chat).getByRole("group", { name: "Scheduled task card" });
  assert.ok(within(card).getByText("Scheduled task"));
  assert.ok(within(card).getByText("Every day at 9:00 AM"));
  const chips = within(view.getByRole("list", { name: "Chat chips" })).getAllByRole("listitem");
  assert.deepEqual(chips.map((chip) => chip.textContent), ["Checking back at 3:10 PM", "next 9:00 AM"]);
  assert.equal(art.container.querySelectorAll("img").length, 0, "the chat is code-drawn");
  assert.equal(view.queryAllByRole("button").length, 0, "the drawing does not add fake keyboard actions");
  for (const element of art.container.querySelectorAll<HTMLElement>("[class*='anim']")) {
    for (const name of element.className.split(/\s+/u).filter((part) => part.includes("anim"))) {
      assert.match(name, /^oa-anim-[a-z]+$/u);
    }
  }
  art.unmount();
});

test("the Keep Going Until Done tile shows a round's card in the chat and the goal bar over the composer", () => {
  const { container, unmount } = render(<OnboardingFeatureGallery features={onboardingFeatures} platform="darwin" />);
  const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="keepGoing"]');
  assert.ok(tile, "keep-going goals are part of the tour");
  assert.match(tile.getAttribute("aria-label") ?? "", /^Keep Going Until Done\. Give a chat a goal with \/goal.*only your Start begins one\./u);
  assert.equal(tile.tabIndex, 0, "the tile is reachable by keyboard");
  unmount();
  cleanup();

  const art = render(<KeepGoingArt />);
  const view = within(art.container);
  const chat = view.getByRole("group", { name: "A chat working toward its goal" });
  assert.ok(within(within(chat).getByRole("group", { name: "Round card" })).getByText("Keep going · round 3 of 50"));
  const bar = view.getByRole("group", { name: "Goal bar" });
  assert.ok(within(bar).getByText("Working · round 3 of 50"));
  assert.ok(within(bar).getByText("Pause"));
  assert.equal(art.container.querySelectorAll("img").length, 0, "the chat is code-drawn");
  assert.equal(view.queryAllByRole("button").length, 0, "the drawing does not add fake keyboard actions");
  for (const element of art.container.querySelectorAll<HTMLElement>("[class*='anim']")) {
    for (const name of element.className.split(/\s+/u).filter((part) => part.includes("anim"))) {
      assert.match(name, /^oa-anim-[a-z]+$/u);
    }
  }
  art.unmount();
});

test("Mac and Linux tours show a chat's started chats working, waiting for you and done; other hosts leave the tile out", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const host = hostPlatformCapabilities(platform, "arm64");
    const shown = visibleOnboardingFeatures(onboardingFeatures, { ...host, designMode: true });
    const { container, unmount } = render(<OnboardingFeatureGallery features={shown} platform={platform === "linux" ? "linux" : "darwin"} />);
    const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="chatsRunChats"]');
    if (platform === "win32") assert.equal(tile, null, "no desktop host there runs started chats");
    else {
      assert.ok(tile, `${platform} can run started chats`);
      assert.match(tile.getAttribute("aria-label") ?? "", /^Chats that run chats\. .*Their approvals still come to you, and Stop all ends the ones you haven't taken over\./u);
    }
    unmount();
    cleanup();
  }

  const art = render(<ChatsThatRunChatsArt />);
  const view = within(art.container);
  assert.ok(view.getByText("3 chats working"));
  const rows = within(view.getByRole("list", { name: "Started chats" })).getAllByRole("listitem");
  assert.deepEqual(rows.map((row) => row.textContent), ["Working", "Needs you", "Done"]);
  assert.equal(art.container.querySelectorAll("img").length, 0, "the list is code-drawn");
  assert.equal(view.queryAllByRole("button").length, 0, "the drawing does not add fake keyboard actions");
  for (const element of art.container.querySelectorAll<HTMLElement>("[class*='anim']")) {
    for (const name of element.className.split(/\s+/u).filter((part) => part.includes("anim"))) {
      assert.match(name, /^oa-anim-[a-z]+$/u);
    }
  }
  art.unmount();
});

test("the Floating Quick Chat tile is code-drawn, platform-aware, and uses only oa-anim-* classes", () => {
  for (const [platform, expectedHotkey] of [
    ["darwin", "⌘⇧Space"],
    ["linux", "Ctrl+Shift+Space"],
  ] as const) {
    const { container, unmount } = render(
      <OnboardingFeatureGallery features={onboardingFeatures} platform={platform} />,
    );
    const tile = container.querySelector<HTMLElement>('[data-onboarding-feature="quickChat"]');
    assert.ok(tile, `${platform} includes the Floating Quick Chat tile`);
    assert.match(tile.getAttribute("aria-label") ?? "", /^Floating Quick Chat\./u);
    assert.ok(within(tile).getByText("Temporary"));
    assert.ok(within(tile).getByText("Attach…"));
    assert.ok(within(tile).getByText(expectedHotkey));
    assert.equal(tile.querySelectorAll("img").length, 0, "Quick Chat art is code-drawn");
    assert.equal(within(tile).queryAllByRole("button").length, 0, "art has no fake buttons");
    for (const element of tile.querySelectorAll<HTMLElement>("[class*='anim']")) {
      for (const name of element.className.split(/\s+/u).filter((part) => part.includes("anim"))) {
        assert.match(name, /^oa-anim-[a-z]+$/u);
      }
    }
    unmount();
    cleanup();
  }
});
