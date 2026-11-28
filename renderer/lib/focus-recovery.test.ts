import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { focusAfterRemoval, watchFocusRecovery } from "./focus-recovery";

afterEach(() => {
  document.body.replaceChildren();
});

function list(titles: string[], tabStop?: () => HTMLElement | null) {
  const container = document.createElement("div");
  for (const title of titles) {
    const row = document.createElement("button");
    row.textContent = title;
    container.append(row);
  }
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(container, outside);
  const rows = () => Array.from(container.querySelectorAll("button"));
  const stop = watchFocusRecovery(container, rows, (target) => target.closest("button"), tabStop);
  const row = (title: string) => rows().find((element) => element.textContent === title)!;
  return { container, outside, rows, row, stop };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const focused = () => document.activeElement?.textContent ?? null;

test("focusAfterRemoval prefers the row after the removed ones, then the one before", () => {
  const make = (title: string) => {
    const element = document.createElement("button");
    element.textContent = title;
    return element;
  };
  const [a, b, c, d] = [make("a"), make("b"), make("c"), make("d")];
  const rows = [a, b, c, d];
  assert.equal(
    focusAfterRemoval(rows, new Set([b, c]), () => true),
    d,
  );
  assert.equal(
    focusAfterRemoval(rows, new Set([c, d]), () => true),
    b,
  );
  assert.equal(
    focusAfterRemoval(rows, new Set([b]), (row) => row !== c),
    d,
  );
  assert.equal(
    focusAfterRemoval(rows, new Set([a, b, c, d]), () => true),
    null,
  );
  assert.equal(
    focusAfterRemoval(rows, new Set(), () => true),
    null,
  );
});

test("a removed focused row hands focus to the next row, then the previous, then the list", async () => {
  const { container, row, stop } = list(["One", "Two", "Three"]);
  row("Two").focus();
  row("Two").remove();
  await settle();
  assert.equal(focused(), "Three");
  row("Three").remove();
  await settle();
  assert.equal(focused(), "One");
  row("One").remove();
  await settle();
  assert.equal(document.activeElement, container);
  assert.equal(container.getAttribute("tabindex"), "-1");
  // Once focus leaves, a click on the list's empty space no longer focuses it.
  container.blur();
  assert.equal(container.hasAttribute("tabindex"), false);
  stop();
});

test("with no row from before left, the list's Tab stop takes focus before the list itself", async () => {
  let fresh: HTMLElement | null = null;
  const { container, row, stop } = list(["Only"], () => fresh);
  row("Only").focus();
  fresh = document.createElement("button");
  fresh.textContent = "Arrived";
  container.replaceChildren(fresh);
  await settle();
  assert.equal(focused(), "Arrived");
  stop();
});

test("focus that moved elsewhere on purpose stays there", async () => {
  const { outside, row, stop } = list(["One", "Two"]);
  row("One").focus();
  outside.focus();
  await settle();
  row("One").remove();
  await settle();
  assert.equal(focused(), "Outside");
  stop();
});
