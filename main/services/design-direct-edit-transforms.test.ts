import assert from "node:assert/strict";
import test from "node:test";
import {
  transformConnectedDirectEdit,
  transformPrototypeDirectEdit,
} from "./design-direct-edit-transforms.js";

const selection = {
  selector: '[data-aiden-id="hero"]',
  tagName: "section",
  elementId: "hero",
};

test("prototype transforms one exact literal inline definition", () => {
  const html =
    '<main><section data-aiden-id="hero" style="padding: 8px; color: var(--text-muted)">Hello</section></main>';
  assert.equal(
    transformPrototypeDirectEdit({
      html,
      selection,
      edit: { kind: "spacing", property: "padding", value: "16px" },
    }),
    '<main><section data-aiden-id="hero" style="padding: 16px; color: var(--text-muted)">Hello</section></main>',
  );
  assert.equal(
    transformPrototypeDirectEdit({
      html,
      selection,
      edit: { kind: "static-text", text: "Welcome & continue" },
    }),
    '<main><section data-aiden-id="hero" style="padding: 8px; color: var(--text-muted)">Welcome &amp; continue</section></main>',
  );
});

test("prototype direct edits reject ambiguity, shared CSS, and rich text", () => {
  assert.throws(
    () =>
      transformPrototypeDirectEdit({
        html: '<section data-aiden-id="hero" style="padding: 8px"></section><section data-aiden-id="hero" style="padding: 8px"></section>',
        selection,
        edit: { kind: "spacing", property: "padding", value: "16px" },
      }),
    /ambiguous/iu,
  );
  assert.throws(
    () =>
      transformPrototypeDirectEdit({
        html: '<style>[data-aiden-id="hero"] { padding: 8px }</style><section data-aiden-id="hero">Hello</section>',
        selection,
        edit: { kind: "spacing", property: "padding", value: "16px" },
      }),
    /(ambiguous|literal inline style)/iu,
  );
  assert.throws(
    () =>
      transformPrototypeDirectEdit({
        html: '<section data-aiden-id="hero"><strong>Hello</strong></section>',
        selection,
        edit: { kind: "static-text", text: "Welcome" },
      }),
    /non-rich/iu,
  );
  assert.throws(
    () =>
      transformPrototypeDirectEdit({
        html: '<section x-data-aiden-id="hero" data-aiden-id="other" data-style="padding: 8px">Hello</section>',
        selection,
        edit: { kind: "spacing", property: "padding", value: "16px" },
      }),
    /missing or ambiguous/iu,
  );
});

test("connected transforms one exact TSX style literal and static text node", () => {
  const source = `export function App() { return <section data-aiden-id="hero" style={{ padding: "8px", color: "var(--text-muted)" }}>Hello</section>; }`;
  const start = source.indexOf("<section");
  const end = source.indexOf("</section>") + "</section>".length;
  assert.equal(
    transformConnectedDirectEdit({
      source,
      start,
      end,
      selection,
      edit: { kind: "spacing", property: "padding", value: "16px" },
    }),
    '<section data-aiden-id="hero" style={{ padding: "16px", color: "var(--text-muted)" }}>Hello</section>',
  );
  assert.equal(
    transformConnectedDirectEdit({
      source,
      start,
      end,
      selection,
      edit: { kind: "static-text", text: "Welcome" },
    }),
    '<section data-aiden-id="hero" style={{ padding: "8px", color: "var(--text-muted)" }}>Welcome</section>',
  );
});

test("connected direct edits reject dynamic, shared, and duplicate definitions", () => {
  for (const source of [
    `const value = "8px"; export function App() { return <section data-aiden-id="hero" style={{ padding: value }}>Hello</section>; }`,
    `export function App() { return <section data-aiden-id="hero" className="hero">Hello</section>; }`,
  ]) {
    const start = source.indexOf("<section");
    const end = source.indexOf("</section>") + "</section>".length;
    assert.throws(
      () =>
        transformConnectedDirectEdit({
          source,
          start,
          end,
          selection,
          edit: { kind: "spacing", property: "padding", value: "16px" },
        }),
      /(dynamic|literal inline style)/iu,
    );
  }
  const duplicate = `export function App() { return <><section data-aiden-id="hero" style={{ padding: "8px" }}>One</section><section data-aiden-id="hero" style={{ padding: "8px" }}>Two</section></>; }`;
  const start = duplicate.indexOf("<section");
  const end = duplicate.indexOf("</section>") + "</section>".length;
  assert.throws(
    () =>
      transformConnectedDirectEdit({
        source: duplicate,
        start,
        end,
        selection,
        edit: { kind: "spacing", property: "padding", value: "16px" },
      }),
    /duplicated/iu,
  );
});
