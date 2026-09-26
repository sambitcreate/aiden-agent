import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Credential, ApiKeyCredential, OAuthCredential, AuthType } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderAuthFlowCoordinator, type ProviderAuthPromptDto, type ProviderAuthEventDto, type ProviderAuthDoneDto, type ProviderAuthErrorDto, type ProviderAuthOwner } from "../../../main/services/provider-auth-flow-core.js";
import { validateOnboardingProviderCredential } from "../../../main/services/onboarding-provider-validation.js";
import { createCliModelRuntime } from "./providers.ts";

export function createCliAuthCoordinator(runtime: ModelRuntime, openExternal: (url: string) => Promise<void>) {
  return new ProviderAuthFlowCoordinator({ openExternal,
    backendFor(providerId, authType) {
      const provider = runtime.getProvider(providerId);
      if (!provider) throw new Error("Provider not found.");
      return {
        snapshot: () => runtime.listCredentials(),
        logout: () => runtime.logout(providerId),
        async authenticate(interaction) {
          const login = authType === "oauth" ? provider.auth.oauth?.login : provider.auth.apiKey?.login;
          if (!login) throw new Error(`This provider does not offer ${authType} login.`);
          const credential = await login({ ...interaction, signal: interaction.signal ?? new AbortController().signal });
          if (credential.type === "api_key" && credential.key) {
            const models = runtime.getModels(providerId), first = models[0];
            if (!first) throw new Error("This provider has no installed chat models.");
            await validateOnboardingProviderCredential({ provider: { id: providerId, label: provider.name, kind: first.api === "anthropic-messages" ? "anthropic" : "openai", baseUrl: first.baseUrl, needsKey: true, models: models.map((model) => model.id) },
              apiKey: credential.key, installedModelIds: models.map((model) => model.id), isCurrent: () => !interaction.signal?.aborted,
              // Validation precedes the coordinator's sole durable commit boundary.
              commit: async () => {},
            });
          }
          return credential;
        },
        async commitCredential(value) {
          const credential = value as Credential;
          if (credential.type !== authType) throw new Error("The provider returned a different credential type.");
          // Retain pi's serialized credential store and synchronization behavior.
          // The temporary login implementation returns only the already-authenticated value.
          runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth,
            ...(authType === "oauth" ? { oauth: { ...provider.auth.oauth!, login: async () => credential as OAuthCredential } }
              : { apiKey: { ...provider.auth.apiKey!, login: async () => credential as ApiKeyCredential } }),
          } });
          try { await runtime.login(providerId, authType, { prompt: async () => { throw new Error("Unexpected commit prompt."); }, notify: () => {} }); }
          finally { runtime.registerNativeProvider(provider); }
          try { await runtime.refresh({ allowNetwork: true, providers: [providerId], signal: AbortSignal.timeout(15_000) }); }
          catch { return { warning: "Credentials were saved; the inference catalog could not refresh." }; }
        },
      };
    },
  });
}

export async function authCommand(agentDir: string, args: string[]) {
  const [action = "list", provider, method = "oauth"] = args;
  const runtime = await createCliModelRuntime(agentDir);
  if (action === "list") return runtime.listCredentials();
  if (!provider) throw new Error("Usage: auth list | login <provider> [oauth|api_key] | logout <provider>");
  const coordinator = createCliAuthCoordinator(runtime, async (url) => { process.stderr.write(`${url}\n`); });
  if (action === "logout") { try { await coordinator.logout(provider); return { provider, signedOut: true }; } finally { await coordinator.shutdown(); } }
  if (action !== "login" || !["oauth", "api_key"].includes(method)) throw new Error("Expected login with oauth or api_key, or logout.");
  if (!process.stdin.isTTY) throw new Error("Interactive login needs a terminal. For headless jobs use provider environment keys or an existing auth.json.");
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stderr.write(chunk); callback(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController(), flowId = randomUUID();
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const request = { flowId, providerId: provider, authType: method as AuthType };
  const owner: ProviderAuthOwner = { id: 1, documentId: `cli-auth:${flowId}`, isDestroyed: () => false, onInvalidated: () => () => {},
    send(channel, value) {
      if (channel === "providers:auth:prompt") {
        const prompt = value as ProviderAuthPromptDto;
        void (async () => {
          if (prompt.options) process.stderr.write(prompt.options.map((option) => `${option.id}: ${option.label}`).join("\n") + "\n");
          process.stderr.write(`${prompt.message}: `); muted = prompt.type === "secret";
          try { const answer = await reader.question("", { signal: controller.signal }); coordinator.respond(owner, { ...request, promptId: prompt.promptId, value: answer.trim() }); }
          catch { coordinator.cancel(owner, request); }
          finally { if (muted) process.stderr.write("\n"); muted = false; }
        })().catch((error) => fail(error));
      } else if (channel === "providers:auth:event") {
        const event = value as ProviderAuthEventDto;
        if (event.type === "device_code") process.stderr.write(`Code: ${event.userCode}\n`);
        else if (event.type === "auth_url") { if (event.instructions) process.stderr.write(`${event.instructions}\n`); }
        else process.stderr.write(`${event.message}\n`);
      } else if (channel === "providers:auth:done") {
        const done = value as ProviderAuthDoneDto;
        controller.abort();
        finish({ provider, signedIn: !done.cancelled, ...(done.warning ? { warning: done.warning } : {}) });
      } else if (channel === "providers:auth:error") { controller.abort(); fail(new Error((value as ProviderAuthErrorDto).message)); }
    },
  };
  reader.on("SIGINT", () => { controller.abort(); coordinator.cancel(owner, request); });
  try { coordinator.start(owner, request); return await result; }
  finally { await coordinator.shutdown(); reader.close(); output.end(); }
}
