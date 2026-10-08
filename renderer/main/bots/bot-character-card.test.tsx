import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR, type BotAvatar, type BotAvatarAppearance } from "../../shared/bots";
import { BotCharacterCard } from "./bot-character-card";

afterEach(cleanup);

function Harness({ initial, onSave }: { initial: BotAvatar; onSave(avatar: BotAvatarAppearance): void }) {
  const [avatar, setAvatar] = React.useState<BotAvatar>(initial);
  return (
    <BotCharacterCard
      avatar={avatar}
      onChange={(next) => {
        setAvatar(next);
        onSave(next);
      }}
    />
  );
}

test("picking a colour and a shape changes only the Bot's character", () => {
  const saved: BotAvatarAppearance[] = [];
  render(<Harness initial={{ ...DEFAULT_BOT_AVATAR }} onSave={(avatar) => saved.push(avatar)} />);

  const colours = screen.getByRole("radiogroup", { name: "Colour" });
  fireEvent.click(within(colours).getByRole("radio", { name: "Mint" }));
  const shapes = screen.getByRole("radiogroup", { name: "Shape" });
  fireEvent.click(within(shapes).getByRole("radio", { name: "Hex" }));

  assert.deepEqual(saved[saved.length - 1], { ...DEFAULT_BOT_AVATAR, color: "mint", shape: "hex" });
  assert.equal(within(colours).getByRole("radio", { name: "Mint" }).getAttribute("aria-checked"), "true");
  assert.equal(within(shapes).getByRole("radio", { name: "Hex" }).getAttribute("aria-checked"), "true");
});

test("Reset to default restores the default character", () => {
  const saved: BotAvatarAppearance[] = [];
  render(
    <Harness
      initial={{ ...DEFAULT_BOT_AVATAR, shape: "peak", color: "coral" }}
      onSave={(avatar) => saved.push(avatar)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  assert.deepEqual(saved, [DEFAULT_BOT_AVATAR]);
  assert.equal(
    (screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled,
    true,
  );
});

test("arrow keys move the colour selection like a radio group", () => {
  const saved: BotAvatarAppearance[] = [];
  render(<Harness initial={{ ...DEFAULT_BOT_AVATAR }} onSave={(avatar) => saved.push(avatar)} />);
  const colours = within(screen.getByRole("radiogroup", { name: "Colour" })).getAllByRole("radio");
  const selected = colours.find((radio) => radio.getAttribute("aria-checked") === "true")!;
  assert.equal(selected.getAttribute("tabindex"), "0");
  fireEvent.keyDown(selected, { key: "ArrowRight" });
  const next = colours[colours.indexOf(selected) + 1]!;
  assert.equal(next.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, next);
});
