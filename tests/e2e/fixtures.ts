import { type ElectronApplication, type Page } from "@playwright/test";
import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LM_STUDIO_PROVIDER_ID = "custom:lmstudio";
export const E2E_MODEL_ID = "aiden-e2e-vision";
export const E2E_MODEL_DISPLAY_NAME = "Aiden E2E Vision";
export const E2E_PROFILE_NAME = "E2E Local User";
export const E2E_ASSISTANT_RESPONSE = "Deterministic E2E response received.";
export const E2E_WORKSPACE_ID = "aiden-e2e-workspace";
export const LIVE_LM_STUDIO_ACCEPTANCE = process.env.AIDEN_E2E_LIVE_LMSTUDIO === "1";

// Playwright's config loader currently resolves its test package through the
// CommonJS condition in this ESM repository. The default runtime object carries
// the named APIs; this module-type assertion keeps every destructured API strict.
const {
  _electron: electron,
  expect,
  test: base,
} = playwrightTest as unknown as typeof PlaywrightTestModule;

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
// Production shutdown owns sequential bounded drains for foreground generation
// (6s), subagents (5s), and an optional packaged-soak receipt (5s). The release
// runner can reach those bounds under load even when Electron exits cleanly.
const ELECTRON_EXIT_TIMEOUT_MS = 20_000;
const DEFAULT_LIVE_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_LM_STUDIO_ORIGIN = new URL(DEFAULT_LIVE_LM_STUDIO_BASE_URL).origin;
const LM_STUDIO_REDIRECT_ENV = "AIDEN_E2E_LMSTUDIO_REDIRECT_ORIGIN";
const ELECTRON_TEST_BOOTSTRAP = path.join(
  REPOSITORY_ROOT,
  "tests",
  "e2e",
  "electron-test-bootstrap.cjs",
);
const APP_ENV_PASSTHROUGH = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
] as const;
const PI_AMBIENT_AUTH_ENV_NAMES = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GCLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
]);
const OS_INJECTED_ENV_NAMES = new Set(["__CF_USER_TEXT_ENCODING"]);
const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_KEY|ACCESS_KEY(?:_ID)?|TOKEN|CREDENTIALS?|SECRET(?:_ACCESS)?_KEY|PASSWORD)$/u;

export type PortableConfigSeed = "empty" | "lmstudio";

export type CapturedLmStudioRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

export type LmStudioEndpoint = {
  baseUrl: string;
  live: boolean;
  requests: CapturedLmStudioRequest[];
};

export type AidenE2e = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  configDir: string;
  rootDir: string;
  workspaceDir: string;
  lmStudio: LmStudioEndpoint;
  relaunch: () => Promise<Page>;
};

type AidenE2eOptions = {
  portableConfigSeed: PortableConfigSeed;
  workspaceSeed: boolean;
};

type MockLmStudio = LmStudioEndpoint & {
  server: Server;
};

async function assertBuiltElectronApp(): Promise<void> {
  try {
    await Promise.all([
      access(path.join(REPOSITORY_ROOT, "build", "main", "index.js")),
      access(path.join(REPOSITORY_ROOT, "build", "renderer", "main-window.html")),
    ]);
  } catch {
    throw new Error("Electron bundles are missing. Run `npm run build` before Playwright.");
  }
}

function resolveLiveLmStudioBaseUrl(): string {
  const input = process.env.AIDEN_E2E_LMSTUDIO_BASE_URL?.trim() || DEFAULT_LIVE_LM_STUDIO_BASE_URL;
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AIDEN_E2E_LMSTUDIO_BASE_URL must use HTTP or HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error(`E2E model request exceeded ${MAX_REQUEST_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : null;
}

function writeJson(response: import("node:http").ServerResponse, value: unknown): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function writeCompletion(response: import("node:http").ServerResponse): void {
  const common = {
    id: "chatcmpl-aiden-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: E2E_MODEL_ID,
  };
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(
    `data: ${JSON.stringify({
      ...common,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: E2E_ASSISTANT_RESPONSE },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      ...common,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

async function startMockLmStudio(): Promise<MockLmStudio> {
  const requests: CapturedLmStudioRequest[] = [];
  const nativeModel = {
    key: E2E_MODEL_ID,
    display_name: E2E_MODEL_DISPLAY_NAME,
    type: "llm",
    state: "loaded",
    loaded_instances: [{ id: "aiden-e2e-loaded-instance" }],
    capabilities: {
      vision: true,
      trained_for_tool_use: true,
      reasoning: false,
    },
    max_context_length: 32_768,
    params_string: "1B",
    quantization: { name: "Q4_K_M" },
  };
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    try {
      if (method === "GET" && url === "/api/v1/models") {
        requests.push({ method, url, headers: { ...request.headers }, body: null });
        writeJson(response, { models: [nativeModel] });
        return;
      }
      if (method === "GET" && url === "/api/v0/models") {
        requests.push({ method, url, headers: { ...request.headers }, body: null });
        writeJson(response, { data: [{ id: E2E_MODEL_ID, state: "loaded" }] });
        return;
      }
      if (method === "GET" && url === "/v1/models") {
        requests.push({ method, url, headers: { ...request.headers }, body: null });
        writeJson(response, { data: [{ id: E2E_MODEL_ID, type: "llm" }] });
        return;
      }
      if (method === "POST" && url === "/v1/chat/completions") {
        const body = await readJsonBody(request);
        requests.push({ method, url, headers: { ...request.headers }, body });
        writeCompletion(response);
        return;
      }
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { message: `Unhandled E2E route: ${method} ${url}` } }));
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      response.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("The deterministic LM Studio server did not bind a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    live: false,
    requests,
    server,
  };
}

async function closeMockLmStudio(mock: MockLmStudio): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    mock.server.close((error) => (error ? reject(error) : resolve()));
  });
  mock.server.closeAllConnections();
  await withTimeout(closed, "deterministic LM Studio server shutdown", PROCESS_EXIT_TIMEOUT_MS);
}

function isolatedAppEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of APP_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function seedPortableConfig(
  configDir: string,
  baseUrl: string,
  seed: PortableConfigSeed,
): Promise<void> {
  await writePrivateJson(path.join(configDir, "config.json"), {
    providers:
      seed === "lmstudio"
        ? [
            {
              id: LM_STUDIO_PROVIDER_ID,
              kind: "openai",
              label: "LM Studio (local)",
              baseUrl,
              needsKey: false,
              deployment: "local",
            },
          ]
        : [],
    providerIdAliases: {},
    mcpServers: [],
    skills: [],
  });
}

async function seedWorkspace(userDataDir: string, workspaceDir: string): Promise<void> {
  const now = Date.now();
  await writePrivateJson(path.join(userDataDir, "config.json"), {
    workspaces: [
      {
        id: E2E_WORKSPACE_ID,
        name: "Aiden E2E workspace",
        folderPath: workspaceDir,
        permission: "full",
        createdAt: now,
        updatedAt: now,
      },
    ],
    seeded: true,
    aidenDirMigratedAt: now,
  });
}

/** Wait for the one main window without assuming its initial route or title. */
export async function firstAidenWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("body")).toBeVisible();
  return page;
}

async function assertRuntimeIsolation(
  app: ElectronApplication,
  expected: {
    userDataDir: string;
    configDir: string;
    homeDir: string;
    xdgCacheDir: string;
    xdgConfigDir: string;
    xdgDataDir: string;
    environment: Record<string, string>;
  },
): Promise<void> {
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    userDataDir: electronApp.getPath("userData"),
    sessionDataDir: electronApp.getPath("sessionData"),
    appHomeDir: electronApp.getPath("home"),
    configDir: process.env.AIDEN_CONFIG_DIR ?? "",
    homeDir: process.env.HOME ?? "",
    xdgCacheDir: process.env.XDG_CACHE_HOME ?? "",
    xdgConfigDir: process.env.XDG_CONFIG_HOME ?? "",
    xdgDataDir: process.env.XDG_DATA_HOME ?? "",
    runtimeProfile: process.env.AIDEN_RUNTIME_PROFILE ?? "",
    environmentKeys: Object.keys(process.env),
  }));
  const userDataDir = path.resolve(expected.userDataDir);
  const configDir = path.resolve(expected.configDir);
  const homeDir = path.resolve(expected.homeDir);
  const xdgCacheDir = path.resolve(expected.xdgCacheDir);
  const xdgConfigDir = path.resolve(expected.xdgConfigDir);
  const xdgDataDir = path.resolve(expected.xdgDataDir);
  if (path.resolve(runtime.userDataDir) !== userDataDir) {
    throw new Error(
      `Electron ignored the E2E user-data root: expected ${userDataDir}, received ${runtime.userDataDir}.`,
    );
  }
  if (path.resolve(runtime.sessionDataDir) !== userDataDir) {
    throw new Error(
      `Electron ignored the isolated session-data root: expected ${userDataDir}, received ${runtime.sessionDataDir}.`,
    );
  }
  if (path.resolve(runtime.configDir) !== configDir) {
    throw new Error(
      `Aiden ignored the E2E portable-config root: expected ${configDir}, received ${runtime.configDir}.`,
    );
  }
  if (path.resolve(runtime.homeDir) !== homeDir) {
    throw new Error(
      `The E2E app inherited the developer home: expected ${homeDir}, received ${runtime.homeDir}.`,
    );
  }
  if (path.resolve(runtime.appHomeDir) !== homeDir) {
    throw new Error(
      `Electron ignored the isolated home root: expected ${homeDir}, received ${runtime.appHomeDir}.`,
    );
  }
  if (
    path.resolve(runtime.xdgCacheDir) !== xdgCacheDir ||
    path.resolve(runtime.xdgConfigDir) !== xdgConfigDir ||
    path.resolve(runtime.xdgDataDir) !== xdgDataDir
  ) {
    throw new Error("The E2E app ignored one or more isolated XDG roots.");
  }
  if (userDataDir === configDir || runtime.runtimeProfile !== "development") {
    throw new Error("The E2E launch did not establish distinct development profile roots.");
  }
  const expectedEnvironmentKeys = Object.keys(expected.environment).sort();
  const runtimeEnvironmentKeys = runtime.environmentKeys
    .filter((key) => !OS_INJECTED_ENV_NAMES.has(key))
    .sort();
  if (JSON.stringify(runtimeEnvironmentKeys) !== JSON.stringify(expectedEnvironmentKeys)) {
    throw new Error(
      `The E2E app environment was not hermetic: expected ${expectedEnvironmentKeys.join(", ")}; received ${runtimeEnvironmentKeys.join(", ")}.`,
    );
  }
  const forbiddenAuthKeys = runtime.environmentKeys.filter(
    (key) => PI_AMBIENT_AUTH_ENV_NAMES.has(key) || CREDENTIAL_ENV_NAME.test(key),
  );
  if (forbiddenAuthKeys.length > 0) {
    throw new Error(
      `The E2E app inherited ambient provider auth: ${forbiddenAuthKeys.join(", ")}.`,
    );
  }
}

/** Complete first-run setup with the disposable keyless LM Studio connection. */
export async function finishLmStudioOnboarding(page: Page): Promise<void> {
  const onboarding = page.locator('section[aria-label="Set up Aiden"]');
  await expect(onboarding).toBeVisible();
  const next = onboarding.getByRole("button", { name: /^Next/u });
  await expect(next).toBeDisabled();
  await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
  await next.click();

  await expect(onboarding.getByRole("heading", { name: "Add a model provider" })).toBeVisible();
  const lmStudio = onboarding.getByRole("button", {
    name: /LM Studio.*Use models running in LM Studio/u,
  });
  await lmStudio.click();
  await expect(lmStudio).toHaveAttribute("aria-pressed", "true");

  // Discovery must return and persist at least one model before onboarding can advance.
  await next.click();
  await expect(
    onboarding.getByRole("heading", { name: "Everything Aiden brings together" }),
  ).toBeVisible();
  await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
  await expect(onboarding).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: /^Selected model: .+\. Choose a model\.$/u,
    }),
  ).toBeVisible();
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !processIsAlive(pid);
}

async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || !processIsAlive(pid)) return;
  child.kill("SIGTERM");
  if (await waitForProcessExit(pid, 2_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForProcessExit(pid, 2_000))) {
    throw new Error(`Test-owned Electron process ${pid} survived SIGKILL.`);
  }
}

/** Close Electron and fail observably if its test-owned main process leaks. */
export async function closeAiden(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const child = app.process();
  const pid = child.pid;
  let closeError: unknown;
  try {
    await withTimeout(app.close(), "Electron shutdown", ELECTRON_EXIT_TIMEOUT_MS);
  } catch (error) {
    closeError = error;
  }
  const leaked = Boolean(pid && processIsAlive(pid));
  if (leaked) await terminateOwnedProcess(child);
  if (closeError || leaked) {
    const detail = closeError instanceof Error ? ` ${closeError.message}` : "";
    throw new Error(
      `Electron teardown did not finish cleanly${pid ? ` for PID ${pid}` : ""}.${detail}`,
    );
  }
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readOptionalJson(filePath: string): Promise<unknown | undefined> {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Fresh keyless profiles must contain no encrypted provider credential entries. */
export async function assertNoPersistedProviderCredentials(aiden: AidenE2e): Promise<void> {
  const providerKeys = await readOptionalJson(path.join(aiden.userDataDir, "provider-keys.json"));
  if (providerKeys !== undefined) {
    if (!providerKeys || typeof providerKeys !== "object" || Array.isArray(providerKeys)) {
      throw new Error("provider-keys.json has an unexpected shape.");
    }
    const entries = Object.keys(providerKeys);
    if (entries.length > 0) {
      throw new Error(`The keyless E2E profile persisted provider keys: ${entries.join(", ")}.`);
    }
  }

  const piCredentials = await readOptionalJson(
    path.join(aiden.userDataDir, "pi-provider-credentials.json"),
  );
  if (piCredentials !== undefined) {
    const entries =
      piCredentials && typeof piCredentials === "object" && !Array.isArray(piCredentials)
        ? (piCredentials as Record<string, unknown>).entries
        : undefined;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error("pi-provider-credentials.json has an unexpected shape.");
    }
    const providerIds = Object.keys(entries);
    if (providerIds.length > 0) {
      throw new Error(
        `The keyless E2E profile persisted Pi credentials: ${providerIds.join(", ")}.`,
      );
    }
  }
}

function formatFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export const test = base.extend<AidenE2eOptions & { aiden: AidenE2e }>({
  portableConfigSeed: ["lmstudio", { option: true }],
  workspaceSeed: [false, { option: true }],
  aiden: async ({ browserName: _browserName, portableConfigSeed, workspaceSeed }, use, testInfo) => {
    let rootDir: string | undefined;
    let mock: MockLmStudio | undefined;
    let app: ElectronApplication | undefined;
    let state: AidenE2e | undefined;
    let primaryFailure: unknown;
    let failed = false;
    try {
      await assertBuiltElectronApp();
      const testRootDir = await mkdtemp(path.join(tmpdir(), "aiden-e2e-"));
      const testUserDataDir = path.join(testRootDir, "user-data");
      const testConfigDir = path.join(testRootDir, "portable-config");
      const testXdgCacheDir = path.join(testRootDir, "xdg-cache");
      const testXdgConfigDir = path.join(testRootDir, "xdg-config");
      const testXdgDataDir = path.join(testRootDir, "xdg-data");
      const testWorkspaceDir = path.join(testRootDir, "workspace");
      rootDir = testRootDir;
      await Promise.all([
        mkdir(testUserDataDir, { recursive: true, mode: 0o700 }),
        mkdir(testConfigDir, { recursive: true, mode: 0o700 }),
        mkdir(testXdgCacheDir, { recursive: true, mode: 0o700 }),
        mkdir(testXdgConfigDir, { recursive: true, mode: 0o700 }),
        mkdir(testXdgDataDir, { recursive: true, mode: 0o700 }),
        mkdir(testWorkspaceDir, { recursive: true, mode: 0o700 }),
      ]);
      if (workspaceSeed) await seedWorkspace(testUserDataDir, testWorkspaceDir);

      mock = LIVE_LM_STUDIO_ACCEPTANCE ? undefined : await startMockLmStudio();
      const lmStudio: LmStudioEndpoint = mock ?? {
        baseUrl: resolveLiveLmStudioBaseUrl(),
        live: true,
        requests: [],
      };
      await seedPortableConfig(testConfigDir, lmStudio.baseUrl, portableConfigSeed);

      const redirectDefaultLmStudio = portableConfigSeed === "empty" && !lmStudio.live;
      const redirectOrigin = redirectDefaultLmStudio ? new URL(lmStudio.baseUrl).origin : undefined;
      if (redirectOrigin === DEFAULT_LM_STUDIO_ORIGIN) {
        throw new Error(
          "The deterministic LM Studio fixture did not receive a random loopback port.",
        );
      }

      const launch = async (): Promise<Page> => {
        const launchEnvironment: Record<string, string> = {
          ...isolatedAppEnvironment(),
          AIDEN_CONFIG_DIR: testConfigDir,
          AIDEN_RUNTIME_PROFILE: "development",
          HOME: testRootDir,
          XDG_CACHE_HOME: testXdgCacheDir,
          XDG_CONFIG_HOME: testXdgConfigDir,
          XDG_DATA_HOME: testXdgDataDir,
          ...(redirectOrigin ? { [LM_STUDIO_REDIRECT_ENV]: redirectOrigin } : {}),
        };
        const launchArgs = [
          "-r",
          ELECTRON_TEST_BOOTSTRAP,
          "--force-renderer-accessibility",
          `--user-data-dir=${testUserDataDir}`,
          REPOSITORY_ROOT,
        ];
        const launchedApp = await electron.launch({
          args: launchArgs,
          cwd: REPOSITORY_ROOT,
          env: launchEnvironment,
        });
        app = launchedApp;
        await assertRuntimeIsolation(launchedApp, {
          userDataDir: testUserDataDir,
          configDir: testConfigDir,
          homeDir: testRootDir,
          xdgCacheDir: testXdgCacheDir,
          xdgConfigDir: testXdgConfigDir,
          xdgDataDir: testXdgDataDir,
          environment: launchEnvironment,
        });
        const page = await firstAidenWindow(launchedApp);
        if (state) {
          state.app = launchedApp;
          state.page = page;
        }
        return page;
      };

      const firstPage = await launch();
      const aidenState: AidenE2e = {
        app: app!,
        page: firstPage,
        userDataDir: testUserDataDir,
        configDir: testConfigDir,
        rootDir: testRootDir,
        workspaceDir: testWorkspaceDir,
        lmStudio,
        relaunch: async () => {
          const previous = app;
          app = undefined;
          await closeAiden(previous);
          return launch();
        },
      };
      state = aidenState;
      await use(aidenState);
    } catch (error) {
      primaryFailure = error;
      failed = true;
    }

    const teardownFailures: unknown[] = [];
    try {
      await closeAiden(app);
    } catch (error) {
      teardownFailures.push(error);
    }
    if (mock) {
      try {
        await closeMockLmStudio(mock);
      } catch (error) {
        teardownFailures.push(error);
      }
    }
    if (rootDir) {
      try {
        await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      } catch (error) {
        teardownFailures.push(error);
      }
    }

    if (teardownFailures.length > 0) {
      const details = teardownFailures.map(formatFailure).join("\n");
      try {
        await testInfo.attach("e2e-teardown-failures", {
          body: Buffer.from(`${details}\n`, "utf8"),
          contentType: "text/plain",
        });
      } catch (error) {
        process.stderr.write(
          `Could not attach E2E teardown diagnostics: ${formatFailure(error)}\n`,
        );
      }
      process.stderr.write(`E2E teardown failures:\n${details}\n`);
      if (!failed) throw new Error(`E2E teardown failed:\n${details}`);
    }
    if (failed) throw primaryFailure;
  },
});

export { expect };
