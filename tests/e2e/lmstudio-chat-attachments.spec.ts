import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertNoPersistedProviderCredentials,
  E2E_ASSISTANT_RESPONSE,
  E2E_MODEL_ID,
  expect,
  finishLmStudioOnboarding,
  REPOSITORY_ROOT,
  test,
  type CapturedLmStudioRequest,
} from "./fixtures";

const CLIPBOARD_IMAGE_NAME = "Pasted image.png";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object.`);
  }
  return value as Record<string, unknown>;
}

async function safePngBase64(): Promise<string> {
  const fixture = await readFile(path.join(REPOSITORY_ROOT, "resources", "app-icon.png"));
  return fixture.toString("base64");
}

async function pasteImage(
  page: Parameters<typeof finishLmStudioOnboarding>[0],
  base64: string,
  text = "",
): Promise<void> {
  const composer = page.locator("textarea");
  await composer.evaluate(
    (element, { imageBase64, pastedText }) => {
      const binary = atob(imageBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const image = new File([bytes], "clipboard.png", { type: "image/png" });
      const clipboard = new DataTransfer();
      clipboard.items.add(image);
      clipboard.setData("text/plain", pastedText);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    },
    { imageBase64: base64, pastedText: text },
  );
  await expect(page.getByRole("button", { name: `Remove ${CLIPBOARD_IMAGE_NAME}` })).toBeVisible();
}

function multimodalRequest(
  requests: CapturedLmStudioRequest[],
  prompt: string,
): CapturedLmStudioRequest {
  const matches = requests.filter((request) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return false;
    const body = record(request.body, "chat completion body");
    const messages = body.messages;
    return (
      Array.isArray(messages) &&
      messages.some((message) => {
        const candidate = record(message, "chat message");
        if (candidate.role !== "user" || !Array.isArray(candidate.content)) return false;
        return candidate.content.some((part) => record(part, "message part").text === prompt);
      })
    );
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one captured multimodal request, received ${matches.length}.`);
  }
  return matches[0];
}

test("deterministic LM Studio chat sends the exact keyless multimodal payload", async ({
  aiden,
}) => {
  const { page } = aiden;
  const imageBase64 = await safePngBase64();
  await finishLmStudioOnboarding(page);

  const composer = page.locator("textarea");
  await pasteImage(page, imageBase64);
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: `Remove ${CLIPBOARD_IMAGE_NAME}` }).click();
  await expect(page.getByRole("button", { name: `Remove ${CLIPBOARD_IMAGE_NAME}` })).toHaveCount(0);

  const prompt = "Deterministic multimodal request from the Aiden E2E suite.";
  await pasteImage(page, imageBase64, prompt);
  await expect(composer).toHaveValue(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  // The mock can complete before a transient Stop button paints. The durable
  // assistant message after the streaming-reveal handoff is the contract.
  await expect(page.getByRole("button", { name: "Copy message" })).toHaveCount(2);
  await expect(page.locator(".streaming-reveal")).toHaveCount(0);
  const assistantResponse = page.getByText(E2E_ASSISTANT_RESPONSE, { exact: true });
  await expect(assistantResponse).toHaveCount(1);
  await expect(assistantResponse).toBeVisible();
  await expect(page.getByText("Generation failed", { exact: true })).toHaveCount(0);

  const captured = multimodalRequest(aiden.lmStudio.requests, prompt);
  expect(captured.headers.authorization).toBeUndefined();
  expect(captured.headers["x-api-key"]).toBeUndefined();
  const body = record(captured.body, "captured chat completion");
  expect(body.model).toBe(E2E_MODEL_ID);
  expect(body.stream).toBe(true);
  const messages = body.messages;
  if (!Array.isArray(messages)) throw new Error("Captured request messages were not an array.");
  const userMessage = messages
    .map((message) => record(message, "captured message"))
    .find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part) => record(part, "captured message part").text === prompt),
    );
  if (!userMessage || !Array.isArray(userMessage.content)) {
    throw new Error("The captured request did not contain the submitted user message.");
  }
  const parts = userMessage.content.map((part) => record(part, "captured user content part"));
  expect(parts).toEqual([
    { type: "text", text: prompt },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${imageBase64}` },
    },
  ]);
  await assertNoPersistedProviderCredentials(aiden);

  await composer.fill("Unsaved draft must stay out of the next chat.");
  await pasteImage(page, imageBase64);
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New agent");
  await expect(page.locator("textarea")).toHaveValue("");
  await expect(page.getByRole("button", { name: `Remove ${CLIPBOARD_IMAGE_NAME}` })).toHaveCount(0);
});
