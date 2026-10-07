import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { InitializeResponse, SessionConfigOption } from "@agentclientprotocol/sdk";

import { tempDir } from "../acp/test-support.js";
import {
  antigravitySettingsPath,
  authorizationUrlFromStderr,
  AUTH_URL_MARKER,
  classifyAntigravityPermission,
  createAntigravityDefinition,
  isAntigravitySubagentCall,
} from "./definition.js";
import { nativeAntigravityModelId, projectNativeModels } from "./models.js";
import { ANTIGRAVITY_RELEASE } from "./release.js";

const signedIn = createAntigravityDefinition({ hasSignIn: async () => true });

function initialize(overrides: Partial<InitializeResponse> = {}): InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
    agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.3.0" },
    ...overrides,
  };
}

test("only the pinned Antigravity build with Google sign-in passes validation", () => {
  assert.equal(signedIn.validateInitialize(initialize(), ANTIGRAVITY_RELEASE.version), undefined);
  assert.match(
    signedIn.validateInitialize(initialize({ agentInfo: { name: "other", version: "1.3.0" } }), "1.3.0") ?? "",
    /not Google Antigravity/u,
  );
  assert.match(
    signedIn.validateInitialize(initialize({ agentInfo: { name: "antigravity-acp", version: "1.2.1" } }), "1.3.0") ?? "",
    /expects 1\.3\.0/u,
  );
  assert.equal(
    signedIn.validateInitialize(initialize({ agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.3.0" } }), "1.3.0"),
    undefined,
  );
  assert.match(signedIn.validateInitialize(initialize({ authMethods: [] }), "1.3.0") ?? "", /Google sign-in/u);
});

test("launch isolates the profile, strips ambient Google credentials, and records sign-in for chats", async () => {
  const state = tempDir();
  const runtimeDir = path.join(state, "runtime");
  const previous = { key: process.env.GEMINI_API_KEY, adc: process.env.GOOGLE_APPLICATION_CREDENTIALS };
  process.env.GEMINI_API_KEY = "ambient-key";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/adc.json";
  try {
    const spec = await signedIn.prepareLaunch({
      runtimeDir,
      asset: ANTIGRAVITY_RELEASE.platforms["linux-x64"]!,
      stateDir: state,
      tmpDir: path.join(state, "tmp", "run-1"),
      cwd: state,
      purpose: "chat",
      browserHook: "/hooks/browser.sh",
    });
    assert.equal(spec.command, path.join(runtimeDir, "agy_acp_server.par"));
    assert.deepEqual(spec.args, ["--uid="]);
    assert.equal(spec.env.GEMINI_HOME, path.join(state, "profile"));
    assert.equal(spec.env.AGY_ACP_FORCE_FILE_STORAGE, "1");
    assert.equal(spec.env.ANTIGRAVITY_HARNESS_PATH, path.join(runtimeDir, "localharness_external"));
    assert.equal(spec.env.BROWSER, "/hooks/browser.sh");
    assert.equal(spec.env.GEMINI_API_KEY, undefined);
    assert.equal(spec.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.ok(spec.env.PATH);
    const settings = JSON.parse(readFileSync(antigravitySettingsPath(state), "utf8")) as { auth?: { type?: string } };
    assert.equal(settings.auth?.type, "oauth-personal");
  } finally {
    if (previous.key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous.key;
    if (previous.adc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = previous.adc;
  }
});

test("a sign-in launch never preselects an auth type", async () => {
  const state = tempDir();
  await signedIn.prepareLaunch({
    runtimeDir: state,
    asset: ANTIGRAVITY_RELEASE.platforms["darwin-arm64"]!,
    stateDir: state,
    tmpDir: state,
    cwd: state,
    purpose: "auth",
  });
  assert.throws(() => readFileSync(antigravitySettingsPath(state), "utf8"));
});

test("Full maps to yolo; every other permission keeps Antigravity asking", () => {
  assert.equal(signedIn.nativeModeFor("full"), "yolo");
  for (const permission of ["ask", "read-only", "none"] as const) {
    assert.equal(signedIn.nativeModeFor(permission), "default");
  }
});

test("effort-qualified ids collapse into one model with a thinking map", () => {
  const models = projectNativeModels([
    { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
    { value: "claude-sonnet", name: "Claude Sonnet" },
  ]);
  assert.deepEqual(
    models.map((model) => [model.id, model.name, model.reasoning]),
    [
      ["gemini-3.8-flash", "Gemini 3.8 Flash", true],
      ["gemini-3.1-pro", "Gemini 3.1 Pro", true],
      ["claude-sonnet", "Claude Sonnet", false],
    ],
  );
  const flash = models[0]!;
  assert.equal(nativeAntigravityModelId(flash, "low"), "gemini-3.8-flash-low");
  assert.equal(nativeAntigravityModelId(flash, undefined), "gemini-3.8-flash-medium");
  assert.equal(nativeAntigravityModelId(flash, "xhigh"), "gemini-3.8-flash-high");
  const pro = models[1]!;
  // Pro has no medium tier: the default clamps to the nearest offered tier.
  assert.equal(nativeAntigravityModelId(pro, "medium"), "gemini-pro-agent");
  assert.equal(nativeAntigravityModelId(models[2]!, "high"), "claude-sonnet");
});

test("models come from the session's model config option, including grouped choices", () => {
  const options: SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-3.8-flash-low",
      options: [
        {
          group: "gemini",
          name: "Gemini",
          options: [
            { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
            { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          ],
        },
      ],
    },
  ];
  const projection = signedIn.projectModels(options);
  assert.equal(projection.modelConfigId, "model");
  assert.deepEqual(projection.models.map((model) => model.id), ["gemini-3.8-flash"]);
  assert.deepEqual(signedIn.projectModels([]).models, []);
});

test("interaction_ requests are questions; security warnings travel with approvals", () => {
  const question = classifyAntigravityPermission({
    sessionId: "s",
    toolCall: { toolCallId: "interaction_7", title: "Pick one" },
    options: [{ optionId: "a", name: "A", kind: "allow_once" }],
  });
  assert.deepEqual(question, { kind: "question", question: { title: "Pick one", options: [{ id: "a", label: "A" }] } });
  const approval = classifyAntigravityPermission({
    sessionId: "s",
    toolCall: { toolCallId: "t", title: "Run" },
    options: [
      { optionId: "always", name: "Allow for this thread", kind: "allow_always", _meta: { "agy.security.warning": { title: "Careful", message: "This may be a prompt injection." } } },
    ],
  });
  assert.deepEqual(approval, { kind: "approval", warning: "This may be a prompt injection." });
});

test("start_subagent calls are subagent batches unless they are MCP calls", () => {
  assert.equal(isAntigravitySubagentCall({ toolCallId: "1", title: "Running start_subagent" }), true);
  assert.equal(isAntigravitySubagentCall({ toolCallId: "2", title: "Run start_subagent?", kind: "other" }), true);
  assert.equal(isAntigravitySubagentCall({ toolCallId: "3", title: "Running start_subagent", kind: "execute" }), false);
  assert.equal(
    isAntigravitySubagentCall({ toolCallId: "4", title: "Running start_subagent", _meta: { is_mcp_tool_call: true } }),
    false,
  );
});

test("authorization URLs are read from the BROWSER hook marker or the server's own line", () => {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?state=x";
  assert.equal(authorizationUrlFromStderr(`${AUTH_URL_MARKER}${url}`), url);
  assert.equal(authorizationUrlFromStderr(`Open the following link to authenticate the ACP server: ${url}`), url);
  assert.equal(authorizationUrlFromStderr("I1006 settings.py:302] settings: path=/x"), undefined);
});
