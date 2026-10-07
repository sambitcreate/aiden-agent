import { expect, finishLmStudioOnboarding, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("local Aiden Live, Scheduled, Profile, and About surfaces stay safe to explore", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  // The dock is now the one-time Aiden Live setup entry point. Exercise the
  // keyboard path without requesting system permissions or contacting Google.
  const liveSetupTrigger = page.getByRole("button", { name: "Set up Aiden Live" });
  await liveSetupTrigger.press("Enter");
  const liveSetup = page.getByRole("dialog", { name: "Set up Aiden Live" });
  await expect(liveSetup).toBeVisible();
  await expect(liveSetup.getByText("Beta", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Google Live model", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Microphone", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Screen and Accessibility", { exact: true })).toBeVisible();
  await expect(liveSetup.getByText("Scheduled tasks", { exact: true })).toBeVisible();
  await liveSetup.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(liveSetup).toHaveCount(0);
  await expect(liveSetupTrigger).toBeVisible();

  // Natural-language creation stays available even if manual task dependencies
  // are unavailable. Suggestions open editable chat drafts without saving tasks.
  await page.getByRole("button", { name: "Scheduled", exact: true }).click();
  await expect(page.getByText("Scheduled tasks", { exact: true }).first()).toBeVisible();
  const taskSearch = page.getByRole("searchbox", { name: "Search scheduled tasks" });
  await taskSearch.fill("definitely-not-a-schedule");
  await expect(taskSearch).toHaveValue("definitely-not-a-schedule");
  await expect(page.getByText("No matching tasks", { exact: true })).toBeVisible();
  const clearTaskSearch = page.getByRole("button", { name: "Clear scheduled task search" });
  await clearTaskSearch.click();
  await expect(taskSearch).toHaveValue("");
  await expect(taskSearch).toBeFocused();
  await expect(clearTaskSearch).toHaveCount(0);
  await expect(page.getByText("No matching tasks", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Active", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Active", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Paused", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Paused", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "All", exact: true }).click();
  const createWithAiden = page.getByRole("button", { name: "Create with Aiden", exact: true });
  await expect(createWithAiden).toBeEnabled();
  await createWithAiden.click();
  const seededComposer = page.locator("textarea");
  await expect(seededComposer).toHaveValue("Create an automation that ");
  await page.getByRole("button", { name: "Scheduled", exact: true }).click();
  const dailyBrief = page.getByRole("button", { name: /Daily brief/u });
  await expect(dailyBrief).toBeVisible();
  await dailyBrief.click();
  await expect(page.locator("textarea")).toHaveValue(/Create an automation named "Daily brief".*Summarize.*Schedule:/u);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  const profileName = page.getByRole("heading", {
    level: 2,
    name: "E2E Local User",
    exact: true,
  });
  await expect(profileName).toHaveText("E2E Local User");
  // The editor is a normal visible action here; exercise the same pointer path
  // a user takes after the scheduled-task dialog has fully closed.
  const editProfileName = page.getByRole("button", { name: "Edit profile name" });
  await expect(editProfileName).toBeVisible();
  await expect(editProfileName).toBeEnabled();
  await editProfileName.click();
  const profileInput = page.getByRole("textbox", { name: "Profile name" });
  await profileInput.fill("   ");
  await expect(page.getByRole("button", { name: "Save profile name" })).toBeDisabled();
  await profileInput.fill("Temporary E2E name");
  await expect(page.getByRole("button", { name: "Save profile name" })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel editing profile name" }).click();
  await expect(profileName).toHaveText("E2E Local User");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("All settings", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  await expect(page.getByText(/^Version .+ Beta/u)).toBeVisible();
  await expect(page.getByText("Diagnostics", { exact: true })).toBeVisible();
  await expect(page.getByText(/Nothing is uploaded automatically/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export…", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enable…", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("never uploaded automatically");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Delete…", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("does not delete chats");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  const mainComposer = page.locator("textarea");
  await expect(mainComposer).toBeVisible();
  await expect(mainComposer).toHaveValue("");
  await expect(
    page.getByRole("button", { name: /^Selected model: .+\. Choose a model\.$/u }),
  ).toBeVisible();
});

test.describe("conversational scheduling", () => {
  test.use({ workspaceSeed: true });

  test("answers a visible question and saves the approved task with its chosen model", async ({ aiden }) => {
    const { page, lmStudio } = aiden;
    await finishLmStudioOnboarding(page);
    const prompt = "Schedule audit: ask about timing, then prepare my workspace brief.";
    const scenario = lmStudio.enqueueToolScenario!({
      prompt,
      calls: [
        { name: "ask_user_question", arguments: { questions: [{
          question: "When should the workspace brief run?", header: "Timing",
          options: [{ label: "Weekdays", description: "Every weekday morning at nine." }, { label: "Weekly", description: "Every Friday morning at nine." }],
        }] } },
        { name: "schedule_task", arguments: {
          action: "create", name: "Audit workspace brief", cron: "0 9 * * 1-5", timezone: "America/New_York", prompt: "Summarize important workspace changes without modifying files.",
        } },
      ],
      finalText: "Your workspace brief has been saved.",
    });
    await page.locator("textarea").fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("heading", { name: "When should the workspace brief run?" })).toBeVisible();
    await page.getByRole("button", { name: /Weekdays Every weekday/u }).click();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    const approval = page.getByRole("region", { name: "schedule task needs approval" });
    await expect(approval).toContainText("Summarize important workspace changes without modifying files.");
    await approval.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByText("Your workspace brief has been saved.", { exact: true }).first()).toBeVisible();
    expect(scenario.error).toBeUndefined();
    const tasks = JSON.parse(await readFile(join(aiden.userDataDir, "schedules.json"), "utf8")) as Array<{ name: string; providerId?: string; model?: string; cron: string; permission: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ name: "Audit workspace brief", cron: "0 9 * * 1-5", permission: "read-only" });
    expect(tasks[0]?.providerId).toBeTruthy();
    expect(tasks[0]?.model).toBeTruthy();
    expect(JSON.stringify(scenario.results[0]?.content)).toContain("Weekdays");
    expect(JSON.stringify(scenario.results[1]?.content)).toContain("Audit workspace brief");
  });

  test("question tabs preserve answers and replace the composer in a short desktop window", async ({ aiden }, testInfo) => {
    const { page, lmStudio, app } = aiden;
    await finishLmStudioOnboarding(page);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.isVisible())!;
      window.setMinimumSize(640, 480);
      window.setSize(740, 520);
    });
    const prompt = "Question audit: ask me to choose a detailed schedule.";
    const scenario = lmStudio.enqueueToolScenario!({ prompt, calls: [{ name: "ask_user_question", arguments: { questions: [{
      question: "Which schedule best fits your working day and the time you want to review the results?",
      header: "Schedule", options: ["Morning", "Afternoon", "Evening", "Weekly"].map((label) => ({ label, description: `${label}: ${"Review changes and choose when you have time to act on the report. ".repeat(4)}` })),
    }, {
      question: "How detailed should the report be?", header: "Detail",
      options: [{ label: "Brief", description: "Just the highlights." }, { label: "Full", description: "Include all changes." }],
    }] } }], finalText: "I received your custom schedule." });
    await page.locator("textarea").fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByRole("button", { name: "Type your own answer" }).click();
    await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
    await page.getByRole("textbox", { name: /Custom answer for/u }).fill("Every Tuesday at noon");
    await page.getByRole("tab", { name: "2. Detail" }).click();
    await expect(page.getByRole("heading", { name: /Which schedule best/u })).toHaveCount(0);
    await page.getByRole("button", { name: "Brief Just the highlights." }).click();
    await page.getByRole("tab", { name: /1. Schedule/u }).click();
    await expect(page.getByRole("textbox", { name: /Custom answer for/u })).toHaveValue("Every Tuesday at noon");
    await page.getByRole("tab", { name: /1. Schedule/u }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: /2. Detail/u })).toBeFocused();
    await expect(page.getByRole("button", { name: /Brief.*Just the highlights/u })).toHaveAttribute("aria-pressed", "true");
    const submit = page.getByRole("button", { name: "Submit", exact: true });
    await expect(submit).toBeInViewport();
    const shell = page.getByRole("region", { name: "How detailed should the report be?" });
    const bounds = await shell.boundingBox();
    const sidebar = await page.locator("[data-sidebar]").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width);
    await page.screenshot({ path: testInfo.outputPath("question-composer.png") });
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText("I received your custom schedule.", { exact: true }).first()).toBeVisible();
    expect(JSON.stringify(scenario.results)).toContain("Every Tuesday at noon");
    expect(JSON.stringify(scenario.results)).toContain("Brief");
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  });

  test("desktop displays a phone-owned question and sends the answer through host authority", async ({ aiden }) => {
    const { page, app } = aiden;
    await finishLmStudioOnboarding(page);
    await page.locator("textarea").fill("Create a conversation for the phone question audit.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Deterministic E2E response received.", { exact: true }).first()).toBeVisible();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      let pending = true;
      ipcMain.removeHandler("remote:getPendingQuestion");
      ipcMain.handle("remote:getPendingQuestion", (_event, chatId) => pending ? ({
        version: 1, source: "remote", promptId: "phone-question", chatId,
        streamId: "phone-stream", toolCallId: "phone-call", expiresAt: new Date(Date.now() + 300_000).toISOString(),
        questions: [{ question: "Which cadence should I use from your phone?", header: "Cadence", multiSelect: false,
          options: [{ label: "Daily", description: "Every day." }, { label: "Weekly", description: "Every Friday." }] }],
      }) : null);
      ipcMain.removeHandler("remote:respondQuestionFromHost");
      ipcMain.handle("remote:respondQuestionFromHost", (_event, chatId, promptId, response) => {
        if (!chatId || promptId !== "phone-question" || response.answers[0]?.answer !== "Weekly") throw new Error("Wrong question answer or chat");
        pending = false;
        BrowserWindow.getAllWindows()[0]?.webContents.send("remote:approval-changed", { chatId });
        return { status: "answered" };
      });
      ipcMain.removeHandler("chat:answerQuestionnaire");
      ipcMain.handle("chat:answerQuestionnaire", () => { throw new Error("Phone questions do not belong to this renderer"); });
    });
    await page.getByRole("button", { name: "Scheduled", exact: true }).click();
    await page.locator("[data-sidebar]").getByRole("button", { name: /Deterministic E2E response received/u }).first().click();
    await expect(page.getByRole("heading", { name: "Which cadence should I use from your phone?" })).toBeVisible();
    await page.getByRole("button", { name: "Weekly Every Friday." }).click();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Which cadence should I use from your phone?" })).toHaveCount(0);
    await expect(page.locator("textarea")).toBeVisible();
  });
});
