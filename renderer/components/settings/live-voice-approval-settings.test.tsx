import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { mountWithBotRouter } from "../../main/bots/test-providers";
import { LiveVoiceApprovalSettings } from "./live-voice-approval-settings";

afterEach(cleanup);

async function mount(settings: Record<string, unknown> = {}) {
  let stored = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => stored,
    "settings:set": (patch) => {
      stored = { ...stored, ...(patch as Record<string, unknown>) };
      return stored;
    },
  });
  await mountWithBotRouter(<LiveVoiceApprovalSettings />, { initialPath: "/settings" });
  return { calls };
}

test("the switch is on by default, names the languages and lists what to say in each", async () => {
  await mount();
  const row = await screen.findByRole("group", { name: "Answer approvals by voice" });
  assert.equal(within(row).getByRole("switch").getAttribute("aria-checked"), "true");
  within(row).getByText(
    "Works in English, Spanish, French, German, Portuguese, Italian, Hindi, Bengali, Japanese, Korean and Chinese.",
  );
  screen.getByText("Allow and deny phrases in 11 languages");
  const hindi = screen.getByRole("group", { name: "Hindi" });
  assert.match(hindi.textContent ?? "", /“अनुमति दो”/u);
  const spanish = screen.getByRole("group", { name: "Spanish" });
  assert.match(spanish.textContent ?? "", /Allow once: “permitir”/u);
  assert.match(spanish.textContent ?? "", /Deny: “denegar”/u);
});

test("turning it off saves the setting and hides the phrase list", async () => {
  const { calls } = await mount();
  const row = await screen.findByRole("group", { name: "Answer approvals by voice" });
  fireEvent.click(within(row).getByRole("switch"));
  await waitFor(() =>
    assert.deepEqual(
      calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]),
      [{ aidenLiveVoiceApprovals: false }],
    ),
  );
  await waitFor(() => assert.ok(!screen.queryByText("What to say")));
});
