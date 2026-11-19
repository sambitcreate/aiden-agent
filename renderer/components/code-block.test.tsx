import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBlock } from "./code-block.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

afterEach(cleanup);

function previewButtons(markup: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = markup;
  return [...host.querySelectorAll("button")]
    .filter((button) => button.getAttribute("aria-label") === "Preview")
    .map((button) => button.getAttribute("aria-pressed") ?? "");
}

test("a closed chat svg fence offers an unpressed Preview toggle", () => {
  const markup = renderToStaticMarkup(<CodeBlock code={SVG} lang="svg" previewable />);
  assert.deepEqual(previewButtons(markup), ["false"]);
  assert.match(markup, /<pre/u, "starts on the code");
});

test("no Preview toggle outside chat, while streaming, or for other languages", () => {
  assert.deepEqual(previewButtons(renderToStaticMarkup(<CodeBlock code={SVG} lang="svg" />)), []);
  assert.deepEqual(
    previewButtons(renderToStaticMarkup(<CodeBlock code={SVG} lang="svg" previewable plain />)),
    [],
  );
  assert.deepEqual(
    previewButtons(renderToStaticMarkup(<CodeBlock code={SVG} lang="ts" previewable />)),
    [],
  );
  assert.deepEqual(
    previewButtons(
      renderToStaticMarkup(<CodeBlock code={'<svg viewBox="0 0 1 1">'} lang="svg" previewable />),
    ),
    [],
  );
});

test("Preview swaps the code for the drawing and back, keeping Copy", () => {
  const { container } = render(<CodeBlock code={SVG} lang="svg" previewable />);
  const toggle = screen.getByRole("button", { name: "Preview" });

  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  const image = screen.getByRole("img", {
    name: "SVG preview",
  }) as HTMLImageElement;
  assert.equal(decodeURIComponent(image.getAttribute("src")!.split(",").slice(1).join(",")), SVG);
  assert.equal(container.querySelector("pre"), null);
  assert.ok(screen.getByRole("button", { name: "Copy code" }));

  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(screen.queryByRole("img", { name: "SVG preview" }), null);
  assert.ok(container.querySelector("pre")?.textContent?.includes("<circle"));
});

test("an svg the browser cannot draw shows a note instead of a blank card", () => {
  render(
    <CodeBlock code={'<svg viewBox="0 0 10 10"><circle r="4"/></svg>'} lang="svg" previewable />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  fireEvent.error(screen.getByRole("img", { name: "SVG preview" }));
  assert.equal(screen.queryByRole("img", { name: "SVG preview" }), null);
  assert.ok(screen.getByText("Couldn't draw this SVG."));
});
