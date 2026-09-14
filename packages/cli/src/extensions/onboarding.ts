import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { onboardingProgressState, assertOnboardingCanComplete } from "../../../../main/services/onboarding-state-core.js";
import { parseOnboardingState } from "../../../../renderer/shared/onboarding.js";
import { atomicJson, readJson, JsonStore } from "../state.ts";
import { workspaceCommand } from "../workspaces.ts";

export const CLI_FEATURE_TOUR = [
  "Chats: /search finds sessions; /export-aiden and aiden import move portable conversations.",
  "Workspace access: /workspace chooses full, ask or none. Headless jobs cannot answer approval prompts.",
  "Tools: advisor, memory, web search, MCP, delegated tasks and standalone HTML artifacts share this session.",
  "Automation: aiden serve runs schedules, Bots and configured Telegram. Each Bot has separate Full or Custom access.",
  "Remote: aiden serve --remote enables authenticated HTTPS and event streams for paired phones. Pairing, approved folders and Tailscale are controlled locally.",
  "Speech: aiden speech explicitly installs and runs local transcription models. No model download runs during setup.",
  "Privacy: CLI credentials and history live in your private agent directory. Benchmark catalogs fetch only after your explicit command.",
] as const;

export function createOnboardingExtension(agentDir: string): InlineExtension {
  return { name: "aiden-onboarding", factory(pi) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI || process.env.AIDEN_CHILD === "1") return;
      const file = join(agentDir, "onboarding.json"), saved = parseOnboardingState(readJson(file, null));
      if (saved?.outcome === "completed" || saved?.outcome === "deferred") return;
      const profile = readJson<{ name?: string }>(join(agentDir, "profile.json"), {});
      const name = profile.name ?? (await ctx.ui.input("What should Aiden call you?", "Your name"))?.trim();
      if (!name) return;
      if (name.length > 160) throw new Error("Use a name of at most 160 characters.");
      atomicJson(join(agentDir, "profile.json"), { name });
      const ready = { profileReady: true, providerReady: false, selectedProviderId: undefined as string | undefined };
      const choice = await ctx.ui.select("Welcome to Aiden — workspace tool access", ["Ask before each tool call", "Allow full tool access", "Disable tools", "Set up later"]);
      if (!choice || choice === "Set up later") { atomicJson(file, onboardingProgressState("deferred", ready)); return; }
      const workspace = await workspaceCommand(agentDir, ["add", ctx.cwd]) as { id: string };
      await workspaceCommand(agentDir, ["access", workspace.id, choice.startsWith("Allow") ? "full" : choice.startsWith("Disable") ? "none" : "ask"]);
      const theme = await ctx.ui.select("Appearance", ["dark", "light", "slate-dark", "slate-light", "berry-dark", "berry-light", "moss-dark", "moss-light"]);
      if (theme) { ctx.ui.setTheme(theme); await new JsonStore<Record<string, unknown>>(join(agentDir, "settings.json"), {}).update((settings) => { settings.theme = theme; }); }
      const available = ctx.modelRegistry.getAvailable();
      const selection = await ctx.ui.select("Choose a configured model, or connect a provider with aiden auth login", [...available.map((model) => `${model.provider}/${model.id}`), "Connect a provider later"]);
      const model = available.find((model) => `${model.provider}/${model.id}` === selection);
      if (model && await pi.setModel(model)) { ready.providerReady = true; ready.selectedProviderId = model.provider; }
      for (const feature of CLI_FEATURE_TOUR) ctx.ui.notify(feature, "info");
      if (ready.providerReady) {
        assertOnboardingCanComplete(ready);
        atomicJson(file, { ...onboardingProgressState("completed", ready), lastSatisfiedStep: "tour" });
      } else {
        atomicJson(file, onboardingProgressState("incomplete", ready));
        ctx.ui.notify("Connect a provider with aiden auth login <provider>, then restart Aiden to finish setup. aiden reset opens setup again without deleting credentials or chats.", "info");
      }
    });
  } };
}
