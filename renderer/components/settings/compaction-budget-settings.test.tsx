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

test("numbers typed before finishing the model name survive each keystroke of the name", async () => {
  const saves = mount({ "a/x": { reserveTokens: 50000 } });

  fireEvent.change(modelInput(), { target: { value: "fixture/exact" } });
  fireEvent.change(reserveInput(), { target: { value: "8192" } });
  fireEvent.change(recentInput(), { target: { value: "0" } });
  fireEvent.change(modelInput(), { target: { value: "fixture/exact-" } });
  fireEvent.change(modelInput(), { target: { value: "fixture/exact-model" } });
  assert.equal(reserveInput().value, "8192");
  assert.equal(recentInput().value, "0");

  fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
  await waitFor(() => assert.equal(saves.length, 1));
  assert.deepEqual(saves, [["fixture/exact-model", { reserveTokens: 8192, keepRecentTokens: 0 }]]);
});

test("after saving a new override, choosing another unconfigured model starts blank", async () => {
  const saves: Array<[string, CompactionModelOverrides[string] | undefined]> = [];
  const props = { modelKeys: ["b/y"], disabled: false };
  const onSave = async (modelKey: string, budget: CompactionModelOverrides[string] | undefined) => {
    saves.push([modelKey, budget]);
  };
  const view = render(<CompactionBudgetSettings overrides={{}} onSave={onSave} {...props} />);

  fireEvent.change(modelInput(), { target: { value: "a/x" } });
  fireEvent.change(reserveInput(), { target: { value: "9000" } });
  fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
  await waitFor(() => assert.equal(saves.length, 1));
  // The parent refreshes its overrides without remounting the form.
  view.rerender(<CompactionBudgetSettings overrides={{ "a/x": { reserveTokens: 9000 } }} onSave={onSave} {...props} />);

  fireEvent.change(modelInput(), { target: { value: "b/y" } });
  assert.equal(reserveInput().value, "", "a/x's saved numbers do not carry over to b/y");
  assert.equal(recentInput().value, "");
});
