import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PillCopiedNotice } from "./pill-copied-notice.js";

function visibleText(markup: string): string {
  return markup
    .replace(/<span class="sr-only">.*?<\/span>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("Secure Input copy explains why paste was blocked and what to do next", () => {
  const markup = renderToStaticMarkup(
    <PillCopiedNotice reason="secure-input" message="Transcript copied — press ⌘V to paste." />,
  );
  const text = visibleText(markup);
  assert.match(text, /Secure Input blocked paste/);
  assert.match(text, /press ⌘V to paste/);
  // Assistive technology hears the cause, not just the symptom.
  assert.match(markup, /Secure Input is on[^<]*password field/);
});

test("Secure Input copy still explains itself when the main process omits a message", () => {
  const text = visibleText(renderToStaticMarkup(<PillCopiedNotice reason="secure-input" />));
  assert.match(text, /Secure Input blocked paste/);
  assert.match(text, /⌘V/);
});

test("other copy results keep their plain message without a Secure Input warning", () => {
  const accessibility = visibleText(
    renderToStaticMarkup(<PillCopiedNotice reason="accessibility-required" />),
  );
  assert.equal(accessibility, "Copied — allow Accessibility to paste");

  const custom = visibleText(
    renderToStaticMarkup(
      <PillCopiedNotice
        reason="paste-unavailable"
        message="Copied — the original text field was no longer focused."
      />,
    ),
  );
  assert.equal(custom, "Copied — the original text field was no longer focused.");
  assert.equal(visibleText(renderToStaticMarkup(<PillCopiedNotice />)), "Copied to clipboard");
});

test("unconfirmed delivery asks the user to inspect the field without pasting twice", () => {
  const text = visibleText(renderToStaticMarkup(
    <PillCopiedNotice reason="paste-unavailable" message="Check the field — transcript copied." />,
  ));
  assert.equal(text, "Check the field — transcript copied.");
  assert.doesNotMatch(text, /⌘V|press|blocked|couldn.t paste/i);
});
