import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type CredentialStore,
  type Model,
  type Models,
  type OAuthAuth,
  type OAuthCredential,
  type ProviderStreams,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CodexProviderService, CodexRuntimeError } from "./codex-provider.js";

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined;
  let reject = (_reason?: unknown): void => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function completedStream(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  responseStatus: number,
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: responseStatus === 200 ? "ok" : "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: responseStatus === 200 ? "stop" : "error",
    errorMessage: responseStatus === 200 ? undefined : "Unauthorized",
    timestamp: Date.now(),
  };
  void (async () => {
    await options?.onResponse?.({ status: responseStatus, headers: {} }, model);
    if (responseStatus === 200) {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    } else {
      stream.push({ type: "error", reason: "error", error: message });
    }
    stream.end(message);
  })();
  return stream;
}

function codexProviderWith(
  models: Models,
  options: {
    streamSimple?: ProviderStreams["streamSimple"];
    refresh?: OAuthAuth["refresh"];
    toAuth?: OAuthAuth["toAuth"];
  },
) {
  const provider = models.getProvider("openai-codex");
  if (!provider?.auth.oauth) throw new Error("Codex test provider is unavailable.");
  const oauth = provider.auth.oauth;
  return () => ({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        refresh: options.refresh ?? oauth.refresh,
        toAuth: options.toAuth ?? oauth.toAuth,
      },
    },
    streamSimple: options.streamSimple ?? provider.streamSimple,
  });
}

function oauthCredential(
  access = "current-access",
  expires = Date.now() + 5 * 60_000,
): OAuthCredential {
  return {
    type: "oauth",
    access,
    refresh: `${access}-refresh`,
    expires,
  };
}

function codexAccessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

function terminalStream(
  model: Model<Api>,
  stopReason: Exclude<AssistantMessage["stopReason"], "pending">,
  errorMessage?: string,
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "ok" }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    if (stopReason === "error" || stopReason === "aborted") {
      stream.push({ type: "error", reason: stopReason, error: message });
    } else {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: stopReason, message });
    }
    stream.end(message);
  });
  return stream;
}

test("reports stored OAuth as configured without claiming live connectivity", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: "expired-access",
    refresh: "expired-refresh",
    expires: 0,
  }));
  const service = new CodexProviderService(builtinModels({ credentials }), credentials);

  const snapshot = await service.snapshot();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.needsAttention, false);
  assert.equal("signedIn" in snapshot, false);
  assert.ok(snapshot.models.length > 0);
  assert.deepEqual(snapshot.models.find((model) => model.id === "gpt-5.4")?.thinkingLevels, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(snapshot.models.find((model) => model.id === "gpt-5.6-sol")?.thinkingLevels, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("uses an injected Models collection instead of constructing a private registry", () => {
  const credentials = new InMemoryCredentialStore();
  const models = builtinModels({ credentials });
  const service = new CodexProviderService(models, credentials);
  assert.equal(service.getModel("gpt-5.4"), models.getModel("openai-codex", "gpt-5.4"));
});

test("validates Codex thinking choices against the exact selected model", () => {
  const credentials = new InMemoryCredentialStore();
  const service = new CodexProviderService(builtinModels({ credentials }), credentials);
  assert.deepEqual(service.parseThinkingSelection("gpt-5.4", "xhigh"), {
    modelId: "gpt-5.4",
    level: "xhigh",
  });
  assert.deepEqual(service.parseThinkingSelection("gpt-5.6-sol", "max"), {
    modelId: "gpt-5.6-sol",
    level: "max",
  });
  assert.throws(() => service.parseThinkingSelection("gpt-5.4", "max"), /not supported/u);
  assert.throws(() => service.parseThinkingSelection("gpt-5.4", "minimal"), /not supported/u);
  assert.throws(
    () => service.parseThinkingSelection("unknown", "high"),
    /does not support thinking/u,
  );
});

test("stages OAuth credentials until the owning flow explicitly commits", async () => {
  const credentials = new InMemoryCredentialStore();
  const credential: OAuthCredential = {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: Date.now() + 60_000,
  };
  const models = {
    getProvider: () => ({
      auth: { oauth: { login: async () => credential } },
    }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  const staged = await service.authenticate({
    prompt: async () => "unused",
    notify: () => undefined,
  });
  assert.equal(await credentials.read("openai-codex"), undefined);

  await service.commitCredential(staged);
  assert.deepEqual(await credentials.read("openai-codex"), credential);
});

test("notifies every renderer after healthy login and logout configuration changes", async () => {
  const credentials = new InMemoryCredentialStore();
  let cleanups = 0;
  const service = new CodexProviderService(builtinModels({ credentials }), credentials, () => {
    cleanups += 1;
  });
  const changes: boolean[] = [];
  service.onStatusChange((needsAttention) => changes.push(needsAttention));

  await service.commitCredential({
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: Date.now() + 60_000,
  });
  await service.logout();

  assert.deepEqual(changes, [false, false]);
  assert.equal(cleanups, 2);
});

test("preflights request auth, preserves failed credentials, and exposes only safe repair copy", async () => {
  const credentials = new InMemoryCredentialStore();
  const credential: OAuthCredential = {
    type: "oauth",
    access: "access-secret-that-must-not-escape",
    refresh: "refresh-secret-that-must-not-escape",
    expires: 0,
  };
  await credentials.modify("openai-codex", async () => credential);
  const builtin = builtinModels({ credentials });
  let authFails = true;
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        if (authFails) throw new Error(`invalid_grant: ${credential.refresh}`);
        return oauthCredential("refreshed-access");
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  await assert.rejects(service.prepareRuntimeModel("gpt-5.4"), (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "sign_in_needs_attention");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.deepEqual(await credentials.read("openai-codex"), credential);
  assert.equal((await service.snapshot()).needsAttention, true);

  authFails = false;
  assert.equal((await service.prepareRuntimeModel("gpt-5.4")).id, "gpt-5.4");
  assert.equal((await service.snapshot()).needsAttention, false);
});

test("keeps transient refresh failures recoverable without hiding Codex", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  let refreshCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) throw new Error("OpenAI Codex token refresh error: offline");
        return oauthCredential("recovered-access");
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  await assert.rejects(service.prepareRuntimeModel("gpt-5.4"), (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "temporarily_unavailable");
    return true;
  });
  assert.equal((await service.snapshot()).needsAttention, false);

  assert.equal((await service.prepareRuntimeModel("gpt-5.4")).id, "gpt-5.4");
  assert.equal((await service.snapshot()).needsAttention, false);
  assert.equal(refreshCalls, 2);
});

test("refreshes within the expiry safety window before request setup", async (t) => {
  const credentials = new InMemoryCredentialStore();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  await credentials.modify("openai-codex", async () =>
    oauthCredential("almost-expired-access", now + 30_000),
  );
  const builtin = builtinModels({ credentials });
  const refreshed = oauthCredential("preemptively-refreshed", now + 5 * 60_000);
  let refreshCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshCalls += 1;
        return refreshed;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  assert.equal((await service.prepareRuntimeModel("gpt-5.4")).id, "gpt-5.4");
  assert.equal(refreshCalls, 1);
  assert.deepEqual(await credentials.read("openai-codex"), refreshed);
});

test("concurrent refresh waiters survive the shared generation abort", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  const pendingRefresh = deferred<OAuthCredential>();
  const refreshStarted = deferred<void>();
  const rotated = oauthCredential("rotated-access");
  let refreshCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshCalls += 1;
        refreshStarted.resolve();
        return pendingRefresh.promise;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  const first = service.prepareRuntimeModel("gpt-5.4");
  const second = service.prepareRuntimeModel("gpt-5.4");
  await refreshStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 1);

  pendingRefresh.resolve(rotated);
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((model) => model.id),
    ["gpt-5.4", "gpt-5.4"],
  );
  assert.deepEqual(await credentials.read("openai-codex"), rotated);
  assert.equal(refreshCalls, 1);
});

test("an already-cancelled auth wait still observes a later credential-read rejection", async () => {
  const pendingRead = deferred<OAuthCredential | undefined>();
  const credentials: CredentialStore = {
    read: () => pendingRead.promise,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => undefined,
  };
  const service = new CodexProviderService(builtinModels({ credentials }), credentials);
  const controller = new AbortController();
  controller.abort(new Error("request already cancelled"));

  await assert.rejects(
    service.prepareRuntimeModel("gpt-5.4", controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof CodexRuntimeError);
      assert.equal(error.code, "request_cancelled");
      return true;
    },
  );

  pendingRead.reject(new Error("credential read failed after cancellation"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("classifies Pi's bodyless refresh status errors as requiring sign-in", async () => {
  for (const status of [400, 403]) {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
    const builtin = builtinModels({ credentials });
    const models = {
      getProvider: codexProviderWith(builtin, {
        refresh: async () => {
          throw new Error(`OpenAI Codex token refresh failed (${status}): Forbidden`);
        },
      }),
      getModels: builtin.getModels.bind(builtin),
      getModel: builtin.getModel.bind(builtin),
      checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
    } as unknown as Models;
    const service = new CodexProviderService(models, credentials);

    await assert.rejects(service.prepareRuntimeModel("gpt-5.4"), (error: unknown) => {
      assert.ok(error instanceof CodexRuntimeError);
      assert.equal(error.code, "sign_in_needs_attention");
      return true;
    });
    assert.equal((await service.snapshot()).needsAttention, true);
  }
});

test("a definitive refresh rejection updates health after its caller times out", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  const pendingRefresh = deferred<OAuthCredential>();
  const refreshStarted = deferred<void>();
  const attentionChanged = deferred<void>();
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshStarted.resolve();
        return pendingRefresh.promise;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials, () => undefined, 10);
  service.onStatusChange((needsAttention) => {
    if (needsAttention) attentionChanged.resolve();
  });
  const preflight = service.prepareRuntimeModel("gpt-5.4");
  await refreshStarted.promise;

  await assert.rejects(preflight, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "temporarily_unavailable");
    return true;
  });
  assert.equal((await service.snapshot()).needsAttention, false);

  pendingRefresh.reject(new Error("invalid_grant"));
  await attentionChanged.promise;
  assert.equal((await service.snapshot()).needsAttention, true);
});

test("a terminal operation deadline releases a hung refresh so a later retry can recover", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  const firstRefresh = deferred<OAuthCredential>();
  const firstRefreshStarted = deferred<void>();
  const recovered = oauthCredential("recovered-access");
  let refreshCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          firstRefreshStarted.resolve();
          return firstRefresh.promise;
        }
        return recovered;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials, () => undefined, 5, 15);

  const firstAttempt = service.prepareRuntimeModel("gpt-5.4");
  await firstRefreshStarted.promise;
  await assert.rejects(firstAttempt, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "temporarily_unavailable");
    return true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await service.prepareRuntimeModel("gpt-5.4")).id, "gpt-5.4");
  assert.equal(refreshCalls, 2);
  assert.deepEqual(await credentials.read("openai-codex"), recovered);

  firstRefresh.resolve(oauthCredential("late-stale-access"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await credentials.read("openai-codex"), recovered);
});

test("the operation deadline releases a stalled credential write for a new refresh", async () => {
  let current: OAuthCredential | undefined = oauthCredential("expired-access", 0);
  let modifyCalls = 0;
  let modifyQueue = Promise.resolve();
  const firstWriteEntered = deferred<void>();
  const releaseFirstWrite = deferred<void>();
  const firstWriteCommitted = deferred<void>();
  const credentials: CredentialStore = {
    read: async () => current,
    list: async () => (current ? [{ providerId: "openai-codex", type: "oauth" as const }] : []),
    modify: async (_providerId, modifier) => {
      const operation = modifyQueue.then(async () => {
        modifyCalls += 1;
        const invocation = modifyCalls;
        const next = await modifier(current);
        if (invocation === 1) {
          firstWriteEntered.resolve();
          await releaseFirstWrite.promise;
        }
        if (next !== undefined) current = next as OAuthCredential;
        if (invocation === 1) firstWriteCommitted.resolve();
        return current;
      });
      modifyQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    delete: async () => {
      current = undefined;
    },
  };
  const builtin = builtinModels({ credentials });
  const firstRotation = oauthCredential("first-rotated-access");
  const secondRotation = oauthCredential("second-rotated-access");
  const secondRefreshStarted = deferred<void>();
  let refreshCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshCalls += 1;
        if (refreshCalls === 2) secondRefreshStarted.resolve();
        return refreshCalls === 1 ? firstRotation : secondRotation;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials, () => undefined, 5, 15);

  const firstAttempt = service.prepareRuntimeModel("gpt-5.4");
  await firstWriteEntered.promise;
  await assert.rejects(firstAttempt, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "temporarily_unavailable");
    return true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const secondAttempt = service.prepareRuntimeModel("gpt-5.4");
  await secondRefreshStarted.promise;
  await assert.rejects(secondAttempt, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "temporarily_unavailable");
    return true;
  });
  assert.equal(refreshCalls, 2);

  releaseFirstWrite.resolve();
  await firstWriteCommitted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await credentials.read("openai-codex"), firstRotation);
  assert.equal((await service.prepareRuntimeModel("gpt-5.4")).id, "gpt-5.4");
  assert.equal(refreshCalls, 2);
});

test("a valid late rotation repairs a retry that rejected the consumed old token", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  const firstRefresh = deferred<OAuthCredential>();
  const firstRefreshStarted = deferred<void>();
  const recoveredHealth = deferred<void>();
  const lateRotation = oauthCredential("late-rotated-access");
  let refreshCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          firstRefreshStarted.resolve();
          return firstRefresh.promise;
        }
        throw new Error("invalid_grant");
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials, () => undefined, 5, 15);
  let observedFailure = false;
  service.onStatusChange((needsAttention) => {
    if (needsAttention) observedFailure = true;
    else if (observedFailure) recoveredHealth.resolve();
  });

  const firstAttempt = service.prepareRuntimeModel("gpt-5.4");
  await firstRefreshStarted.promise;
  await assert.rejects(firstAttempt, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "temporarily_unavailable");
    return true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(service.prepareRuntimeModel("gpt-5.4"), (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "sign_in_needs_attention");
    return true;
  });
  assert.equal((await service.snapshot()).needsAttention, true);

  firstRefresh.resolve(lateRotation);
  await recoveredHealth.promise;
  assert.deepEqual(await credentials.read("openai-codex"), lateRotation);
  assert.equal((await service.snapshot()).needsAttention, false);
  assert.equal((await service.prepareRuntimeModel("gpt-5.4")).id, "gpt-5.4");
  assert.equal(refreshCalls, 2);
});

test("logout invalidates an auth preflight before the old token can dispatch", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("old-access"));
  const builtin = builtinModels({ credentials });
  const pendingAuth = deferred<{ apiKey: string }>();
  const authStarted = deferred<void>();
  let dispatches = 0;
  const streamSimple: ProviderStreams["streamSimple"] = (model) => {
    dispatches += 1;
    return terminalStream(model, "stop");
  };
  const models = {
    getProvider: codexProviderWith(builtin, {
      streamSimple,
      toAuth: async () => {
        authStarted.resolve();
        return pendingAuth.promise;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: builtin.checkAuth.bind(builtin),
    logout: builtin.logout.bind(builtin),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const model = service.getModel("gpt-5.4");
  assert.ok(model);

  const result = service.streamSimple(model, { messages: [] }).result();
  await authStarted.promise;
  await service.logout();
  pendingAuth.resolve({ apiKey: "old-access" });

  const terminal = await result;
  assert.equal(terminal.stopReason, "error");
  assert.match(terminal.errorMessage ?? "", /sign in with ChatGPT/iu);
  assert.equal(dispatches, 0);
});

test("account switch during async request setup dispatches only the replacement token", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("old-access"));
  const builtin = builtinModels({ credentials });
  const firstTransformStarted = deferred<void>();
  const releaseFirstTransform = deferred<void>();
  const dispatchedKeys: Array<string | undefined> = [];
  let transformCalls = 0;
  const streamSimple: ProviderStreams["streamSimple"] = (model, _context, options) => {
    dispatchedKeys.push(options?.apiKey);
    return terminalStream(model, "stop");
  };
  const models = {
    getProvider: codexProviderWith(builtin, { streamSimple }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const model = service.getModel("gpt-5.4");
  assert.ok(model);

  const result = service
    .streamSimple(
      model,
      { messages: [] },
      {
        transformHeaders: async (headers) => {
          transformCalls += 1;
          if (transformCalls === 1) {
            firstTransformStarted.resolve();
            await releaseFirstTransform.promise;
          }
          return headers;
        },
      },
    )
    .result();
  await firstTransformStarted.promise;
  await service.commitCredential(oauthCredential("replacement-access"));
  releaseFirstTransform.resolve();

  assert.equal((await result).stopReason, "stop");
  assert.deepEqual(dispatchedKeys, ["replacement-access"]);
  assert.equal(transformCalls, 2);
});

test("account switch during Pi lazy setup cannot construct a stale WebSocket handshake", async (t) => {
  const credentials = new InMemoryCredentialStore();
  const oldAccess = codexAccessToken("old-account");
  await credentials.modify("openai-codex", async () => oauthCredential(oldAccess));
  const models = builtinModels({ credentials });
  const service = new CodexProviderService(models, credentials);
  const model = service.getModel("gpt-5.4");
  assert.ok(model);
  const payloadStarted = deferred<void>();
  const releasePayload = deferred<void>();
  let websocketConstructorReads = 0;
  let fetchCalls = 0;
  const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    get: () => {
      websocketConstructorReads += 1;
      return class {};
    },
  });
  t.after(() => {
    if (originalWebSocket) Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("stale fetch must not start");
  });

  const result = service
    .streamSimple(
      model,
      { messages: [] },
      {
        transport: "websocket",
        onPayload: async (payload) => {
          payloadStarted.resolve();
          await releasePayload.promise;
          return payload;
        },
      },
    )
    .result();
  await payloadStarted.promise;
  await service.commitCredential(oauthCredential(codexAccessToken("replacement-account")));
  releasePayload.resolve();

  assert.equal((await result).stopReason, "aborted");
  assert.equal(websocketConstructorReads, 0);
  assert.equal(fetchCalls, 0);
});

test("cancelled stalled refresh releases the caller and does not block account recovery", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  const pendingRefresh = deferred<OAuthCredential>();
  const refreshStarted = deferred<void>();
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshStarted.resolve();
        return pendingRefresh.promise;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials, () => undefined, 1_000);
  const controller = new AbortController();
  const preflight = service.prepareRuntimeModel("gpt-5.4", controller.signal);
  await refreshStarted.promise;

  controller.abort(new Error("user cancelled"));
  await assert.rejects(preflight, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "request_cancelled");
    return true;
  });

  const replacement = oauthCredential("replacement-access");
  await service.commitCredential(replacement);
  pendingRefresh.resolve(oauthCredential("late-stale-access"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(await credentials.read("openai-codex"), replacement);
});

test("a successful refresh persists even when its only caller cancels", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  const pendingRefresh = deferred<OAuthCredential>();
  const refreshStarted = deferred<void>();
  const rotationObserved = deferred<void>();
  const rotated = oauthCredential("rotated-after-cancel");
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => {
        refreshStarted.resolve();
        return pendingRefresh.promise;
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials, () => rotationObserved.resolve());
  const controller = new AbortController();
  const preflight = service.prepareRuntimeModel("gpt-5.4", controller.signal);
  await refreshStarted.promise;

  controller.abort(new Error("user cancelled"));
  await assert.rejects(preflight, (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "request_cancelled");
    return true;
  });
  pendingRefresh.resolve(rotated);
  await rotationObserved.promise;

  assert.deepEqual(await credentials.read("openai-codex"), rotated);
  assert.equal((await service.snapshot()).needsAttention, false);
});

test("auth refresh has a safe deadline and credential cleanup failures stay non-transactional", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("expired-access", 0));
  const builtin = builtinModels({ credentials });
  const pendingRefresh = deferred<OAuthCredential>();
  const models = {
    getProvider: codexProviderWith(builtin, {
      refresh: async () => pendingRefresh.promise,
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: builtin.checkAuth.bind(builtin),
    logout: builtin.logout.bind(builtin),
  } as unknown as Models;
  let cleanupCalls = 0;
  const service = new CodexProviderService(
    models,
    credentials,
    () => {
      cleanupCalls += 1;
      throw new Error("unrelated cleanup failed");
    },
    10,
  );

  await assert.rejects(service.prepareRuntimeModel("gpt-5.4"), (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "temporarily_unavailable");
    return true;
  });
  assert.equal((await service.snapshot()).needsAttention, false);

  await service.commitCredential(oauthCredential("replacement-access"));
  await service.logout();
  pendingRefresh.resolve(oauthCredential("late-stale-access"));
  assert.equal(cleanupCalls, 2);
  assert.equal((await service.snapshot()).configured, false);
});

test("marks a successful-preflight credential unhealthy when the Codex backend returns 401", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("unexpired-but-revoked"));
  const builtin = builtinModels({ credentials });
  const streamSimple: ProviderStreams["streamSimple"] = (model, _context, options) =>
    completedStream(model, options, 401);
  const models = {
    getProvider: codexProviderWith(builtin, { streamSimple }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const changes: boolean[] = [];
  service.onStatusChange((needsAttention) => changes.push(needsAttention));
  const model = await service.prepareRuntimeModel("gpt-5.4");

  const result = await service
    .streamSimple(model, { messages: [] }, { sessionId: "chat-auth-rejected" })
    .result();

  assert.equal(result.stopReason, "error");
  assert.equal((await service.snapshot()).needsAttention, true);
  assert.deepEqual(changes, [true]);
});

test("keeps backend rejection sticky until the current credential receives a successful response", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("locally-valid"));
  const builtin = builtinModels({ credentials });
  const responseStatuses = [401, 200];
  const streamSimple: ProviderStreams["streamSimple"] = (model, _context, options) =>
    completedStream(model, options, responseStatuses.shift() ?? 500);
  const models = {
    getProvider: codexProviderWith(builtin, { streamSimple }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const model = await service.prepareRuntimeModel("gpt-5.4");

  await service.streamSimple(model, { messages: [] }).result();
  assert.equal((await service.snapshot()).needsAttention, true);

  await service.prepareRuntimeModel("gpt-5.4");
  assert.equal((await service.snapshot()).needsAttention, true);

  await service.streamSimple(model, { messages: [] }).result();
  assert.equal((await service.snapshot()).needsAttention, false);
});

test("observes WebSocket auth rejection and recovery without an HTTP response callback", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("locally-valid"));
  const builtin = builtinModels({ credentials });
  const results: Array<{
    stopReason: Exclude<AssistantMessage["stopReason"], "pending">;
    errorMessage?: string;
  }> = [
    {
      stopReason: "error",
      errorMessage: "Failed to extract accountId from token",
    },
    { stopReason: "stop" },
  ];
  const streamSimple: ProviderStreams["streamSimple"] = (model) => {
    const result = results.shift();
    if (!result) throw new Error("Unexpected extra Codex stream.");
    return terminalStream(model, result.stopReason, result.errorMessage);
  };
  const models = {
    getProvider: codexProviderWith(builtin, { streamSimple }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const model = await service.prepareRuntimeModel("gpt-5.4");

  await service.streamSimple(model, { messages: [] }, { transport: "websocket" }).result();
  assert.equal((await service.snapshot()).needsAttention, true);

  await service.streamSimple(model, { messages: [] }, { transport: "websocket" }).result();
  assert.equal((await service.snapshot()).needsAttention, false);
});

test("isolated Codex preserves a closed auth-failure hint after sanitizing provider text", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("locally-valid"));
  const service = new CodexProviderService(builtinModels({ credentials }), credentials);
  const model = await service.prepareRuntimeModel("gpt-5.4");
  const prepared = await service.prepareIsolatedStream(model);
  prepared.observeResult(
    {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "The isolated provider request failed.",
      timestamp: Date.now(),
    },
    { authenticationFailure: true },
  );
  assert.equal((await service.snapshot()).needsAttention, true);
});

test("applies resolved Codex auth and caller transforms once to the native provider stream", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("resolved-access"));
  const builtin = builtinModels({ credentials });
  let captured:
    | {
        model: Model<Api>;
        apiKey: string | undefined;
        headers: Record<string, string | null> | undefined;
        env: Record<string, string> | undefined;
        transport: string | undefined;
      }
    | undefined;
  const streamSimple: ProviderStreams["streamSimple"] = (model, _context, options) => {
    captured = {
      model,
      apiKey: options?.apiKey,
      headers: options?.headers,
      env: options?.env,
      transport: options?.transport,
    };
    return terminalStream(model, "stop");
  };
  const models = {
    getProvider: codexProviderWith(builtin, {
      streamSimple,
      toAuth: async () => ({
        apiKey: "resolved-access",
        baseUrl: "https://auth.example.test/codex",
        headers: { Authorization: "Bearer resolved", "X-Base": "base" },
      }),
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const model = await service.prepareRuntimeModel("gpt-5.4");

  await service
    .streamSimple(
      model,
      { messages: [] },
      {
        headers: { authorization: null, "X-Caller": "caller" },
        env: { REGION: "two" },
        transformHeaders: async (headers) => ({
          ...headers,
          "X-Transformed": "yes",
        }),
      },
    )
    .result();

  assert.equal(captured?.model.baseUrl, "https://auth.example.test/codex");
  assert.equal(captured?.apiKey, "resolved-access");
  assert.deepEqual(captured?.headers, {
    "X-Base": "base",
    authorization: null,
    "X-Caller": "caller",
    "X-Transformed": "yes",
  });
  assert.deepEqual(captured?.env, { REGION: "two" });
  assert.equal(captured?.transport, "sse");
});

test("ignores a stale request rejection after Pi automatically rotates OAuth", async (t) => {
  const credentials = new InMemoryCredentialStore();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const oldCredential: OAuthCredential = {
    type: "oauth",
    access: "old-access",
    refresh: "old-refresh",
    expires: now + 120_000,
  };
  const rotatedCredential: OAuthCredential = {
    type: "oauth",
    access: "rotated-access",
    refresh: "rotated-refresh",
    expires: now + 240_000,
  };
  await credentials.modify("openai-codex", async () => oldCredential);
  const builtin = builtinModels({ credentials });
  const pendingSource = createAssistantMessageEventStream();
  const streamStarted = deferred<void>();
  const requestApiKeys: Array<string | undefined> = [];
  const streamSimple: ProviderStreams["streamSimple"] = (_model, _context, options) => {
    requestApiKeys.push(options?.apiKey);
    streamStarted.resolve();
    return pendingSource;
  };
  const models = {
    getProvider: codexProviderWith(builtin, {
      streamSimple,
      refresh: async () => rotatedCredential,
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  let cleanups = 0;
  const service = new CodexProviderService(models, credentials, () => {
    cleanups += 1;
  });
  const model = await service.prepareRuntimeModel("gpt-5.4");
  const staleResult = service
    .streamSimple(model, { messages: [] }, { transport: "websocket" })
    .result();
  await streamStarted.promise;

  now += 60_001;
  await service.prepareRuntimeModel("gpt-5.4");
  assert.equal(cleanups, 1);
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "Unauthorized: expired token",
    timestamp: Date.now(),
  };
  pendingSource.push({ type: "error", reason: "error", error });
  pendingSource.end(error);
  await staleResult;

  assert.deepEqual(requestApiKeys, [oldCredential.access]);
  assert.deepEqual(await credentials.read("openai-codex"), rotatedCredential);
  assert.equal((await service.snapshot()).needsAttention, false);
});

test("rechecks OAuth on tool follow-up turns and reports refresh failure with safe copy", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential());
  const builtin = builtinModels({ credentials });
  let authCalls = 0;
  const streamSimple: ProviderStreams["streamSimple"] = (model, _context, options) =>
    completedStream(model, options, 200);
  const models = {
    getProvider: codexProviderWith(builtin, {
      streamSimple,
      toAuth: async () => {
        authCalls += 1;
        if (authCalls === 3) throw new Error("invalid_grant with raw-secret");
        return { apiKey: "current-access" };
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const model = await service.prepareRuntimeModel("gpt-5.4");

  assert.equal((await service.streamSimple(model, { messages: [] }).result()).stopReason, "stop");
  const followUp = await service.streamSimple(model, { messages: [] }).result();

  assert.equal(authCalls, 3);
  assert.equal(followUp.stopReason, "error");
  assert.equal(followUp.errorMessage?.includes("raw-secret"), false);
  assert.match(followUp.errorMessage ?? "", /sign-in needs attention/iu);
  assert.equal((await service.snapshot()).needsAttention, true);
});

test("returns Pi-authoritative capabilities and rejects unknown runtime models", async () => {
  const credentials = new InMemoryCredentialStore();
  const service = new CodexProviderService(builtinModels({ credentials }), credentials);

  const info = service.getModelInfo("gpt-5.4");
  assert.equal(info?.id, "gpt-5.4");
  assert.equal(info?.vision, true);
  assert.equal(info?.toolCall, true);
  assert.equal(info?.reasoning, true);
  assert.equal(info?.matched, true);
  assert.equal(info?.contextLength, 272_000);

  await assert.rejects(service.prepareRuntimeModel("not-a-codex-model"), (error: unknown) => {
    assert.ok(error instanceof CodexRuntimeError);
    assert.equal(error.code, "model_unavailable");
    return true;
  });
});

test("an in-flight preflight rebinds to a newly committed credential", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential("old-access"));
  const builtin = builtinModels({ credentials });
  const pendingAuth = deferred<{ apiKey: string }>();
  let authCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      toAuth: async (credential) => {
        authCalls += 1;
        return authCalls === 1 ? pendingAuth.promise : { apiKey: credential.access };
      },
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const staleAttempt = service.prepareRuntimeModel("gpt-5.4");
  const replacement: OAuthCredential = {
    type: "oauth",
    access: "replacement-access",
    refresh: "replacement-refresh",
    expires: Date.now() + 5 * 60_000,
  };

  await service.commitCredential(replacement);
  pendingAuth.resolve({ apiKey: "old-access" });
  assert.equal((await staleAttempt).id, "gpt-5.4");

  assert.deepEqual(await credentials.read("openai-codex"), replacement);
  assert.equal(authCalls, 2);
  assert.equal((await service.snapshot()).needsAttention, false);
});

test("a failed credential commit does not discard an in-flight auth failure", async () => {
  const builtin = builtinModels();
  const current = oauthCredential();
  const pendingAuth = deferred<{ apiKey: string }>();
  const pendingCommit = deferred<never>();
  const credentials: CredentialStore = {
    read: async () => current,
    list: async () => [],
    modify: async () => pendingCommit.promise,
    delete: async () => undefined,
  };
  const models = {
    getProvider: codexProviderWith(builtin, {
      toAuth: async () => pendingAuth.promise,
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const runtimeResult = assert.rejects(service.prepareRuntimeModel("gpt-5.4"), CodexRuntimeError);
  const commitResult = assert.rejects(
    service.commitCredential({
      type: "oauth",
      access: "replacement-access",
      refresh: "replacement-refresh",
      expires: Date.now() + 60_000,
    }),
    /credential write failed/,
  );

  pendingAuth.reject(new Error("invalid_grant"));
  await runtimeResult;
  pendingCommit.reject(new Error("credential write failed"));
  await commitResult;

  assert.equal((await service.snapshot()).needsAttention, true);
});

test("a failed logout does not discard an in-flight auth failure", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential());
  const builtin = builtinModels({ credentials });
  const pendingAuth = deferred<{ apiKey: string }>();
  const pendingLogout = deferred<never>();
  const models = {
    getProvider: codexProviderWith(builtin, {
      toAuth: async () => pendingAuth.promise,
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
    logout: async () => pendingLogout.promise,
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);
  const runtimeResult = assert.rejects(service.prepareRuntimeModel("gpt-5.4"), CodexRuntimeError);
  const logoutResult = assert.rejects(service.logout(), /credential delete failed/);

  pendingAuth.reject(new Error("invalid_grant"));
  await runtimeResult;
  pendingLogout.reject(new Error("credential delete failed"));
  await logoutResult;

  assert.equal((await service.snapshot()).needsAttention, true);
});

test("an older success cannot clear a newer request-time auth failure", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential());
  const builtin = builtinModels({ credentials });
  const firstAuth = deferred<{ apiKey: string }>();
  const secondAuth = deferred<{ apiKey: string }>();
  let authCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      toAuth: async () => (++authCalls === 1 ? firstAuth.promise : secondAuth.promise),
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  const olderAttempt = service.prepareRuntimeModel("gpt-5.4");
  const newerAttempt = service.prepareRuntimeModel("gpt-5.4");
  secondAuth.reject(new Error("invalid_grant"));
  await assert.rejects(newerAttempt, CodexRuntimeError);
  firstAuth.resolve({ apiKey: "current-access" });
  assert.equal((await olderAttempt).id, "gpt-5.4");

  assert.equal((await service.snapshot()).needsAttention, true);
});

test("a completed older auth failure remains visible while a newer check is pending", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauthCredential());
  const builtin = builtinModels({ credentials });
  const firstAuth = deferred<{ apiKey: string }>();
  const secondAuth = deferred<{ apiKey: string }>();
  let authCalls = 0;
  const models = {
    getProvider: codexProviderWith(builtin, {
      toAuth: async () => (++authCalls === 1 ? firstAuth.promise : secondAuth.promise),
    }),
    getModels: builtin.getModels.bind(builtin),
    getModel: builtin.getModel.bind(builtin),
    checkAuth: async () => ({ type: "oauth" as const, source: "OAuth" }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  const olderAttempt = service.prepareRuntimeModel("gpt-5.4");
  const newerAttempt = service.prepareRuntimeModel("gpt-5.4");
  firstAuth.reject(new Error("invalid_grant"));
  await assert.rejects(olderAttempt, CodexRuntimeError);
  assert.equal((await service.snapshot()).needsAttention, true);

  secondAuth.resolve({ apiKey: "current-access" });
  assert.equal((await newerAttempt).id, "gpt-5.4");
  assert.equal((await service.snapshot()).needsAttention, false);
});
