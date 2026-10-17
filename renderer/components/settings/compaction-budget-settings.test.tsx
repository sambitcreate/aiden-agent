import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CompactionBudgetSettings } from "./compaction-budget-settings";
import type { CompactionModelOverrides } from "../../shared/compaction";

afterEach(cleanup);

function mount(overrides: CompactionModelOverrides, modelKeys: readonly string[] = []) {
  const saves: Array<[string, CompactionModelOverrides[string] | undefined]> = [];
  render(
    <CompactionBudgetSettings
      overrides={overrides}
      modelKeys={modelKeys}
      disabled={false}
      onSave={async (modelKey, budget) => {
        saves.push([modelKey, budget]);
      }}
    />,
  );
  return saves;
}

const modelInput = () => screen.getByLabelText("Model for compaction budget") as HTMLInputElement;
const reserveInput = () => screen.getByLabelText("Compaction reserved tokens") as HTMLInputElement;
const recentInput = () => screen.getByLabelText("Compaction recent tokens") as HTMLInputElement;
const savedChip = (key: string) =>
  Array.from(screen.getByLabelText("Saved model budgets").querySelectorAll("button")).find(
    (button) => button.textContent === key,
  )!;

test("switching to a model without an override clears the other model's budget instead of saving it", async () => {
  const saves = mount({ "a/x": { reserveTokens: 50000, keepRecentTokens: 20000 } }, ["b/y"]);

  fireEvent.click(savedChip("a/x"));
  assert.equal(modelInput().value, "a/x");
  assert.equal(reserveInput().value, "50000");
  assert.equal(recentInput().value, "20000");

  fireEvent.change(modelInput(), { target: { value: "b/y" } });
  assert.equal(reserveInput().value, "");
  assert.equal(recentInput().value, "");

  fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
  await waitFor(() => assert.equal(saves.length, 1));
  assert.deepEqual(saves, [["b/y", undefined]]);
});

test("choosing a model with a saved override restores its own numbers", () => {
  mount({
    "a/x": { reserveTokens: 50000, keepRecentTokens: 20000 },
    "c/z": { reserveTokens: 8000 },
  });

  fireEvent.click(savedChip("a/x"));
  fireEvent.change(modelInput(), { target: { value: "c/z" } });
  assert.equal(reserveInput().value, "8000");
  assert.equal(recentInput().value, "");

  fireEvent.click(savedChip("a/x"));
  assert.equal(reserveInput().value, "50000");
  assert.equal(recentInput().value, "20000");
});
