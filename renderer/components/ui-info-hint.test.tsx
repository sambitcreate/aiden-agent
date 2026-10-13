import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InfoHint } from "./ui-info-hint";

afterEach(cleanup);

function renderHint() {
  render(
    <>
      <InfoHint topic="markers">
        <p>Solid means you placed it.</p>
      </InfoHint>
      <button type="button">Elsewhere</button>
    </>,
  );
  return screen.getByRole("button", { name: "About markers" });
}

const hintText = () => screen.queryByText("Solid means you placed it.");

test("the hint button is named after its topic and starts closed", () => {
  const button = renderHint();
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.ok(!hintText());
});

test("a click opens the hint, describes the button, and a second click closes it", async () => {
  const button = renderHint();
  fireEvent.click(button);
  const content = await screen.findByRole("tooltip");
  assert.match(content.textContent ?? "", /Solid means you placed it/u);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(button.getAttribute("aria-describedby"), content.id);

  fireEvent.click(button);
  await waitFor(() => assert.ok(!hintText()));
});

test("Enter and Space open the hint and Escape closes it, leaving focus on the button", async () => {
  const button = renderHint();
  for (const key of ["Enter", " "]) {
    fireEvent.keyDown(button, { key });
    await screen.findByRole("tooltip");
    fireEvent.keyDown(document.activeElement ?? button, { key: "Escape" });
    await waitFor(() => assert.ok(!hintText(), `${JSON.stringify(key)} then Escape`));
  }
});

test("keyboard focus shows the hint without moving focus, and blur hides it", async () => {
  const button = renderHint();
  act(() => button.focus());
  await screen.findByRole("tooltip");
  assert.ok(document.activeElement === button, "focus stays on the button");

  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  await waitFor(() => assert.ok(!hintText()));
});

test("hovering opens the hint after a short delay and leaving closes an unpinned hint", async () => {
  const button = renderHint();
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  assert.ok(!hintText(), "no hint before the delay");
  await screen.findByRole("tooltip");

  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  await waitFor(() => assert.ok(!hintText()));
});

test("a clicked hint stays open when the pointer leaves", async () => {
  const button = renderHint();
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  fireEvent.click(button);
  await screen.findByRole("tooltip");
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
  assert.ok(hintText());
});
