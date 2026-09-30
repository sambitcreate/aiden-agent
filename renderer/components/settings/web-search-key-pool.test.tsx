import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WebSearchKeyPoolList, webSearchKeyPoolEntryStatus } from "./web-search-key-pool";
import type {
  WebSearchKeyPoolRendererEntry,
  WebSearchKeyPoolRendererState,
} from "../../shared/web-search-key-pool";

const NOW = 1_000_000;
const noop = () => undefined;

function entry(
  id: string,
  label: string,
  cooldown: WebSearchKeyPoolRendererEntry["cooldown"] = null,
): WebSearchKeyPoolRendererEntry {
  return { id, label, addedAt: 1, cooldown };
}

function state(entries: WebSearchKeyPoolRendererEntry[]): WebSearchKeyPoolRendererState {
  return { providerId: "tavily", strategy: "ordered", maxEntries: 8, observedAt: NOW, entries };
}

function render(entries: WebSearchKeyPoolRendererEntry[]) {
  const html = renderToStaticMarkup(
    <WebSearchKeyPoolList
      providerLabel="Tavily"
      state={state(entries)}
      now={NOW}
      onMove={noop}
      onRemove={noop}
      onResetCooldown={noop}
    />,
  );
  return html;
}

function entryHtml(html: string, id: string): string {
  const start = html.indexOf(`data-entry-id="${id}"`);
  assert.ok(start >= 0, `entry ${id} is rendered`);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

test("pooled keys render in use order with their cooldown state and a retry action only while cooling", () => {
  const html = render([
    entry("primary", "Personal"),
    entry("team1", "Team", { reason: "quota", until: NOW + 45_000 }),
    entry("team2", "Old", { reason: "auth", until: NOW + 15 * 60_000 }),
  ]);

  assert.ok(html.indexOf("Personal") < html.indexOf("Team"));
  assert.ok(html.indexOf("Team") < html.indexOf("Old"));
  assert.match(html, /aria-label="Tavily API keys, in use order"/u);

  const personal = entryHtml(html, "primary");
  assert.match(personal, /data-cooling="false"/u);
  assert.match(personal, /Active/u);
  assert.doesNotMatch(personal, /Retry Personal now/u);

  const team = entryHtml(html, "team1");
  assert.match(team, /data-cooling="true"/u);
  assert.match(team, /Rate limited · retry in 45s/u);
  assert.match(team, /aria-label="Retry Team now"/u);

  const old = entryHtml(html, "team2");
  assert.match(old, /Rejected · retry in 15m/u);
  assert.match(old, /aria-label="Retry Old now"/u);
});

function buttonDisabled(html: string, label: string): boolean {
  const at = html.indexOf(`aria-label="${label}"`);
  assert.ok(at >= 0, `button ${label} is rendered`);
  const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
  return /\sdisabled=""/u.test(tag);
}

test("move controls are disabled at the ends of the list", () => {
  const html = render([entry("a", "First"), entry("b", "Last")]);
  assert.equal(buttonDisabled(html, "Move First up"), true);
  assert.equal(buttonDisabled(html, "Move First down"), false);
  assert.equal(buttonDisabled(html, "Move Last up"), false);
  assert.equal(buttonDisabled(html, "Move Last down"), true);
  assert.equal(buttonDisabled(html, "Remove First"), false);
});

test("an empty pool explains how to add a key", () => {
  const html = render([]);
  assert.match(html, /No Tavily keys saved yet/u);
  assert.doesNotMatch(html, /<ol/u);
});

test("an expired cooldown is shown as active again without a refresh from main", () => {
  const expired = entry("a", "Key", { reason: "quota", until: NOW - 1 });
  assert.deepEqual(webSearchKeyPoolEntryStatus(expired, NOW), { label: "Active", color: "green" });
});
