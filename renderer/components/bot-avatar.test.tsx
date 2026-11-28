import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { BotAvatar, useBotAvatarState } from "./bot-avatar";
import { BOT_SPRITE_TONES, type BotAvatarActivityInput } from "../shared/bot-sprite";

afterEach(cleanup);

/** The shared sprite contract iOS and Android draw from too. */
const contract = JSON.parse(
  readFileSync(
    new URL("../../protocol/aiden-remote/v1/fixtures/contract.json", import.meta.url),
    "utf8",
  ),
).botAvatarSprite as { smallGlintHex: string };

const AVATAR = { version: 1, shape: "drop", color: "peach" } as const;

function sprite(container: HTMLElement) {
  return container.querySelector<SVGSVGElement>("svg.bot-sprite");
}

/** Fills of the sprite's body cells, upper-cased so they compare against the tone table. */
function bodyFills(container: HTMLElement) {
  return [...container.querySelectorAll("rect[data-cell]")].map((rect) =>
    rect.getAttribute("fill")?.toUpperCase(),
  );
}

test("a thinking Bot is live and shows its thought dots", () => {
  installBotTestIpc();
  const { container } = render(<BotAvatar avatar={AVATAR} name="Chief" state="thinking" />);
  const root = container.querySelector<HTMLElement>(".bot-avatar");
  assert.equal(root?.dataset.state, "thinking");
  assert.equal(root?.hasAttribute("data-live"), true);
  assert.equal(root?.hasAttribute("data-working"), true);
  assert.equal(sprite(container)?.dataset.state, "thinking");
  assert.equal(container.querySelectorAll('[data-sprite-prop="think"] rect').length, 3);
  assert.equal(container.querySelector('[data-sprite-prop="plug"]'), null);
});

test("each working state carries its own prop and the resting faces carry none", () => {
  installBotTestIpc();
  const props = (state: "tool" | "editing" | "writing" | "idle" | "done") => {
    const { container, unmount } = render(<BotAvatar avatar={AVATAR} name="Chief" state={state} />);
    const found = [...container.querySelectorAll("[data-sprite-prop]")].map((node) =>
      node.getAttribute("data-sprite-prop"),
    );
    unmount();
    return found;
  };
  assert.deepEqual(props("tool"), ["plug"]);
  assert.deepEqual(props("editing"), ["cursor"]);
  assert.deepEqual(props("writing"), []);
  assert.deepEqual(props("idle"), []);
  assert.deepEqual(props("done"), []);
});

test("an avatar with no state is a static idle sprite", () => {
  installBotTestIpc();
  const { container } = render(<BotAvatar avatar={AVATAR} name="Chief" />);
  const root = container.querySelector<HTMLElement>(".bot-avatar");
  assert.equal(root?.dataset.state, "idle");
  assert.equal(root?.hasAttribute("data-live"), false);
  assert.equal(root?.hasAttribute("data-working"), false);
});

test("small tiles draw the small cut without highlight cells; large tiles keep them", () => {
  installBotTestIpc();
  const light = BOT_SPRITE_TONES.peach.light.toUpperCase();
  const small = render(<BotAvatar avatar={AVATAR} name="Chief" size="small" />);
  assert.equal(sprite(small.container)?.dataset.cut, "small");
  assert.ok(!bodyFills(small.container).includes(light));
  small.unmount();
  const large = render(<BotAvatar avatar={AVATAR} name="Chief" size="large" />);
  assert.equal(sprite(large.container)?.dataset.cut, "full");
  assert.ok(bodyFills(large.container).includes(light));
});

test("the small cut reaches up to a 24 px face and stops above it", () => {
  installBotTestIpc();
  const cut = (size: "small" | "medium" | "large") => {
    const { container, unmount } = render(<BotAvatar avatar={AVATAR} name="Chief" size={size} />);
    const found = sprite(container)?.dataset.cut;
    unmount();
    return found;
  };
  assert.equal(cut("small"), "small");
  assert.equal(cut("medium"), "small");
  assert.equal(cut("large"), "full");
});

/** Fills of the open eyes, and strokes of the happy or wince marks, upper-cased. */
function eyeFills(container: HTMLElement) {
  return [...container.querySelectorAll(".bs-eye")].map((eye) =>
    eye.getAttribute("fill")?.toUpperCase(),
  );
}
function markStroke(container: HTMLElement, mark: ".bs-happy" | ".bs-wince") {
  return container.querySelector(mark)?.getAttribute("stroke")?.toUpperCase();
}
const num = (rect: Element, name: string) => Number(rect.getAttribute(name));
/** Every fill and stroke drawn in the sprite, upper-cased. */
function paints(container: HTMLElement) {
  return [...container.querySelectorAll("svg.bot-sprite *")].flatMap((node) =>
    ["fill", "stroke"].map((name) => node.getAttribute(name)?.toUpperCase()).filter(Boolean),
  );
}

test("small-cut open eyes are deep with the contract's white glint at each eye's top-left", () => {
  installBotTestIpc();
  const white = contract.smallGlintHex.toUpperCase();
  const deep = BOT_SPRITE_TONES.peach.deep.toUpperCase();
  for (const state of [
    "idle",
    "thinking",
    "reading",
    "tool",
    "writing",
    "editing",
    "waiting",
  ] as const) {
    const { container, unmount } = render(
      <BotAvatar avatar={AVATAR} name="Chief" size="small" state={state} />,
    );
    const eyes = [...container.querySelectorAll(".bs-eye")];
    const glints = [...container.querySelectorAll(".bs-glint")];
    assert.equal(eyes.length, 2, state);
    assert.ok(
      eyeFills(container).every((fill) => fill === deep),
      state,
    );
    assert.equal(glints.length, 2, state);
    eyes.forEach((eye, index) => {
      const glint = glints[index]!;
      assert.equal(glint.getAttribute("fill")?.toUpperCase(), white, state);
      assert.equal(num(glint, "x"), num(eye, "x"), `${state} glint x`);
      assert.equal(num(glint, "y"), num(eye, "y"), `${state} glint y`);
      const side = Math.min(num(eye, "width"), num(eye, "height")) * 0.42;
      assert.ok(
        Math.abs(num(glint, "width") - side) < 1e-9 && Math.abs(num(glint, "height") - side) < 1e-9,
        state,
      );
      // The glint closes with the lid that the blink, reading and editing poses scale.
      assert.ok(glint.closest(".bs-lid"), `${state} glint rides the lid`);
    });
    unmount();
  }
});

test("happy and wince marks at the small cut are deep, with no white glint", () => {
  installBotTestIpc();
  const deep = BOT_SPRITE_TONES.peach.deep.toUpperCase();
  const white = contract.smallGlintHex.toUpperCase();
  const done = render(<BotAvatar avatar={AVATAR} name="Chief" size="small" state="done" />);
  assert.equal(markStroke(done.container, ".bs-happy"), deep);
  assert.deepEqual(eyeFills(done.container), []);
  assert.ok(!paints(done.container).includes(white));
  done.unmount();
  const error = render(<BotAvatar avatar={AVATAR} name="Chief" size="small" state="error" />);
  assert.equal(markStroke(error.container, ".bs-wince"), deep);
  assert.ok(!paints(error.container).includes(white));
});

test("full-size open eyes keep the deep tone and the light glint", () => {
  installBotTestIpc();
  const { container } = render(
    <BotAvatar avatar={AVATAR} name="Chief" size="large" state="thinking" />,
  );
  const tones = BOT_SPRITE_TONES.peach;
  assert.ok(eyeFills(container).every((fill) => fill === tones.deep.toUpperCase()));
  const glints = [...container.querySelectorAll(".bs-glint")].map((glint) =>
    glint.getAttribute("fill")?.toUpperCase(),
  );
  assert.ok(glints.length > 0);
  assert.ok(glints.every((fill) => fill === tones.light.toUpperCase()));
});

test("a profile photo replaces the sprite, and a working Bot's photo gets the glance badge", async () => {
  installBotTestIpc({
    "bots:getCanonicalPhoto": () => ({
      assetRevision: "photo-1",
      dataUrl: "data:image/png;base64,AAAA",
    }),
  });
  const { container } = render(
    <BotAvatar
      avatar={AVATAR}
      botId="bot-1"
      name="Chief"
      photoLoading="immediate"
      state="thinking"
    />,
  );
  await waitFor(() => assert.ok(container.querySelector("img")));
  assert.equal(sprite(container), null);
  assert.equal(container.querySelector(".bot-avatar")?.hasAttribute("data-working"), true);
  assert.ok(container.querySelector("img + span svg"), "glance badge over the photo");
});

test("a card answered while no turn runs settles quietly, with no done moment", () => {
  const { result, rerender } = renderHook(
    (input: BotAvatarActivityInput) => useBotAvatarState(input),
    {
      initialProps: { session: "idle", awaitingPerson: true },
    },
  );
  assert.equal(result.current, "waiting");
  rerender({ session: "idle", awaitingPerson: false });
  assert.equal(result.current, "idle");
});

test("a card answered mid-turn still ends with done once the turn finishes", async () => {
  const { result, rerender } = renderHook(
    (input: BotAvatarActivityInput) => useBotAvatarState(input),
    {
      initialProps: {
        session: "running",
        phase: "command",
        awaitingPerson: true,
      } as BotAvatarActivityInput,
    },
  );
  assert.equal(result.current, "waiting");
  rerender({ session: "running", phase: "command" });
  await waitFor(() => assert.equal(result.current, "tool"));
  rerender({ session: "idle" });
  assert.equal(result.current, "done");
});

test("a stopped turn settles quietly, and the next turn still ends with done", async () => {
  const { result, rerender } = renderHook(
    (input: BotAvatarActivityInput) => useBotAvatarState(input),
    {
      initialProps: { session: "running", phase: "stopping" } as BotAvatarActivityInput,
    },
  );
  assert.equal(result.current, "thinking");
  rerender({ session: "running", phase: null });
  rerender({ session: "idle", phase: null });
  assert.equal(result.current, "idle");
  // A later turn the row knows only as running: its end is a normal one.
  rerender({ session: "running", phase: null });
  await waitFor(() => assert.equal(result.current, "thinking"));
  rerender({ session: "idle", phase: null });
  assert.equal(result.current, "done");
});
