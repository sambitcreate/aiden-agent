import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WakeUpChip } from "./wake-up-chip";

const NOW = new Date(2026, 9, 28, 14, 0).getTime();
const FIRE_AT = new Date(2026, 9, 28, 15, 10).getTime();
const now = () => NOW;
const cancel = async () => undefined;

function text(markup: string): string {
  return markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

test("a waiting wake-up reads as one line with Cancel", () => {
  const markup = renderToStaticMarkup(<WakeUpChip fireAt={FIRE_AT} pending onCancel={cancel} now={now} />);
  assert.equal(text(markup), "Wake-up at 3:10 PM · Cancel");
  assert.match(markup, /aria-label="Cancel wake-up at 3:10 PM"/u);
});

test("Cancel shows only while the wake-up is known to be waiting and still ahead", () => {
  const cases: Array<[string, React.ReactElement]> = [
    ["still loading", <WakeUpChip key="a" fireAt={FIRE_AT} pending={undefined} onCancel={cancel} now={now} />],
    ["already fired or cancelled", <WakeUpChip key="b" fireAt={FIRE_AT} pending={false} onCancel={cancel} now={now} />],
    ["its minute has come", <WakeUpChip key="c" fireAt={FIRE_AT} pending onCancel={cancel} now={() => FIRE_AT} />],
    ["no way to cancel here", <WakeUpChip key="d" fireAt={FIRE_AT} pending now={now} />],
  ];
  for (const [label, element] of cases) {
    assert.equal(text(renderToStaticMarkup(element)), "Wake-up at 3:10 PM", label);
  }
});
