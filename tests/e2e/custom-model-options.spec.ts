import {
  E2E_MODEL_ID,
  E2E_MODEL_DISPLAY_NAME,
  expect,
  finishLmStudioOnboarding,
  test,
  type CapturedLmStudioRequest,
} from "./fixtures";

function lastUserText(request: CapturedLmStudioRequest): string | undefined {
  if (request.url !== "/v1/chat/completions") return undefined;
  const body = request.body as {
    messages?: Array<{ role: string; content: string | Array<{ text?: string }> }>;
  } | null;
  const user = body?.messages?.slice().reverse().find((message) => message.role === "user");
  return typeof user?.content === "string" ? user.content : user?.content.map((part) => part.text ?? "").join("");
}

test("custom model options survive save and rediscovery, and can be reset", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Providers", exact: true })
    .click();
  const configure = page
    .getByText("LM Studio (local)", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Manage']][1]")
    .getByRole("button", { name: "Manage", exact: true });
  const dialog = page.getByRole("dialog", {
    name: "Configure LM Studio (local)",
  });
  await configure.click();
  await dialog
    .getByRole("button", { name: "Model options", exact: true })
    .click();
  await dialog
    .locator("summary")
    .filter({ hasText: E2E_MODEL_DISPLAY_NAME })
    .click();
  const vision = dialog.getByRole("switch", {
    name: `${E2E_MODEL_ID}: Vision`,
    exact: true,
  });
  await expect(vision).toHaveAttribute("data-state", "checked");
  const imageLimit = dialog.getByRole("spinbutton", {
    name: `${E2E_MODEL_ID}: Maximum images per message`, exact: true,
  });
  await imageLimit.fill("0");
  await expect(vision).toHaveAttribute("data-state", "unchecked");
  await expect(dialog.getByText("Text only for this connection", { exact: false })).toBeVisible();
  await vision.click();
  await expect(imageLimit).toHaveValue("");
  await expect(vision).toHaveAttribute("data-state", "checked");
  await vision.click();
  await dialog
    .getByRole("switch", { name: `${E2E_MODEL_ID}: Open weights`, exact: true })
    .click();
  await dialog
    .getByRole("spinbutton", {
      name: `${E2E_MODEL_ID}: Context length (tokens)`,
      exact: true,
    })
    .fill("8192");
  await dialog
    .getByRole("spinbutton", {
      name: `${E2E_MODEL_ID}: Maximum images per message`,
      exact: true,
    })
    .fill("2");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog
    .getByRole("button", { name: "Model options", exact: true })
    .click();
  await dialog
    .locator("summary")
    .filter({ hasText: E2E_MODEL_DISPLAY_NAME })
    .click();
  await expect(vision).toHaveAttribute("data-state", "unchecked");
  await expect(
    dialog.getByRole("spinbutton", {
      name: `${E2E_MODEL_ID}: Context length (tokens)`,
      exact: true,
    }),
  ).toHaveValue("8192");
  await dialog
    .getByRole("button", { name: "Discover models", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Discover models", exact: true }),
  ).toBeEnabled();
  await expect(vision).toHaveAttribute("data-state", "unchecked");
  const contextInput = dialog.getByRole("spinbutton", {
    name: `${E2E_MODEL_ID}: Context length (tokens)`,
    exact: true,
  });
  await contextInput.fill("");
  await expect(contextInput).toHaveAttribute("placeholder", "32768");
  await dialog
    .getByRole("button", { name: "Use detected capabilities", exact: true })
    .click();
  await expect(vision).toHaveAttribute("data-state", "checked");
  await expect(
    dialog.getByRole("switch", {
      name: `${E2E_MODEL_ID}: Open weights`,
      exact: true,
    }),
  ).toHaveAttribute("data-state", "unchecked");
  await dialog
    .getByRole("textbox", { name: "Model ID", exact: true })
    .fill("manual-private-model");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog
    .locator("summary")
    .filter({ hasText: "manual-private-model" })
    .click();
  await dialog
    .getByRole("spinbutton", {
      name: "manual-private-model: Context length (tokens)",
      exact: true,
    })
    .fill("7777");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog
    .getByRole("button", { name: "Model options", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Discover models", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Discover models", exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.locator("summary").filter({ hasText: "manual-private-model" }),
  ).toBeVisible();
  await dialog
    .getByRole("group", { name: "Base URL", exact: true })
    .locator("input")
    .fill("http://127.0.0.1:1/v1");
  await dialog
    .getByRole("textbox", { name: "Model ID", exact: true })
    .fill("manual-without-discovery");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog
    .getByRole("button", { name: "Model options", exact: true })
    .click();
  await dialog
    .getByRole("group", { name: "Base URL", exact: true })
    .locator("input")
    .fill("http://127.0.0.1:2/v1");
  await dialog
    .getByRole("textbox", { name: "Model ID", exact: true })
    .fill("manual-without-discovery");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog
    .getByRole("button", { name: "Model options", exact: true })
    .click();
  await expect(
    dialog.locator("summary").filter({ hasText: "manual-without-discovery" }),
  ).toBeVisible();
  await dialog
    .locator("summary")
    .filter({ hasText: "manual-private-model" })
    .click();
  await expect(
    dialog.getByRole("spinbutton", {
      name: "manual-private-model: Context length (tokens)",
      exact: true,
    }),
  ).toHaveValue("7777");
});

test("local classifier capability is off by default and survives provider save", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Providers", exact: true }).click();
  const configure = page.getByText("LM Studio (local)", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Manage']][1]")
    .getByRole("button", { name: "Manage", exact: true });
  const dialog = page.getByRole("dialog", { name: "Configure LM Studio (local)" });
  await configure.click();
  await dialog.getByRole("button", { name: "Model options", exact: true }).click();
  const capability = dialog.getByRole("switch", { name: "Enable llama.cpp classification", exact: true });
  await expect(capability).toHaveAttribute("data-state", "unchecked");
  await capability.click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog.getByRole("button", { name: "Model options", exact: true }).click();
  await expect(capability).toHaveAttribute("data-state", "checked");
  await dialog.locator("summary").filter({ hasText: "Connection options" }).click();
  await dialog.getByRole("combobox").filter({ hasText: "Local" }).click();
  await page.getByRole("option", { name: "Hosted", exact: true }).click();
  await expect(capability).toBeDisabled();
  await expect(capability).toHaveAttribute("data-state", "unchecked");
  await dialog.getByRole("combobox").filter({ hasText: "Hosted" }).click();
  await page.getByRole("option", { name: "Local", exact: true }).click();
  await expect(capability).toBeEnabled();
  await capability.click();
  await dialog.getByRole("combobox").filter({ hasText: "OpenAI-compatible" }).click();
  await page.getByRole("option", { name: "Anthropic-compatible", exact: true }).click();
  await expect(capability).toBeDisabled();
  await expect(capability).toHaveAttribute("data-state", "unchecked");
  await dialog.getByRole("combobox").filter({ hasText: "Anthropic-compatible" }).click();
  await page.getByRole("option", { name: "OpenAI-compatible", exact: true }).click();
  await expect(capability).toBeEnabled();
  // API changes make discovery stale, so verify against the same mock endpoint before saving.
  await dialog.getByRole("button", { name: "Discover models", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Discover models", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await configure.click();
  await dialog.getByRole("button", { name: "Model options", exact: true }).click();
  await expect(capability).toHaveAttribute("data-state", "unchecked");
});


test("custom GLM effort selector persists and sends every supported thinking mode", async ({ aiden }, testInfo) => {
  let { page } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Providers", exact: true }).click();
  const configure = page.getByText("LM Studio (local)", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Manage']][1]")
    .getByRole("button", { name: "Manage", exact: true });
  const dialog = page.getByRole("dialog", { name: "Configure LM Studio (local)" });
  const openOptions = async () => {
    await configure.click();
    await dialog.getByRole("button", { name: "Model options", exact: true }).click();
    await dialog.locator("summary").filter({ hasText: E2E_MODEL_DISPLAY_NAME }).click();
  };
  await openOptions();
  const selector = dialog.getByRole("combobox", { name: `${E2E_MODEL_ID}: Effort request format`, exact: true });
  await expect(selector).toHaveText("Not configured");
  await selector.click();
  await page.getByRole("option", { name: "GLM / vLLM", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: `${E2E_MODEL_ID}: Reasoning`, exact: true })).toHaveAttribute("data-state", "checked");
  const supportedLevels = dialog.getByRole("button", { name: `${E2E_MODEL_ID}: Supported effort levels`, exact: true });
  await supportedLevels.click();
  for (const [label, checked] of [["None", true], ["Low", true], ["Medium", false], ["High", true], ["Extra high", false], ["Max", true]] as const) {
    await expect(page.getByRole("menuitemcheckbox", { name: label, exact: true })).toHaveAttribute("aria-checked", String(checked));
  }
  await page.getByRole("menuitemcheckbox", { name: "Medium", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Extra high", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "High", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("menuitemcheckbox", { name: "High", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(supportedLevels).toHaveText("None, Low, Medium, Extra high, Max");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await openOptions();
  await expect(selector).toHaveText("GLM / vLLM");
  await expect(supportedLevels).toHaveText("None, Low, Medium, Extra high, Max");
  await dialog.getByRole("button", { name: "Discover models", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Discover models", exact: true })).toBeEnabled();
  await expect(selector).toHaveText("GLM / vLLM");
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(430, 850));
  await selector.scrollIntoViewIfNeeded();
  const fits = await selector.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  });
  expect(fits).toBe(true);
  await supportedLevels.scrollIntoViewIfNeeded();
  expect(await supportedLevels.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollHeight <= element.clientHeight;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("custom-effort-settings.png"), animations: "disabled" });
  await supportedLevels.click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(6);
  await page.screenshot({ path: testInfo.outputPath("custom-effort-multiselect.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  const controls = page.getByRole("radiogroup", { name: "LM Studio (local) thinking level", exact: true });
  await expect(controls).toBeVisible();
  expect(await controls.getByRole("radio").count()).toBe(5);
  await expect(controls.getByRole("radio", { name: "Thinking: high effort", exact: true })).toHaveCount(0);
  for (const [level, expected] of [
    ["low", { enable_thinking: true, reasoning_effort: "low" }],
    ["medium", { enable_thinking: true, reasoning_effort: "medium" }],
    ["xhigh", { enable_thinking: true, reasoning_effort: "xhigh" }],
    ["max", { enable_thinking: true, reasoning_effort: "max" }],
    ["off", { enable_thinking: false }],
  ] as const) {
    await controls.hover();
    const selected = controls.getByRole("radio", { name: level === "off" ? "Thinking: off" : `Thinking: ${level} effort`, exact: true });
    // Unselected levels are revealed by hover or focus within the group. The
    // click's scroll-into-view can move the group out from under a stationary
    // pointer and collapse it, so hold it open with focus (which alone never
    // changes the level) and let the click select.
    await selected.focus();
    await expect(selected).toBeVisible();
    await selected.click();
    await expect(selected).toHaveAttribute("aria-checked", "true");
    const prompt = `Custom effort check ${level}`;
    await page.locator("textarea").fill(prompt);
    await page.locator("textarea").press("Enter");
    const matchingRequests = () => aiden.lmStudio.requests.filter((request) => lastUserText(request) === prompt);
    await expect.poll(() => matchingRequests().length).toBeGreaterThan(0);
    const requests = matchingRequests();
    const body = requests[requests.length - 1].body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual(expected);
    expect(body.reasoning_effort).toBeUndefined();
    await expect(controls).not.toHaveAttribute("aria-disabled", "true");
  }
  // Remember an enabled effort, then reset the connection. A hidden selector
  // must not leave the old effort active on subsequent requests.
  await controls.hover();
  const max = controls.getByRole("radio", { name: "Thinking: max effort", exact: true });
  await max.focus();
  await expect(max).toBeVisible();
  await max.click();
  page = await aiden.relaunch();
  await expect(page.getByRole("radio", { name: "Thinking: max effort", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByText("LM Studio (local)", { exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Manage']][1]")
    .getByRole("button", { name: "Manage", exact: true }).click();
  const resetDialog = page.getByRole("dialog", { name: "Configure LM Studio (local)" });
  await resetDialog.getByRole("button", { name: "Model options", exact: true }).click();
  await resetDialog.locator("summary").filter({ hasText: E2E_MODEL_DISPLAY_NAME }).click();
  await resetDialog.getByRole("button", { name: "Use detected capabilities", exact: true }).click();
  await expect(resetDialog.getByRole("combobox", { name: `${E2E_MODEL_ID}: Effort request format`, exact: true })).toHaveText("Not configured");
  await resetDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(resetDialog).toBeHidden();
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("radiogroup", { name: "LM Studio (local) thinking level", exact: true })).toHaveCount(0);
  const prompt = "Custom effort reset check";
  await page.locator("textarea").fill(prompt);
  await page.locator("textarea").press("Enter");
  const resetRequests = () => aiden.lmStudio.requests.filter((request) => lastUserText(request) === prompt);
  await expect.poll(() => resetRequests().length).toBeGreaterThan(0);
  const requests = resetRequests();
  const body = requests[requests.length - 1].body as Record<string, unknown>;
  expect(body.chat_template_kwargs).toBeUndefined();
  expect(body.reasoning_effort).toBeUndefined();
});
