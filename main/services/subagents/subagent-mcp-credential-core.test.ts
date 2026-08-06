import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubagentMcpCredentialBoundary,
  createSubagentMcpOAuthTokenObserver,
  createSubagentMcpOAuthTokenRedactor,
  MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS,
  subagentMcpEndpointCredentials,
} from "./subagent-mcp-credential-core.js";

const REVISION_KEY = Buffer.alloc(32, 7);
const PRESET_KEY_A = "preset-key-A-private";
const PRESET_KEY_B = "preset-key-B-private";
const ACCESS_A = "oauth-access-A-private";
const ACCESS_B = "oauth-access-B-private";
const REFRESH_A = "oauth-refresh-A-private";
const REFRESH_B = "oauth-refresh-B-private";
const HEADER = "custom-header-private";
const HEADER_TOKEN = "authorization-token-private";

function boundary(
  overrides: Partial<
    Parameters<typeof createSubagentMcpCredentialBoundary>[0]
  > = {},
) {
  return createSubagentMcpCredentialBoundary({
    revisionKey: REVISION_KEY,
    configuredHeaders: {
      authorization: `Bearer ${HEADER_TOKEN}`,
      "x-private": HEADER,
    },
    presetApiKey: PRESET_KEY_A,
    oauthGeneration: 4,
    oauthSession: {
      authorizationBinding: "https://mcp.example.test/",
      clientInformation: {
        client_id: "public-client-one",
        redirect_uris: ["http://127.0.0.1/callback"],
      },
      tokens: {
        access_token: ACCESS_A,
        refresh_token: REFRESH_A,
        token_type: "Bearer",
        scope: "read",
      },
      codeVerifier: "pkce-verifier-private",
    },
    ...overrides,
  });
}

test("preset API-key rotation changes only the non-secret credential revision", () => {
  const first = boundary();
  assert.equal(boundary().revision, first.revision);
  assert.notEqual(
    boundary({ presetApiKey: PRESET_KEY_B }).revision,
    first.revision,
  );
  assert.match(first.revision, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(first);
  for (const secret of [
    PRESET_KEY_A,
    ACCESS_A,
    REFRESH_A,
    HEADER,
    HEADER_TOKEN,
  ]) {
    assert.doesNotMatch(first.revision, new RegExp(secret, "u"));
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  }
});

test("routine OAuth token refresh is stable while reauthorization or account identity changes", () => {
  const first = boundary();
  const refreshed = boundary({
    oauthSession: {
      authorizationBinding: "https://mcp.example.test/",
      clientInformation: {
        client_id: "public-client-one",
        redirect_uris: ["http://127.0.0.1/callback"],
      },
      tokens: {
        access_token: ACCESS_B,
        refresh_token: REFRESH_B,
        token_type: "Bearer",
        scope: "read",
      },
    },
  });
  assert.equal(refreshed.revision, first.revision);
  assert.doesNotMatch(
    refreshed.redactText(`${ACCESS_B} ${REFRESH_B}`),
    /oauth-(?:access|refresh)-B/u,
  );
  assert.notEqual(boundary({ oauthGeneration: 5 }).revision, first.revision);
  assert.notEqual(
    boundary({
      oauthSession: {
        authorizationBinding: "https://mcp.example.test/",
        clientInformation: {
          client_id: "public-client-two",
          redirect_uris: ["http://127.0.0.1/callback"],
        },
        tokens: {
          access_token: ACCESS_A,
          refresh_token: REFRESH_A,
          token_type: "Bearer",
          scope: "read",
        },
      },
    }).revision,
    first.revision,
  );
});

test("transport token redactors retain only credential fields and their encoded forms", () => {
  const access = "transport-access-private";
  const refresh = "transport-refresh-private";
  const redact = createSubagentMcpOAuthTokenRedactor({
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    scope: "read",
  });
  const encoded = encodeURIComponent(access);
  const output = redact(`${access} ${refresh} ${encoded} Bearer read`);
  assert.doesNotMatch(output, /transport-(?:access|refresh)-private/u);
  assert.doesNotMatch(output, new RegExp(encoded, "u"));
  assert.match(output, /Bearer read/u);
  assert.throws(
    () => createSubagentMcpOAuthTokenRedactor({ access_token: "x" }),
    /too short/u,
  );
});

test("OAuth observation deduplicates token sets and fails closed at its fixed ceiling", () => {
  const redactors: Array<(text: string) => string> = [];
  const observe = createSubagentMcpOAuthTokenObserver((redactor) => {
    redactors.push(redactor);
  });
  const tokens = (index: number) => ({
    access_token: `transport-token-${index}-private`,
    token_type: "Bearer",
  });
  observe(tokens(0));
  observe(tokens(0));
  assert.equal(redactors.length, 1);
  for (
    let index = 1;
    index < MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS;
    index += 1
  ) {
    observe(tokens(index));
  }
  assert.equal(
    redactors.length,
    MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS,
  );
  assert.throws(
    () => observe(tokens(MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS)),
    /observation limit/u,
  );
  const redacted = redactors.reduce(
    (text, redact) => redact(text),
    `transport-token-0-private transport-token-${MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS - 1}-private`,
  );
  assert.doesNotMatch(redacted, /transport-token/u);
});

test("host redactor removes echoed headers, preset keys, OAuth tokens, and PKCE material", () => {
  const value = boundary();
  const hostile = [
    `Authorization: ${HEADER}`,
    `bare authorization token=${HEADER_TOKEN}`,
    `key=${PRESET_KEY_A}`,
    `access_token=${ACCESS_A}`,
    `refresh_token=${REFRESH_A}`,
    "verifier=pkce-verifier-private",
  ].join("\n");
  const redacted = value.redactText(hostile);
  assert.match(redacted, /REDACTED MCP CREDENTIAL/u);
  for (const secret of [
    HEADER,
    HEADER_TOKEN,
    PRESET_KEY_A,
    ACCESS_A,
    REFRESH_A,
    "pkce-verifier-private",
  ]) {
    assert.doesNotMatch(redacted, new RegExp(secret, "u"));
  }
});

test("host redactor removes standard URL, query, JSON, and base64 credential forms", () => {
  const secret = 'tok/a+b "quoted"';
  const value = boundary({ endpointCredentials: [secret] });
  const forms = [
    encodeURIComponent(secret),
    new URLSearchParams([["token", secret]]).toString().slice("token=".length),
    JSON.stringify(secret).slice(1, -1),
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8")
      .toString("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/gu, ""),
  ];
  for (const form of forms) {
    assert.equal(value.redactText(`echo=${form}`).includes(form), false);
  }
  const encoded = encodeURIComponent(secret);
  const lowerPercent = encoded.replace(/%[0-9A-F]{2}/gu, (escape) =>
    escape.toLowerCase(),
  );
  let alternate = false;
  const mixedPercent = encoded.replace(/%[0-9A-F]{2}/gu, (escape) => {
    alternate = !alternate;
    return alternate ? escape.toLowerCase() : escape;
  });
  assert.doesNotMatch(value.redactText(`echo=${lowerPercent}`), /tok%/u);
  assert.doesNotMatch(value.redactText(`echo=${mixedPercent}`), /tok%/u);
});

test("ordinary headers do not poison schemas and weak credentials fail closed", () => {
  const value = boundary({
    configuredHeaders: {
      "content-type": "application/json",
      accept: "en",
      authorization: `Bearer ${HEADER_TOKEN}`,
    },
  });
  assert.equal(
    value.redactText("schema accepts application/json and language en"),
    "schema accepts application/json and language en",
  );
  assert.throws(
    () => boundary({ endpointCredentials: ["u"] }),
    /too short/u,
  );
  assert.throws(
    () => boundary({ configuredHeaders: { authorization: "1" } }),
    /too short/u,
  );
});

test("opaque custom header values are always treated as credential material", () => {
  const value = boundary({
    configuredHeaders: {
      "x-service-key": "service-key-private",
      "ocp-apim-subscription-key": "subscription-key-private",
      "x-client-credential": "client-credential-private",
      "signature-input": "signature-private",
    },
  });
  const echoed = value.redactText(
    "service-key-private subscription-key-private client-credential-private signature-private",
  );
  assert.doesNotMatch(echoed, /(?:service|subscription|client|signature)-/u);
  assert.throws(
    () => boundary({ configuredHeaders: { "x-service-key": "abc" } }),
    /too short/u,
  );
});

test("opaque endpoint query values are credentials except fixed public selectors", () => {
  assert.deepEqual(
    subagentMcpEndpointCredentials(
      "https://user:pass@mcp.test/read?key=oneprivate&signature=twoprivate&credential=threeprivate&subscription-key=fourprivate&version=2025&format=json",
    ),
    ["user", "pass", "oneprivate", "twoprivate", "threeprivate", "fourprivate"],
  );
});
