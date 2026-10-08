import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  connectionSuggestionFor,
  rankConnections,
  type BotConnectionSuggestion,
  type ConnectCardEntry,
} from "../../shared/bot-connections";
import { ConnectCard } from "./connect-card";
import { ConnectionChips, toggleConnection } from "./connection-chips";

const FORWARD_REF = Symbol.for("react.forward_ref");

type AnyElement = React.ReactElement<Record<string, unknown>>;

/** Expand a hook-free element tree into host elements so tests can press the real handlers. */
function hostElements(node: React.ReactNode): AnyElement[] {
  if (Array.isArray(node)) return node.flatMap(hostElements);
  if (!React.isValidElement(node)) return [];
  const element = node as AnyElement;
  const type = element.type as unknown;
  if (typeof type === "function") {
    return hostElements((type as (props: unknown) => React.ReactNode)(element.props));
  }
  if (typeof type === "object" && type && (type as { $$typeof?: symbol }).$$typeof === FORWARD_REF) {
    const render = (type as { render: (props: unknown, ref: null) => React.ReactNode }).render;
    return hostElements(render(element.props, null));
  }
  if (type === React.Fragment) return hostElements(element.props.children as React.ReactNode);
  return [element, ...hostElements(element.props.children as React.ReactNode)];
}

function buttonNamed(node: React.ReactNode, name: string): AnyElement {
  const matches = hostElements(node).filter(
    (element) => element.type === "button" && element.props["aria-label"] === name,
  );
  if (matches.length !== 1) throw new Error(`Expected one "${name}" button, found ${matches.length}.`);
  return matches[0]!;
}

function press(button: AnyElement): void {
  if (button.props.disabled) throw new Error("Button is disabled.");
  (button.props.onClick as (() => void) | undefined)?.();
}

function renderDocument(node: React.ReactElement) {
  const markup = renderToStaticMarkup(node);
  const document = new DOMParser().parseFromString(`<root>${markup}</root>`, "text/xml");
  const all = Array.from(document.getElementsByTagName("*"));
  return {
    text: document.documentElement?.textContent ?? "",
    buttons: all
      .filter((element) => element.tagName === "button")
      .map((element) => ({
        name: element.getAttribute("aria-label") ?? element.textContent ?? "",
        pressed: element.hasAttribute("aria-pressed") ? element.getAttribute("aria-pressed") : null,
      })),
    byRole: (role: string) => all.filter((element) => element.getAttribute("role") === role),
  };
}

const noop = () => {};

const card = (status: ConnectCardEntry["status"], pluginId = "gmail"): ConnectCardEntry => ({
  type: "connect_card",
  pluginId,
  reason: "So I can sort your inbox each morning.",
  status,
});

test("a pending card asks to connect, explains why, and offers Connect and Not now", () => {
  const view = renderDocument(<ConnectCard card={card("pending")} onConnect={noop} onDismiss={noop} />);
  assert.match(view.text, /Connect Gmail/u);
  assert.match(view.text, /So I can sort your inbox each morning\./u);
  assert.deepEqual(
    view.buttons.map((button) => button.name),
    ["Connect Gmail", "Not now for Gmail"],
  );
  assert.equal(view.byRole("group")[0]?.getAttribute("aria-label"), "Connect Gmail");
});

test("Connect and Not now call their handlers with the plugin id", () => {
  const calls: string[] = [];
  const element = (
    <ConnectCard
      card={card("pending")}
      onConnect={(pluginId) => calls.push(`connect:${pluginId}`)}
      onDismiss={(pluginId) => calls.push(`dismiss:${pluginId}`)}
    />
  );
  press(buttonNamed(element, "Connect Gmail"));
  press(buttonNamed(element, "Not now for Gmail"));
  assert.deepEqual(calls, ["connect:gmail", "dismiss:gmail"]);
});

test("a connected card shows Connected with no actions", () => {
  const view = renderDocument(<ConnectCard card={card("connected")} onConnect={noop} onDismiss={noop} />);
  assert.match(view.text, /Gmail/u);
  assert.match(view.text, /Connected ✓/u);
  assert.deepEqual(view.buttons, []);
});

test("a dismissed card stays as a quiet record with no actions", () => {
  const view = renderDocument(<ConnectCard card={card("dismissed")} onConnect={noop} onDismiss={noop} />);
  assert.match(view.text, /Gmail/u);
  assert.match(view.text, /Not connected/u);
  assert.doesNotMatch(view.text, /Connected ✓/u);
  assert.deepEqual(view.buttons, []);
});

test("a busy card disables Connect", () => {
  const element = (
    <ConnectCard card={card("pending")} busy onConnect={() => assert.fail("pressed")} onDismiss={noop} />
  );
  assert.throws(() => press(buttonNamed(element, "Connect Gmail")), /disabled/u);
});

test("phones can relabel Connect without changing its accessible name", () => {
  const view = renderDocument(
    <ConnectCard
      card={card("pending")}
      connectLabel="Finish on your Mac"
      onConnect={noop}
      onDismiss={noop}
    />,
  );
  assert.match(view.text, /Finish on your Mac/u);
  assert.equal(view.buttons[0]?.name, "Connect Gmail");
});

test("a card for an unknown plugin renders nothing", () => {
  assert.equal(
    renderToStaticMarkup(
      <ConnectCard card={card("pending", "made-up")} onConnect={noop} onDismiss={noop} />,
    ),
    "",
  );
});

const suggestions = ["gmail", "google-calendar", "notion"].map(
  (id) => connectionSuggestionFor(id) as BotConnectionSuggestion,
);

test("chips name each connection and report which are selected", () => {
  const view = renderDocument(
    <ConnectionChips
      suggestions={suggestions}
      selected={new Set(["notion"])}
      onToggle={noop}
      onSkip={noop}
    />,
  );
  assert.deepEqual(view.buttons, [
    { name: "Connect Gmail", pressed: "false" },
    { name: "Connect Google Calendar", pressed: "false" },
    { name: "Connect Notion", pressed: "true" },
    { name: "Skip", pressed: null },
  ]);
  assert.equal(view.byRole("group")[0]?.getAttribute("aria-label"), "Suggested connections");
});

test("the ranked defaults render, including the Composio chip", () => {
  const view = renderDocument(
    <ConnectionChips suggestions={rankConnections("")} selected={new Set()} onToggle={noop} />,
  );
  assert.ok(view.buttons.some((button) => button.name === "Connect Composio"));
  assert.match(view.text, /500\+ apps/u);
  assert.equal(view.buttons.some((button) => button.name === "Skip"), false);
});

test("pressing chips toggles them on and off, and Skip is one tap", () => {
  let selected: ReadonlySet<string> = new Set();
  let skipped = 0;
  const render = () => (
    <ConnectionChips
      suggestions={suggestions}
      selected={selected}
      onToggle={(pluginId) => {
        selected = toggleConnection(selected, pluginId);
      }}
      onSkip={() => {
        skipped += 1;
      }}
    />
  );
  press(buttonNamed(render(), "Connect Gmail"));
  press(buttonNamed(render(), "Connect Notion"));
  assert.deepEqual([...selected].sort(), ["gmail", "notion"]);
  press(buttonNamed(render(), "Connect Gmail"));
  assert.deepEqual([...selected], ["notion"]);
  assert.equal(
    renderDocument(render()).buttons.find((button) => button.name === "Connect Notion")?.pressed,
    "true",
  );
  press(buttonNamed(render(), "Skip"));
  assert.equal(skipped, 1);
});

test("toggleConnection never mutates the previous selection", () => {
  const before = new Set(["gmail"]);
  const after = toggleConnection(before, "notion");
  assert.deepEqual([...before], ["gmail"]);
  assert.deepEqual([...after].sort(), ["gmail", "notion"]);
});
