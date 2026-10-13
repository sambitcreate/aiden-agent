import "../../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../../main/bots/test-providers";
import type { ModelInsightsActionResult, ModelInsightsStatus } from "../../../lib/types";
import { Toaster, toast } from "../../ui";
import { ModelPadDataRows } from "./model-pad-data-rows";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

const disconnected: ModelInsightsStatus = {
  hasKey: false,
  ready: false,
  cachedModelCount: 0,
  skippedAmbiguousCount: 0,
};

const ready: ModelInsightsStatus = {
  hasKey: true,
  ready: true,
  cachedModelCount: 12,
  skippedAmbiguousCount: 0,
  fetchedAt: new Date(Date.now() - 3_600_000).toISOString(),
  license: "CC BY 4.0",
};

type ActionHandler = (...args: unknown[]) => ModelInsightsActionResult | Promise<ModelInsightsActionResult>;

/** A fake main process for the benchmark connection; status follows each successful action. */
function insightsServer(
  options: {
    status?: ModelInsightsStatus;
    statusFails?: boolean;
    connect?: ActionHandler;
    refresh?: ActionHandler;
    disconnect?: ActionHandler;
  } = {},
) {
  let status = options.status ?? disconnected;
  const settle = (handler: ActionHandler | undefined, fallback: ModelInsightsStatus) =>
    async (...args: unknown[]) => {
      const result = handler ? await handler(...args) : { ok: true as const, status: fallback };
      if (result.ok) status = result.status;
      return result;
    };
  const calls = installBotTestIpc({
    "modelInsights:status": () => {
      if (options.statusFails) throw new Error("unreadable");
      return structuredClone(status);
    },
    "modelInsights:connect": settle(options.connect, ready),
    "modelInsights:refresh": settle(options.refresh, ready),
    "modelInsights:disconnect": settle(options.disconnect, disconnected),
    "modelPace:clear": () => undefined,
    "modelPace:summaries": () => ({}),
  });
  return {
    calls: (channel: string) => calls.filter((call) => call.channel === channel),
  };
}

function mount(props: Partial<React.ComponentProps<typeof ModelPadDataRows>> = {}) {
  const fallback = document.createElement("button");
  fallback.textContent = "Fallback";
  document.body.append(fallback);
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelPadDataRows
        matchedWithoutMetric={0}
        metric="intelligence"
        measuredCount={0}
        fallbackFocus={() => fallback}
        {...props}
      />
      <Toaster />
    </QueryClientProvider>,
  );
  return { fallback };
}

function describe(element: Element | null): string {
  return element?.getAttribute("aria-label") ?? element?.textContent ?? String(element);
}

function benchmarkRow(): HTMLElement {
  return screen.getByRole("group", { name: "Benchmark scores" });
}

function keyField(): HTMLInputElement | null {
  return screen.queryByLabelText(/OpenRouter key for benchmark scores$/u) as HTMLInputElement | null;
}

async function openOptions(): Promise<HTMLElement> {
  fireEvent.keyDown(
    await within(benchmarkRow()).findByRole("button", { name: "Benchmark connection options" }),
    { key: "Enter" },
  );
  return screen.findByRole("menu");
}

test("Connect reveals a password key row, and Connect & fetch connects with the trimmed key", async () => {
  const server = insightsServer();
  mount();
  await within(benchmarkRow()).findByText("Not connected");
  assert.ok(!keyField(), "the key row stays hidden until Connect");

  const connectButton = within(benchmarkRow()).getByRole("button", { name: "Connect" });
  fireEvent.click(connectButton);
  assert.equal(connectButton.getAttribute("aria-expanded"), "true");
  const field = keyField();
  assert.ok(field);
  assert.equal(field.type, "password");
  assert.ok(document.activeElement === field, `focus is on ${describe(document.activeElement)}`);
  const getKey = screen.getByRole("link", { name: "Get a key" });
  assert.equal(getKey.getAttribute("href"), "https://openrouter.ai/settings/keys");

  const submit = screen.getByRole("button", { name: "Connect & fetch" });
  assert.equal((submit as HTMLButtonElement).disabled, true, "nothing to submit without a key");
  fireEvent.change(field, { target: { value: "  sk-or-secret  " } });
  fireEvent.click(submit);

  await waitFor(() => assert.deepEqual(server.calls("modelInsights:connect").map((call) => call.args), [["sk-or-secret"]]));
  await within(benchmarkRow()).findByText(/^Artificial Analysis via OpenRouter · /u);
  await screen.findByText("Benchmark scores are ready.");
  assert.ok(!keyField(), "the key row closes once connected");
  await waitFor(() =>
    assert.ok(
      document.activeElement === within(benchmarkRow()).getByRole("button", { name: "Fetch latest" }),
      `focus is on ${describe(document.activeElement)}`,
    ),
  );
});

test("Connect toggles the key row closed again and Escape closes it too", async () => {
  insightsServer();
  mount();
  const connectButton = await within(benchmarkRow()).findByRole("button", { name: "Connect" });
  fireEvent.click(connectButton);
  assert.ok(keyField());
  fireEvent.click(connectButton);
  assert.ok(!keyField());
  assert.equal(connectButton.getAttribute("aria-expanded"), "false");

  fireEvent.click(connectButton);
  fireEvent.keyDown(keyField()!, { key: "Escape" });
  assert.ok(!keyField());
  await waitFor(() => assert.ok(document.activeElement === connectButton, `focus is on ${describe(document.activeElement)}`));
});

test("a rejected key shows the error in the row, keeps the key row, and re-reads the status", async () => {
  const server = insightsServer({
    connect: () => ({ ok: false, code: "invalid_key", message: "OpenRouter rejected this key." }),
  });
  mount();
  fireEvent.click(await within(benchmarkRow()).findByRole("button", { name: "Connect" }));
  fireEvent.change(keyField()!, { target: { value: "sk-or-bad" } });
  const statusReads = server.calls("modelInsights:status").length;
  fireEvent.click(screen.getByRole("button", { name: "Connect & fetch" }));

  await within(benchmarkRow()).findByText("OpenRouter rejected this key.");
  assert.ok(keyField(), "the key row stays open to try again");
  assert.equal(keyField()!.getAttribute("aria-invalid"), "true");
  assert.ok(server.calls("modelInsights:status").length > statusReads, "the status is reconciled");

  fireEvent.change(keyField()!, { target: { value: "sk-or-better" } });
  assert.ok(!within(benchmarkRow()).queryByText("OpenRouter rejected this key."));
  within(benchmarkRow()).getByText("Not connected");
});

test("an unreadable connection says so instead of a status", async () => {
  insightsServer({ statusFails: true });
  mount();
  await within(benchmarkRow()).findByText("Aiden couldn’t read the benchmark connection.");
});

test("Fetch latest shows its busy state, then the failure text in the row", async () => {
  let fail: (result: ModelInsightsActionResult) => void = () => {};
  insightsServer({
    status: ready,
    refresh: () => new Promise((resolve) => (fail = resolve)),
  });
  mount();
  fireEvent.click(await within(benchmarkRow()).findByRole("button", { name: "Fetch latest" }));
  const busy = await within(benchmarkRow()).findByRole("button", { name: "Fetching…" });
  assert.equal((busy as HTMLButtonElement).disabled, true);

  fail({ ok: false, code: "rate_limited", message: "OpenRouter is rate limiting requests." });
  await within(benchmarkRow()).findByText("OpenRouter is rate limiting requests.");
  const fetchLatest = within(benchmarkRow()).getByRole("button", { name: "Fetch latest" });
  // The button was disabled while busy; focus comes back to it to try again.
  await waitFor(() =>
    assert.ok(document.activeElement === fetchLatest, `focus is on ${describe(document.activeElement)}`),
  );
});

test("Replace key… opens an empty replacement field and never shows the stored key", async () => {
  const server = insightsServer({ status: ready });
  mount();
  await within(benchmarkRow()).findByText(/^Artificial Analysis via OpenRouter/u);
  const optionsButton = within(benchmarkRow()).getByRole("button", { name: "Benchmark connection options" });
  fireEvent.click(await within(await openOptions()).findByRole("menuitem", { name: "Replace key…" }));

  const field = await waitFor(() => {
    const found = screen.getByLabelText("Replacement OpenRouter key for benchmark scores") as HTMLInputElement;
    assert.ok(document.activeElement === found, `focus is on ${describe(document.activeElement)}`);
    return found;
  });
  assert.equal(field.type, "password");
  assert.equal(field.value, "");

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  assert.ok(!keyField());
  await waitFor(() => assert.ok(document.activeElement === optionsButton, `focus is on ${describe(document.activeElement)}`));

  fireEvent.click(await within(await openOptions()).findByRole("menuitem", { name: "Replace key…" }));
  fireEvent.change(await screen.findByLabelText("Replacement OpenRouter key for benchmark scores"), {
    target: { value: "sk-or-new" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Replace & fetch" }));
  await waitFor(() => assert.equal(server.calls("modelInsights:connect").length, 1));
  await waitFor(() => assert.ok(!keyField()));
});

test("Disconnect asks first, then removes the connection and offers Connect again", async () => {
  const server = insightsServer({ status: ready });
  mount();
  await within(benchmarkRow()).findByText(/^Artificial Analysis via OpenRouter/u);

  fireEvent.click(await within(await openOptions()).findByRole("menuitem", { name: "Disconnect" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Disconnect benchmark scores?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  assert.equal(server.calls("modelInsights:disconnect").length, 0);

  fireEvent.click(await within(await openOptions()).findByRole("menuitem", { name: "Disconnect" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect" }),
  );
  await waitFor(() => assert.equal(server.calls("modelInsights:disconnect").length, 1));
  await within(benchmarkRow()).findByText("Not connected");
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  const connectButton = within(benchmarkRow()).getByRole("button", { name: "Connect" });
  await waitFor(() => assert.ok(document.activeElement === connectButton, `focus is on ${describe(document.activeElement)}`));
});

test("a key without fetched scores offers Fetch latest and says nothing is cached yet", async () => {
  insightsServer({ status: { ...disconnected, hasKey: true } });
  mount();
  await within(benchmarkRow()).findByText("Key saved · no scores fetched yet");
  within(benchmarkRow()).getByRole("button", { name: "Fetch latest" });
  assert.ok(!within(benchmarkRow()).queryByRole("button", { name: /^Benchmark coverage/u }));
});

test("Measured speed offers Clear… only with speeds, and asks before clearing", async () => {
  const server = insightsServer();
  mount({ measuredCount: 1 });
  const row = screen.getByRole("group", { name: "Measured speed" });
  within(row).getByText("1 model · from your chats on this Mac");
  const clear = within(row).getByRole("button", { name: "Clear measured speeds" });
  fireEvent.click(clear);
  const dialog = await screen.findByRole("alertdialog", { name: "Clear measured speeds?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.ok(!screen.queryByRole("alertdialog")));
  assert.equal(server.calls("modelPace:clear").length, 0);
  await waitFor(() => assert.ok(document.activeElement === clear, `focus is on ${describe(document.activeElement)}`));
});

test("while a key is connecting Connect can't close the row, and a failure refocuses the key field", async () => {
  let settle: (result: ModelInsightsActionResult) => void = () => {};
  insightsServer({ connect: () => new Promise((resolve) => (settle = resolve)) });
  mount();
  const connectButton = await within(benchmarkRow()).findByRole("button", { name: "Connect" });
  fireEvent.click(connectButton);
  fireEvent.change(keyField()!, { target: { value: "sk-or-bad" } });
  const submit = screen.getByRole("button", { name: "Connect & fetch" });
  submit.focus();
  fireEvent.click(submit);

  await within(benchmarkRow()).findByRole("button", { name: "Connecting…" });
  assert.equal((connectButton as HTMLButtonElement).disabled, true);
  fireEvent.click(connectButton);
  assert.ok(keyField(), "the key row stays open while connecting");

  settle({ ok: false, code: "invalid_key", message: "OpenRouter rejected this key." });
  await within(benchmarkRow()).findByText("OpenRouter rejected this key.");
  await waitFor(() =>
    assert.ok(document.activeElement === keyField(), `focus is on ${describe(document.activeElement)}`),
  );
  assert.equal((connectButton as HTMLButtonElement).disabled, false);
});

test("the benchmark hint explains when scores are fetched and names their licence", async () => {
  insightsServer({ status: ready });
  mount();
  fireEvent.click(within(benchmarkRow()).getByRole("button", { name: "About benchmark scores" }));
  const hint = await screen.findByRole("tooltip");
  assert.match(hint.textContent ?? "", /only when you choose Connect & fetch or Fetch latest/u);
  await waitFor(() => assert.match(hint.textContent ?? "", /Scores: Artificial Analysis, CC BY 4\.0\./u));
});
