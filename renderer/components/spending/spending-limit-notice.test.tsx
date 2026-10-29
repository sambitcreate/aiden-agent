import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { SpendingStatusView } from "../../shared/spending";
import { SpendingLimitNotice } from "./spending-limit-notice";

const base: SpendingStatusView = {
  ownerKind: "bot",
  ownerId: "ada",
  period: "month",
  limitUsd: 20,
  extraUsd: 0,
  spentUsd: 17,
  state: "nearing",
};

async function render(status: SpendingStatusView, allowing = false) {
  const root = createRootRoute({
    component: () => <SpendingLimitNotice status={status} name="Ada" allowing={allowing} onAllowMore={() => {}} />,
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(<RouterProvider router={router} />);
  return document;
}

test("under its limit a Bot shows nothing; nearing it, one quiet line and no action", async () => {
  assert.equal((await render({ ...base, state: "under", spentUsd: 2 })).body.textContent, "");
  const nearing = await render(base);
  assert.equal(nearing.body.textContent, "Ada has used $17.00 of its $20.00 limit this month.");
  assert.equal(nearing.querySelector("button"), null);
  assert.equal(nearing.querySelector("[role=alert]"), null);
});

test("at its limit the Bot's chat announces it and offers Allow more and Change limits", async () => {
  const reached = await render({ ...base, state: "reached", spentUsd: 20.4 });
  const alert = reached.querySelector("[role=alert]");
  assert.ok(alert, "the reached notice is announced");
  assert.equal(alert.getAttribute("aria-label"), "Spending limit reached");
  assert.match(alert.textContent ?? "", /Ada reached its \$20\.00 spending limit this month\./u);
  assert.match(alert.textContent ?? "", /It has spent \$20\.40\./u);
  const buttons = [...reached.querySelectorAll("button")].map((button) => button.textContent);
  assert.deepEqual(buttons, ["Change limits", "Allow $20.00 more"]);

  const busy = await render({ ...base, state: "reached", spentUsd: 20.4 }, true);
  const allow = [...busy.querySelectorAll("button")].find((button) => button.textContent === "Allow $20.00 more");
  assert.equal(allow?.hasAttribute("disabled"), true, "a second tap waits for the first");
});
