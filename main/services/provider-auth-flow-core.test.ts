import assert from "node:assert/strict";
import test from "node:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";

import {
  ProviderAuthFlowCoordinator,
  ProviderAuthRequestError,
  parseProviderAuthResponseRequest,
  parseProviderAuthStartRequest,
  type ProviderAuthBackend,
  type ProviderAuthErrorDto,
  type ProviderAuthEventDto,
  type ProviderAuthOwner,
  type ProviderAuthPromptDto,
} from "./provider-auth-flow-core.js";

const PROVIDER_ID = "openai-codex" as const;
const FLOW_A = "11111111-1111-4111-8111-111111111111";
const FLOW_B = "22222222-2222-4222-8222-222222222222";
const PROMPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROMPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface SentMessage {
  channel: string;
  payload: unknown;
}

class FakeOwner implements ProviderAuthOwner {
  readonly sent: SentMessage[] = [];
  private readonly invalidationListeners = new Set<() => void>();
  private destroyed = false;

  constructor(
    readonly id: number,
    readonly documentId = `document-${id}`,
  ) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error("owner destroyed");
    this.sent.push({ channel, payload });
  }

  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  invalidate(): void {
    for (const listener of [...this.invalidationListeners]) listener();
  }

  destroy(): void {
    this.destroyed = true;
    this.invalidate();
  }
}

function snapshot(configured = false) {
  return {
    id: PROVIDER_ID,
    name: "OpenAI Codex",
    authName: "OpenAI (ChatGPT Plus/Pro)",
    configured,
    needsAttention: false,
    models: [],
  };
}

function backend(login: (interaction: AuthInteraction) => Promise<unknown>): ProviderAuthBackend {
  let configured = false;
  return {
    snapshot: async () => snapshot(configured),
    authenticate: async (interaction) => login(interaction),
    commitCredential: async () => {
      configured = true;
    },
    logout: async () => {
      configured = false;
    },
  };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? PROMPT_A;
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  let reject = (_reason?: unknown): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeCoordinator(options: {
  login: (interaction: AuthInteraction) => Promise<unknown>;
  opened?: string[];
  timeout?: number;
  diagnostics?: unknown[];
  createId?: () => string;
  cleanupTimeout?: number;
}) {
  const opened = options.opened ?? [];
  const diagnostics = options.diagnostics ?? [];
  return new ProviderAuthFlowCoordinator({
    backend: backend(options.login),
    openExternal: async (url) => {
      opened.push(url);
    },
    diagnostic: (event) => diagnostics.push(event),
    flowTimeoutMs: options.timeout,
    authCleanupTimeoutMs: options.cleanupTimeout,
    createId: options.createId ?? ids(PROMPT_A, PROMPT_B),
  });
}

function request(flowId = FLOW_A) {
  return { flowId, providerId: PROVIDER_ID } as const;
}

function messages<T>(owner: FakeOwner, channel: string): T[] {
  return owner.sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload as T);
}

async function waitForMessages(owner: FakeOwner, channel: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (messages(owner, channel).length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${channel}`);
}

test("browser flow forwards only prompts/events and opens the validated auth URL", async () => {
  const opened: string[] = [];
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    opened,
    login: async (interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "Choose a login method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code" },
        ],
      });
      assert.equal(method, "browser");
      interaction.notify({
        type: "auth_url",
        url: "https://auth.openai.com/oauth/authorize?state=temporary",
        instructions: "Continue in your browser.",
      });
      const manual = await interaction.prompt({
        type: "manual_code",
        message: "Paste a callback URL",
        placeholder: "http://localhost:1455/auth/callback",
      });
      assert.equal(manual, "callback-code");
      return {};
    },
  });

  assert.deepEqual(coordinator.start(owner, request()), { started: true });
  await waitForMessages(owner, "providers:auth:prompt");
  const select = messages<ProviderAuthPromptDto>(owner, "providers:auth:prompt")[0];
  assert.equal(select.type, "select");
  assert.deepEqual(select.options, [
    {
      id: "option-1",
      label: "Browser login",
      description: "Complete sign-in in your default browser.",
    },
    {
      id: "option-2",
      label: "Device code",
      description: "Use a short code on OpenAI's verification page.",
    },
  ]);
  coordinator.respond(owner, {
    ...request(),
    promptId: select.promptId,
    value: select.options![0].id,
  });

  await waitForMessages(owner, "providers:auth:event");
  const authEvent = messages<ProviderAuthEventDto>(owner, "providers:auth:event")[0];
  assert.equal(authEvent.type, "auth_url");
  assert.deepEqual(opened, ["https://auth.openai.com/oauth/authorize?state=temporary"]);

  await waitForMessages(owner, "providers:auth:prompt", 2);
  const manual = messages<ProviderAuthPromptDto>(owner, "providers:auth:prompt")[1];
  assert.equal(manual.type, "manual_code");
  coordinator.respond(owner, { ...request(), promptId: manual.promptId, value: "callback-code" });

  await waitForMessages(owner, "providers:auth:done");
  assert.deepEqual(messages(owner, "providers:auth:done"), [
    { flowId: FLOW_A, providerId: PROVIDER_ID, cancelled: false },
  ]);
  assert.equal(messages(owner, "providers:auth:error").length, 0);
});

test("device-code flow forwards the temporary code and opens its HTTPS verification page", async () => {
  const opened: string[] = [];
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    opened,
    login: async (interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      });
      return {};
    },
  });

  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:done");
  assert.deepEqual(messages<ProviderAuthEventDto>(owner, "providers:auth:event"), [
    {
      flowId: FLOW_A,
      providerId: PROVIDER_ID,
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    },
  ]);
  assert.deepEqual(opened, ["https://auth.openai.com/codex/device"]);
});

test("non-HTTPS authorization URLs are blocked before opening or crossing IPC", async () => {
  const opened: string[] = [];
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    opened,
    login: async (interaction) => {
      interaction.notify({ type: "auth_url", url: "http://evil.example/steal" });
      return {};
    },
  });

  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:error");
  assert.deepEqual(opened, []);
  assert.equal(messages(owner, "providers:auth:event").length, 0);
  assert.equal(
    messages<ProviderAuthErrorDto>(owner, "providers:auth:error")[0].code,
    "sign_in_failed",
  );
});

test("a different renderer cannot answer or cancel an owned flow", async () => {
  const owner = new FakeOwner(1);
  const attacker = new FakeOwner(2);
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      await interaction.prompt({ type: "text", message: "Continue" });
      return {};
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:prompt");
  const prompt = messages<ProviderAuthPromptDto>(owner, "providers:auth:prompt")[0];

  assert.throws(
    () => coordinator.respond(attacker, { ...request(), promptId: prompt.promptId, value: "x" }),
    ProviderAuthRequestError,
  );
  assert.throws(() => coordinator.cancel(attacker, request()), ProviderAuthRequestError);
  assert.equal(attacker.sent.length, 0);

  coordinator.cancel(owner, request());
  await waitForMessages(owner, "providers:auth:done");
});

test("a replacement document in the same WebContents cannot control the old flow", async () => {
  const original = new FakeOwner(1, "document-old");
  const replacement = new FakeOwner(1, "document-new");
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      await interaction.prompt({ type: "text", message: "Continue" });
      return {};
    },
  });
  coordinator.start(original, request());
  await waitForMessages(original, "providers:auth:prompt");
  const prompt = messages<ProviderAuthPromptDto>(original, "providers:auth:prompt")[0];

  assert.throws(
    () =>
      coordinator.respond(replacement, {
        ...request(),
        promptId: prompt.promptId,
        value: "x",
      }),
    /not owned by this window/u,
  );
  assert.throws(() => coordinator.cancel(replacement, request()), /not owned by this window/u);
  assert.equal(replacement.sent.length, 0);

  original.invalidate();
});

test("select prompts accept only an advertised option ID", async () => {
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      await interaction.prompt({
        type: "select",
        message: "Choose",
        options: [{ id: "browser", label: "Browser" }],
      });
      return {};
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:prompt");
  const prompt = messages<ProviderAuthPromptDto>(owner, "providers:auth:prompt")[0];

  assert.throws(
    () => coordinator.respond(owner, { ...request(), promptId: prompt.promptId, value: "bogus" }),
    /available sign-in options/u,
  );
  coordinator.cancel(owner, request());
  await waitForMessages(owner, "providers:auth:done");
});

test("explicit cancellation produces a cancelled terminal event, not an error", async () => {
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      await interaction.prompt({ type: "secret", message: "Wait" });
      return {};
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:prompt");
  assert.deepEqual(coordinator.cancel(owner, request()), { cancelled: true });
  await waitForMessages(owner, "providers:auth:done");

  assert.deepEqual(messages(owner, "providers:auth:done"), [
    { flowId: FLOW_A, providerId: PROVIDER_ID, cancelled: true },
  ]);
  assert.equal(messages(owner, "providers:auth:error").length, 0);
});

test("destroying the owner cancels silently and releases the global flow slot", async () => {
  const first = new FakeOwner(1);
  const second = new FakeOwner(2);
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      await interaction.prompt({ type: "text", message: "Wait" });
      return {};
    },
  });
  coordinator.start(first, request());
  await waitForMessages(first, "providers:auth:prompt");
  first.destroy();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      coordinator.start(second, request(FLOW_B));
      break;
    } catch (error) {
      if (!(error instanceof ProviderAuthRequestError) || attempt === 99) throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assert.equal(messages(first, "providers:auth:done").length, 0);
  coordinator.cancel(second, request(FLOW_B));
  await waitForMessages(second, "providers:auth:done");
});

test("renderer document/process invalidation cancels a flow even when WebContents survives", async () => {
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      await interaction.prompt({ type: "text", message: "Wait" });
      return {};
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:prompt");
  owner.invalidate();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      coordinator.start(owner, request(FLOW_B));
      break;
    } catch (error) {
      if (!(error instanceof ProviderAuthRequestError) || attempt === 99) throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assert.equal(messages(owner, "providers:auth:done").length, 0);
  coordinator.cancel(owner, request(FLOW_B));
  await waitForMessages(owner, "providers:auth:done");
});

test("the overall timeout aborts the flow and reports a safe retryable error", async () => {
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    timeout: 10,
    login: async (interaction) => {
      await interaction.prompt({ type: "text", message: "Wait" });
      return {};
    },
  });
  coordinator.start(owner, request());
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  await waitForMessages(owner, "providers:auth:error");

  assert.deepEqual(messages<ProviderAuthErrorDto>(owner, "providers:auth:error"), [
    {
      flowId: FLOW_A,
      providerId: PROVIDER_ID,
      code: "timed_out",
      message: "ChatGPT sign-in timed out. Start a new sign-in attempt to try again.",
    },
  ]);
  assert.equal(messages(owner, "providers:auth:done").length, 0);
});

test("timeout is terminal but cleanup gets a bounded chance before the slot is released", async () => {
  let authenticationCalls = 0;
  let commits = 0;
  let configured = false;
  const never = new Promise<unknown>(() => undefined);
  const customBackend: ProviderAuthBackend = {
    snapshot: async () => snapshot(configured),
    authenticate: async () => {
      authenticationCalls += 1;
      return authenticationCalls === 1 ? never : {};
    },
    commitCredential: async () => {
      commits += 1;
      configured = true;
    },
    logout: async () => {
      configured = false;
    },
  };
  const coordinator = new ProviderAuthFlowCoordinator({
    backend: customBackend,
    openExternal: async () => undefined,
    flowTimeoutMs: 10,
    authCleanupTimeoutMs: 20,
    createId: ids(PROMPT_A, PROMPT_B),
  });
  const first = new FakeOwner(1);
  coordinator.start(first, request());
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const second = new FakeOwner(2);
  assert.throws(
    () => coordinator.start(second, request(FLOW_B)),
    /Another ChatGPT sign-in is already in progress/u,
  );
  assert.equal(messages(first, "providers:auth:error").length, 0);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await waitForMessages(first, "providers:auth:error");
  coordinator.start(second, request(FLOW_B));
  await waitForMessages(second, "providers:auth:done");
  assert.equal(commits, 1);
  assert.equal(configured, true);
});

test("cancelled authentication cannot commit a late credential", async () => {
  const firstAuthentication = deferred<unknown>();
  let authenticationCalls = 0;
  let commits = 0;
  const customBackend: ProviderAuthBackend = {
    snapshot: async () => snapshot(commits > 0),
    authenticate: async () => {
      authenticationCalls += 1;
      return authenticationCalls === 1 ? firstAuthentication.promise : {};
    },
    commitCredential: async () => {
      commits += 1;
    },
    logout: async () => undefined,
  };
  const coordinator = new ProviderAuthFlowCoordinator({
    backend: customBackend,
    openExternal: async () => undefined,
    createId: ids(PROMPT_A, PROMPT_B),
  });
  const first = new FakeOwner(1);
  coordinator.start(first, request());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.cancel(first, request()), { cancelled: true });
  assert.equal(messages(first, "providers:auth:done").length, 0);
  assert.equal(commits, 0);

  const second = new FakeOwner(2);
  assert.throws(
    () => coordinator.start(second, request(FLOW_B)),
    /Another ChatGPT sign-in is already in progress/u,
  );

  firstAuthentication.resolve({ late: true });
  await waitForMessages(first, "providers:auth:done");
  assert.equal(commits, 0);

  coordinator.start(second, request(FLOW_B));
  await waitForMessages(second, "providers:auth:done");
  assert.equal(commits, 1);
});

test("late provider callbacks unwind through cleanup before the session is released", async () => {
  const continueAuthentication = deferred<void>();
  let cleanupCalls = 0;
  const opened: string[] = [];
  const coordinator = makeCoordinator({
    opened,
    login: async (interaction) => {
      await continueAuthentication.promise;
      // Pi's browser flow starts its callback server before this notification,
      // then installs its cleanup finally immediately afterward.
      interaction.notify({
        type: "auth_url",
        url: "https://auth.openai.com/oauth/authorize?state=late",
      });
      try {
        await interaction.prompt({ type: "manual_code", message: "Paste redirect URL" });
      } finally {
        cleanupCalls += 1;
      }
      return {};
    },
  });
  const owner = new FakeOwner(1);
  coordinator.start(owner, request());
  await new Promise<void>((resolve) => setImmediate(resolve));
  coordinator.cancel(owner, request());
  assert.equal(messages(owner, "providers:auth:done").length, 0);
  assert.throws(
    () => coordinator.start(new FakeOwner(2), request(FLOW_B)),
    /Another ChatGPT sign-in is already in progress/u,
  );

  continueAuthentication.resolve();
  for (let attempt = 0; attempt < 100 && cleanupCalls === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(cleanupCalls, 1);
  await waitForMessages(owner, "providers:auth:done");
  assert.deepEqual(opened, []);
  assert.equal(messages(owner, "providers:auth:event").length, 0);
});

test("credential commit is a point of no return and cannot emit a false cancellation", async () => {
  const commitStarted = deferred<void>();
  const finishCommit = deferred<void>();
  let configured = false;
  const customBackend: ProviderAuthBackend = {
    snapshot: async () => snapshot(configured),
    authenticate: async () => ({ token: "main-process-only" }),
    commitCredential: async () => {
      commitStarted.resolve();
      await finishCommit.promise;
      configured = true;
    },
    logout: async () => {
      configured = false;
    },
  };
  const coordinator = new ProviderAuthFlowCoordinator({
    backend: customBackend,
    openExternal: async () => undefined,
    flowTimeoutMs: 10,
    createId: ids(PROMPT_A),
  });
  const owner = new FakeOwner(1);
  coordinator.start(owner, request());
  await commitStarted.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(coordinator.cancel(owner, request()), {
    cancelled: false,
    reason: "finishing",
  });
  finishCommit.resolve();
  await waitForMessages(owner, "providers:auth:done");
  assert.deepEqual(messages(owner, "providers:auth:done"), [
    { flowId: FLOW_A, providerId: PROVIDER_ID, cancelled: false },
  ]);
  assert.equal(messages(owner, "providers:auth:error").length, 0);
  assert.equal((await coordinator.status(PROVIDER_ID)).configured, true);
});

test("per-prompt abort clears the prompt without cancelling a successful flow", async () => {
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      const promptAbort = new AbortController();
      const pending = interaction.prompt({
        type: "manual_code",
        message: "Paste a callback URL",
        signal: promptAbort.signal,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      promptAbort.abort();
      await assert.rejects(pending, { name: "AbortError" });
      return {};
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:done");

  assert.deepEqual(messages(owner, "providers:auth:done"), [
    { flowId: FLOW_A, providerId: PROVIDER_ID, cancelled: false },
  ]);
});

test("only one Codex login flow may run at once", async () => {
  const owner = new FakeOwner(1);
  const other = new FakeOwner(2);
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      await interaction.prompt({ type: "text", message: "Wait" });
      return {};
    },
  });
  coordinator.start(owner, request());
  assert.throws(
    () => coordinator.start(other, request(FLOW_B)),
    /Another ChatGPT sign-in is already in progress/u,
  );
  coordinator.cancel(owner, request());
  await waitForMessages(owner, "providers:auth:done");
});

test("status and logout expose only the provider snapshot", async () => {
  const coordinator = makeCoordinator({ login: async () => ({}) });
  assert.equal((await coordinator.status(PROVIDER_ID)).configured, false);

  const owner = new FakeOwner(1);
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:done");
  assert.equal((await coordinator.status(PROVIDER_ID)).configured, true);
  assert.equal((await coordinator.logout(PROVIDER_ID)).configured, false);
});

test("raw provider errors and token-like text never cross IPC or diagnostics", async () => {
  const owner = new FakeOwner(1);
  const diagnostics: unknown[] = [];
  const sentinel = "eyJhbGciOiJub25lIn0.super-secret-token.signature";
  const coordinator = makeCoordinator({
    diagnostics,
    login: async () => {
      throw new Error(`token exchange rejected access_token=${sentinel}`);
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:error");

  assert.equal(JSON.stringify(owner.sent).includes(sentinel), false);
  assert.equal(JSON.stringify(diagnostics).includes(sentinel), false);
  assert.deepEqual(diagnostics, [
    {
      operation: "login",
      providerId: PROVIDER_ID,
      errorName: "Error",
      errorCode: undefined,
    },
  ]);
});

test("provider display text and option IDs are replaced with structured app-owned copy", async () => {
  const owner = new FakeOwner(1);
  const sentinel = "eyJhbGciOiJub25lIn0.super-secret-token.signature";
  const coordinator = makeCoordinator({
    login: async (interaction) => {
      interaction.notify({
        type: "info",
        message: `Bearer ${sentinel}`,
        links: [
          {
            url: `https://auth.openai.com/help?client_secret=${sentinel}`,
            label: `api_key=${sentinel}`,
          },
        ],
      });
      await interaction.prompt({
        type: "select",
        message: `token=${sentinel}`,
        options: [
          {
            id: `client_secret=${sentinel}`,
            label: "sk-provider-secret-value",
            description: `Bearer abc+/def== ${sentinel}`,
          },
        ],
      });
      return {};
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:prompt");

  assert.equal(JSON.stringify(owner.sent).includes(sentinel), false);
  assert.equal(JSON.stringify(owner.sent).includes("sk-provider-secret-value"), false);
  assert.deepEqual(messages<ProviderAuthEventDto>(owner, "providers:auth:event"), [
    {
      flowId: FLOW_A,
      providerId: PROVIDER_ID,
      type: "info",
      message: "OpenAI provided an update during sign-in.",
    },
  ]);
  assert.deepEqual(messages<ProviderAuthPromptDto>(owner, "providers:auth:prompt")[0].options, [
    { id: "option-1", label: "Sign-in option 1" },
  ]);
  coordinator.cancel(owner, request());
  await waitForMessages(owner, "providers:auth:done");
});

test("known provider failures map to actionable, sanitized error codes", async (t) => {
  const cases = [
    [
      Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:1455"), {
        code: "EADDRINUSE",
      }),
      "port_busy",
    ],
    [new Error("HTTP 429: rate limit exceeded"), "rate_limited"],
    [new Error("State mismatch: sentinel-secret"), "verification_failed"],
  ] as const;

  for (const [failure, expectedCode] of cases) {
    await t.test(expectedCode, async () => {
      const owner = new FakeOwner(1);
      const coordinator = makeCoordinator({
        login: async () => {
          throw failure;
        },
      });
      coordinator.start(owner, request());
      await waitForMessages(owner, "providers:auth:error");
      assert.equal(
        messages<ProviderAuthErrorDto>(owner, "providers:auth:error")[0].code,
        expectedCode,
      );
      assert.equal(JSON.stringify(owner.sent).includes("sentinel-secret"), false);
    });
  }
});

test("Pi device-code expiry is classified as a timeout with retry guidance", async () => {
  const owner = new FakeOwner(1);
  const coordinator = makeCoordinator({
    login: async () => {
      throw new Error("Device flow timed out");
    },
  });
  coordinator.start(owner, request());
  await waitForMessages(owner, "providers:auth:error");
  assert.deepEqual(messages<ProviderAuthErrorDto>(owner, "providers:auth:error"), [
    {
      flowId: FLOW_A,
      providerId: PROVIDER_ID,
      code: "timed_out",
      message: "ChatGPT sign-in expired. Start a new sign-in attempt to try again.",
    },
  ]);
});

test("login cannot start while logout is mutating credentials", async () => {
  const finishLogout = deferred<void>();
  const customBackend: ProviderAuthBackend = {
    snapshot: async () => snapshot(false),
    authenticate: async () => ({}),
    commitCredential: async () => undefined,
    logout: async () => finishLogout.promise,
  };
  const coordinator = new ProviderAuthFlowCoordinator({
    backend: customBackend,
    openExternal: async () => undefined,
  });
  const logout = coordinator.logout(PROVIDER_ID);
  assert.throws(
    () => coordinator.start(new FakeOwner(1), request()),
    /sign-out is still in progress/u,
  );
  finishLogout.resolve();
  await logout;
});

test("shutdown waits for an in-flight credential commit before resolving", async () => {
  const commitStarted = deferred<void>();
  const finishCommit = deferred<void>();
  let committed = false;
  const customBackend: ProviderAuthBackend = {
    snapshot: async () => snapshot(committed),
    authenticate: async () => ({ token: "main-process-only" }),
    commitCredential: async () => {
      commitStarted.resolve();
      await finishCommit.promise;
      committed = true;
    },
    logout: async () => undefined,
  };
  const coordinator = new ProviderAuthFlowCoordinator({
    backend: customBackend,
    openExternal: async () => undefined,
  });
  const owner = new FakeOwner(1);
  coordinator.start(owner, request());
  await commitStarted.promise;

  let shutdownResolved = false;
  const shutdown = coordinator.shutdown().then(() => {
    shutdownResolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);
  assert.throws(() => coordinator.start(owner, request(FLOW_B)), /shutting down/u);

  finishCommit.resolve();
  await shutdown;
  assert.equal(committed, true);
  assert.equal(messages(owner, "providers:auth:done").length, 0);
});

test("shutdown waits for an aborted authentication backend to finish cleanup", async () => {
  const authenticationStarted = deferred<void>();
  const finishAuthentication = deferred<unknown>();
  let commits = 0;
  const customBackend: ProviderAuthBackend = {
    snapshot: async () => snapshot(false),
    authenticate: async () => {
      authenticationStarted.resolve();
      return finishAuthentication.promise;
    },
    commitCredential: async () => {
      commits += 1;
    },
    logout: async () => undefined,
  };
  const coordinator = new ProviderAuthFlowCoordinator({
    backend: customBackend,
    openExternal: async () => undefined,
    authCleanupTimeoutMs: 1_000,
  });
  const owner = new FakeOwner(1);
  coordinator.start(owner, request());
  await authenticationStarted.promise;

  let shutdownResolved = false;
  const shutdown = coordinator.shutdown().then(() => {
    shutdownResolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);

  finishAuthentication.resolve({ late: true });
  await shutdown;
  assert.equal(shutdownResolved, true);
  assert.equal(commits, 0);
  assert.equal(messages(owner, "providers:auth:done").length, 0);
});

test("shutdown waits for an in-flight logout before resolving", async () => {
  const logoutStarted = deferred<void>();
  const finishLogout = deferred<void>();
  const customBackend: ProviderAuthBackend = {
    snapshot: async () => snapshot(false),
    authenticate: async () => ({}),
    commitCredential: async () => undefined,
    logout: async () => {
      logoutStarted.resolve();
      await finishLogout.promise;
    },
  };
  const coordinator = new ProviderAuthFlowCoordinator({
    backend: customBackend,
    openExternal: async () => undefined,
  });
  const logout = coordinator.logout(PROVIDER_ID);
  await logoutStarted.promise;

  let shutdownResolved = false;
  const shutdown = coordinator.shutdown().then(() => {
    shutdownResolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);

  finishLogout.resolve();
  await Promise.all([logout, shutdown]);
  assert.equal(shutdownResolved, true);
});

test("IPC request parsers reject malformed IDs, excess fields, and oversized input", () => {
  assert.throws(
    () => parseProviderAuthStartRequest({ flowId: "guessable", providerId: PROVIDER_ID }),
    /flow ID is invalid/u,
  );
  assert.throws(
    () => parseProviderAuthStartRequest({ ...request(), extra: true }),
    /invalid shape/u,
  );
  assert.throws(
    () =>
      parseProviderAuthResponseRequest({
        ...request(),
        promptId: PROMPT_A,
        value: "x".repeat(8_193),
      }),
    /response is invalid/u,
  );
});
