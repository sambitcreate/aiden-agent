import assert from "node:assert/strict";
import test from "node:test";
import { LiveActivityStore, type LiveActivity } from "./live-activity.js";

const noop = () => undefined;
const acting = (label: string): LiveActivity => ({ kind: "acting", label, takeOver: noop });
const approval = (id: string): LiveActivity => ({
  kind: "approval",
  id,
  title: "Run npm test",
  chatTitle: "Fix login",
  voice: true,
  allow: noop,
  deny: noop,
});

test("the ribbon shows an approval over a confirmation over acting, and the newest of a kind", () => {
  const store = new LiveActivityStore();
  let changes = 0;
  store.subscribe(() => (changes += 1));
  store.set("app", acting("Opening Settings"));
  assert.equal(store.get()?.kind, "acting");
  store.set("approvals", approval("a1"));
  store.set("app", acting("Pressing Save"));
  assert.equal(store.get()?.kind, "approval", "a later acting update does not hide the approval");
  store.set("approvals", null);
  const shown = store.get();
  assert.equal(shown?.kind === "acting" ? shown.label : null, "Pressing Save");
  store.set("approvals", null);
  assert.equal(changes, 4, "clearing an absent source does not notify");
  store.set("app", null);
  assert.equal(store.get(), null);
});
