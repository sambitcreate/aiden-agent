import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOT_ACTION_CLASSES, type BotActionClass, type BotRule } from "../../../renderer/shared/bot-rules.js";
import { classifyBotAction, type BotClassifiableAction } from "./classify.js";

interface CorpusRow {
  id: string;
  note?: string;
  tags?: string[];
  action: BotClassifiableAction;
  expected: BotActionClass[];
  customRules?: BotRule[];
  expectedCustom?: string[];
}

const corpus = JSON.parse(readFileSync(new URL("./fixtures/actions.json", import.meta.url), "utf8")) as {
  version: number;
  rows: CorpusRow[];
};
const LOCKED: readonly BotActionClass[] = ["credentials", "money"];

function custom(id: string, text: string): BotRule {
  return { id, text, behavior: "hand_off", locked: false };
}

test("the corpus covers every surface and class with enough rows to mean something", () => {
  assert.ok(corpus.rows.length >= 80, `only ${corpus.rows.length} rows`);
  const surfaces = new Set(corpus.rows.map((row) => row.action.surface));
  assert.deepEqual([...surfaces].sort(), ["browser", "computer", "computer_use", "mcp"]);
  for (const actionClass of BOT_ACTION_CLASSES) {
    assert.ok(
      corpus.rows.filter((row) => row.expected.includes(actionClass)).length >= 5,
      `fewer than five ${actionClass} rows`,
    );
  }
  assert.ok(corpus.rows.filter((row) => row.expected.length === 0).length >= 20, "too few negatives");
  // Password, one-time-code and card fields on every surface (for connection
  // tools: tools that take or change them).
  for (const surface of ["browser", "computer", "computer_use", "mcp"]) {
    const sensitive = corpus.rows.filter((row) => row.action.surface === surface && row.tags?.includes("sensitive_field"));
    assert.ok(sensitive.some((row) => row.expected.includes("credentials")), `${surface}: no credential field`);
    assert.ok(sensitive.some((row) => row.expected.includes("money")), `${surface}: no card field`);
  }
  assert.equal(new Set(corpus.rows.map((row) => row.id)).size, corpus.rows.length, "row ids repeat");
});

test("precision and recall against the labelled corpus, reported per class", (t) => {
  const counts = new Map<BotActionClass, { tp: number; fp: number; fn: number }>(
    BOT_ACTION_CLASSES.map((actionClass) => [actionClass, { tp: 0, fp: 0, fn: 0 }]),
  );
  const mismatches: string[] = [];
  for (const row of corpus.rows) {
    const { classes } = classifyBotAction(row.action, row.customRules ?? []);
    for (const actionClass of BOT_ACTION_CLASSES) {
      const expected = row.expected.includes(actionClass);
      const found = classes.has(actionClass);
      const count = counts.get(actionClass)!;
      if (expected && found) count.tp += 1;
      else if (found) count.fp += 1;
      else if (expected) count.fn += 1;
    }
    const got = [...classes].sort().join(",");
    if (got !== [...row.expected].sort().join(",")) mismatches.push(`${row.id}: got [${got}], labelled [${row.expected.join(",")}]`);
  }
  for (const [actionClass, { tp, fp, fn }] of counts) {
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    t.diagnostic(`${actionClass}: precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)} (tp ${tp}, fp ${fp}, fn ${fn})`);
    if (LOCKED.includes(actionClass)) {
      // A missed password or card hands the step to the Bot instead of the person.
      assert.equal(fn, 0, `${actionClass} missed ${fn} labelled rows`);
      assert.ok(precision >= 0.9, `${actionClass} precision ${precision.toFixed(2)}`);
    } else {
      assert.ok(precision >= 0.85, `${actionClass} precision ${precision.toFixed(2)}`);
      assert.ok(recall >= 0.85, `${actionClass} recall ${recall.toFixed(2)}`);
    }
  }
  for (const mismatch of mismatches) t.diagnostic(`mismatch ${mismatch}`);
});

test("locked classes never miss a password, one-time code or card field", () => {
  const sensitive = corpus.rows.filter((row) => row.tags?.includes("sensitive_field"));
  assert.ok(sensitive.length >= 20);
  for (const row of sensitive) {
    const { classes } = classifyBotAction(row.action, []);
    for (const actionClass of row.expected.filter((entry) => LOCKED.includes(entry))) {
      assert.ok(classes.has(actionClass), `${row.id} missed ${actionClass}`);
    }
  }
});

test("custom rules in the corpus match exactly the rows labelled for them", () => {
  const rows = corpus.rows.filter((row) => row.customRules !== undefined);
  assert.ok(rows.length >= 5);
  for (const row of rows) {
    const { customRuleIds } = classifyBotAction(row.action, row.customRules!);
    assert.deepEqual([...customRuleIds].sort(), [...(row.expectedCustom ?? [])].sort(), row.id);
  }
});

test("a custom rule needs every one of its content words, in any form", () => {
  const flight = custom("custom.f", "Book a flight");
  const action: BotClassifiableAction = {
    surface: "computer_use",
    action: "click",
    app: "Safari",
    windowTitle: "Flights to Lisbon",
    element: { role: "AXButton", label: "Booking" },
  };
  assert.deepEqual([...classifyBotAction(action, [flight]).customRuleIds], ["custom.f"]);
  // One word missing: no match.
  assert.equal(
    classifyBotAction({ ...action, windowTitle: "Hotels in Lisbon" }, [flight]).customRuleIds.size,
    0,
  );
  // Stop words are ignored; a rule of only stop words never matches anything.
  assert.equal(classifyBotAction(action, [custom("custom.s", "do something for me")]).customRuleIds.size, 0);
  // Words are whole stems, not prefixes: "post" is not "postal".
  const postal: BotClassifiableAction = {
    surface: "browser",
    tool: "browser_type",
    field: { accessibleName: "Postal code" },
  };
  assert.equal(classifyBotAction(postal, [custom("custom.p", "post")]).customRuleIds.size, 0);
  assert.equal(classifyBotAction(postal, []).classes.size, 0);
});

test("a custom rule can name the app, the site or the connection tool", () => {
  const slack = custom("custom.slack", "message the team on Slack");
  const mcp: BotClassifiableAction = {
    surface: "mcp",
    modelName: "slack__send_message",
    serverId: "srv-slack",
    remoteName: "send_message",
    summary: "slack__send_message",
    annotations: { title: "Send a message to the team channel" },
    destructive: "unknown",
  };
  assert.deepEqual([...classifyBotAction(mcp, [slack]).customRuleIds], ["custom.slack"]);
  const site: BotClassifiableAction = {
    surface: "browser",
    tool: "browser_click",
    url: "https://www.YouTube.com/upload",
    field: { accessibleName: "Publish" },
  };
  assert.deepEqual([...classifyBotAction(site, [custom("custom.yt", "publish on YouTube")]).customRuleIds], ["custom.yt"]);
});

test("built-in and locked rules in the list are not custom rules", () => {
  const action: BotClassifiableAction = {
    surface: "computer_use",
    action: "click",
    element: { role: "AXButton", label: "Buy now" },
  };
  const result = classifyBotAction(action, [
    { id: "default.purchase", actionClass: "purchase", behavior: "ask", locked: false },
    { id: "locked.money", actionClass: "money", behavior: "hand_off", locked: true },
  ]);
  assert.equal(result.customRuleIds.size, 0);
  assert.deepEqual([...result.classes], ["purchase"]);
});

test("negating words never cancel a locked class", () => {
  const typeInto = (label: string): BotClassifiableAction => ({
    surface: "computer_use",
    action: "type",
    focusedElement: { role: "AXTextField", label },
  });
  assert.ok(classifyBotAction(typeInto("New password"), []).classes.has("credentials"));
  assert.ok(classifyBotAction(typeInto("Confirm new card number"), []).classes.has("money"));
  const click = (label: string): BotClassifiableAction => ({
    surface: "computer_use",
    action: "click",
    element: { role: "AXButton", label },
  });
  assert.ok(classifyBotAction(click("Cancel payment"), []).classes.has("money"));
  assert.equal(classifyBotAction(click("Don't send"), []).classes.size, 0);
});

test("every class decision carries evidence naming the signal, never a field value", () => {
  const result = classifyBotAction(
    {
      surface: "browser",
      tool: "browser_type",
      url: "https://shop.example.com/checkout",
      field: { type: "text", autocomplete: "cc-number", accessibleName: "Card number" },
    },
    [],
  );
  assert.deepEqual([...result.classes], ["money"]);
  const forMoney = result.evidence.filter((entry) => entry.actionClass === "money");
  assert.ok(forMoney.some((entry) => entry.kind === "strong"));
  for (const entry of result.evidence) assert.ok(entry.source.length > 0 && entry.source.length < 120);
});

test("the key that sends a web message is communicating; a new line, a search or an unknown box is not", () => {
  const press = (key: string, url: string, field?: Extract<BotClassifiableAction, { surface: "browser" }>["field"]) =>
    [...classifyBotAction({ surface: "browser", tool: "browser_press", url, key, ...(field ? { field } : {}) }, []).classes];
  const reply = { tag: "textarea", accessibleName: "Reply to Ada" };
  // A message box anywhere, by its name; the numeric keypad's Enter too.
  assert.deepEqual(press("Enter", "https://forum.example.org/t/42", reply), ["communicate"]);
  assert.deepEqual(press("NumpadEnter", "https://forum.example.org/t/42", reply), ["communicate"]);
  assert.deepEqual(press("Control+Enter", "https://forum.example.org/t/42", reply), ["communicate"]);
  // A new line, another key, or a box the probe couldn't read.
  assert.deepEqual(press("Alt+Enter", "https://forum.example.org/t/42", reply), []);
  assert.deepEqual(press("Shift+Control+Enter", "https://forum.example.org/t/42", reply), []);
  assert.deepEqual(press("ArrowUp", "https://forum.example.org/t/42", reply), []);
  assert.deepEqual(press("Enter", "https://app.slack.com/client/T1/C2"), []);
  // A search box is never a message box, even on a chat site or named for messages.
  assert.deepEqual(press("Enter", "https://app.slack.com/client/T1/C2", { tag: "input", type: "search" }), []);
  assert.deepEqual(press("Enter", "https://discord.com/channels/1/2", { tag: "div", role: "searchbox" }), []);
  assert.deepEqual(press("Enter", "https://example.com/", { tag: "input", type: "text", accessibleName: "Search messages" }), []);
  // A button or checkbox with focus is not a text box.
  assert.deepEqual(press("Enter", "https://app.slack.com/client/T1/C2", { tag: "button", accessibleName: "Message" }), []);
  // An unnamed text box sends only on a chat site, and in web mail only with Control or Command.
  assert.deepEqual(press("Enter", "https://example.com/", { tag: "input", type: "text" }), []);
  assert.deepEqual(press("Enter", "https://teams.microsoft.com/v2/", { tag: "div", role: "textbox" }), ["communicate"]);
  assert.deepEqual(press("Enter", "https://outlook.live.com/mail/0/", { tag: "div", role: "textbox", accessibleName: "Reply" }), []);
  assert.deepEqual(press("Meta+Enter", "https://outlook.live.com/mail/0/", { tag: "div", role: "textbox" }), ["communicate"]);

  const evidence = classifyBotAction(
    { surface: "browser", tool: "browser_press", url: "https://web.whatsapp.com/", key: "Enter", field: { role: "textbox", accessibleName: "Type a message" } },
    [],
  ).evidence;
  assert.ok(evidence.some((entry) => entry.actionClass === "communicate" && entry.kind === "strong"));
});

test("hostile input is bounded and never throws", () => {
  const huge = "send ".repeat(50_000);
  const result = classifyBotAction(
    { surface: "computer_use", action: "key", keys: "cmd+cmd+", app: "Mail", element: { label: huge } },
    [custom("custom.x", "send")],
  );
  assert.ok(result.evidence.length < 50);
  assert.deepEqual([...result.customRuleIds], ["custom.x"]);
  const malformed = classifyBotAction(
    { surface: "browser", tool: "browser_type", url: "not a url", field: { autocomplete: " " } },
    [],
  );
  assert.equal(malformed.classes.size, 0);
});
