import { randomInt } from "node:crypto";
import { expect, finishLmStudioOnboarding, LIVE_LM_STUDIO_ACCEPTANCE, test } from "./fixtures";

const INFERENCE_TIMEOUT_MS = 120_000;
const CLIPBOARD_IMAGE_NAME = "Pasted image.png";

type LiveModel = {
  key: string;
  displayName: string;
  loaded: boolean;
};

async function resolveVisionModel(baseUrl: string): Promise<LiveModel> {
  const inventoryUrl = new URL(baseUrl);
  inventoryUrl.pathname = "/api/v1/models";
  const response = await fetch(inventoryUrl);
  if (!response.ok) {
    throw new Error(`LM Studio model inventory failed: ${response.status} ${response.statusText}.`);
  }
  const payload = (await response.json()) as { models?: unknown };
  const models = Array.isArray(payload.models) ? payload.models : [];
  const candidates = models.flatMap((value): LiveModel[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const model = value as Record<string, unknown>;
    const capabilities = model.capabilities;
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return [];
    if ((capabilities as Record<string, unknown>).vision !== true || model.type !== "llm")
      return [];
    if (typeof model.key !== "string" || typeof model.display_name !== "string") return [];
    return [
      {
        key: model.key,
        displayName: model.display_name,
        loaded: Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0,
      },
    ];
  });
  const selected = candidates.find((model) => model.loaded) ?? candidates[0];
  if (selected) return selected;
  throw new Error(`LM Studio has no vision-capable LLM at ${baseUrl}.`);
}

async function selectVisionModel(
  page: Parameters<typeof finishLmStudioOnboarding>[0],
  model: LiveModel,
): Promise<void> {
  await page.getByRole("button", { name: /^Selected model:/u }).click();
  const listTab = page.getByRole("tab", { name: "List" });
  if (await listTab.count()) await listTab.click();
  await page
    .getByRole("listbox", { name: "Suggestions" })
    .getByRole("option")
    .filter({ hasText: model.displayName })
    .click();
}

async function pasteVisionToken(
  page: Parameters<typeof finishLmStudioOnboarding>[0],
  text: string,
  token: string,
): Promise<void> {
  await page.locator("textarea").evaluate(
    async (element, { pastedText, visionToken }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 720;
      canvas.height = 320;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable.");
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "black";
      context.font = "bold 110px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(visionToken, canvas.width / 2, canvas.height / 2);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("PNG encoding failed."))),
          "image/png",
        ),
      );
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([blob], "vision-token.png", { type: "image/png" }));
      clipboard.setData("text/plain", pastedText);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    },
    { pastedText: text, visionToken: token },
  );
  await expect(page.getByText(CLIPBOARD_IMAGE_NAME, { exact: true })).toBeVisible();
}

test.skip(
  !LIVE_LM_STUDIO_ACCEPTANCE,
  "Run only through the explicit test:e2e:live:lmstudio acceptance command.",
);

test("opt-in live LM Studio vision acceptance", async ({ aiden }) => {
  test.setTimeout(INFERENCE_TIMEOUT_MS + 60_000);
  const model = await resolveVisionModel(aiden.lmStudio.baseUrl);
  await finishLmStudioOnboarding(aiden.page);
  await selectVisionModel(aiden.page, model);

  const visionToken = randomInt(1000, 10_000).toString();
  const prompt = "Read the attached image and reply with only the four-digit code it contains.";
  await pasteVisionToken(aiden.page, prompt, visionToken);
  await aiden.page.getByRole("button", { name: "Send message" }).click();
  const copyButtons = aiden.page.getByRole("button", { name: "Copy message" });
  await expect(copyButtons).toHaveCount(2, {
    timeout: INFERENCE_TIMEOUT_MS,
  });
  await expect(aiden.page.getByText("Generation failed", { exact: true })).toHaveCount(0);
  await expect(aiden.page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(aiden.page.getByRole("img", { name: CLIPBOARD_IMAGE_NAME })).toHaveCount(1);
  const assistantMessage = copyButtons
    .last()
    .locator(
      "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' group ')][1]",
    );
  await expect(assistantMessage).toContainText(new RegExp(`\\b${visionToken}\\b`, "u"));
});
