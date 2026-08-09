import { createHmac, randomBytes } from "node:crypto";
import type { McpOAuthSession } from "../mcp-oauth-session.js";

const REVISION = /^[a-f0-9]{64}$/u;
const REDACTION = "[REDACTED MCP CREDENTIAL]";

export interface SubagentMcpCredentialBoundary {
  /** Process-private, non-secret identity; changes when credential/account material changes. */
  revision: string;
  /** Host-owned closure. Raw credential values must never leave this boundary. */
  redactText(text: string): string;
}

export type SubagentMcpCredentialRedactor = (text: string) => string;

export interface CreateSubagentMcpCredentialBoundaryInput {
  revisionKey: Uint8Array;
  configuredHeaders?: Readonly<Record<string, string>>;
  endpointCredentials?: readonly string[];
  presetApiKey?: string | null;
  oauthSession?: McpOAuthSession;
  oauthGeneration?: number;
}

export function subagentMcpEndpointCredentials(url: string | undefined): string[] {
  if (!url) return [];
  const parsed = new URL(url);
  const values: string[] = [];
  for (const encoded of [parsed.username, parsed.password]) {
    if (!encoded) continue;
    try {
      values.push(decodeURIComponent(encoded));
    } catch {
      values.push(encoded);
    }
  }
  for (const [name, value] of parsed.searchParams) {
    // Query parameters are opaque and potentially credential-bearing. Only a
    // fixed set of public representation/version selectors is excluded.
    if (!/^(?:api-version|format|lang|locale|version)$/iu.test(name) && value) {
      values.push(value);
    }
  }
  return values;
}

function frame(
  hmac: ReturnType<typeof createHmac>,
  label: string,
  value: string | number | boolean | undefined,
): void {
  const text = value === undefined ? "" : String(value);
  hmac.update(`${label.length}:${label}:${Buffer.byteLength(text, "utf8")}:`);
  hmac.update(text);
  hmac.update(";");
}

function oauthRevisionFields(
  session: McpOAuthSession | undefined,
): Array<[string, string]> {
  if (!session) return [];
  const fields: Array<[string, string]> = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string") fields.push([label, value]);
  };
  add("binding", session.authorizationBinding);
  add("client_id", session.clientInformation?.client_id);
  const tokens = session.tokens as Record<string, unknown> | undefined;
  if (tokens) {
    add("token_type", tokens.token_type);
    add("scope", tokens.scope);
  }
  return fields;
}

const PUBLIC_PROTOCOL_HEADER_NAME =
  /^(?:accept|accept-language|content-type|user-agent)$/iu;
const MIN_REDACTABLE_CREDENTIAL_CHARS = 4;
export const MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS = 128;

function rawSecretValues(
  input: CreateSubagentMcpCredentialBoundaryInput,
): string[] {
  const configuredHeaderValues = Object.entries(input.configuredHeaders ?? {})
    // MCP custom headers are opaque and therefore credential-bearing unless
    // they are one of the fixed public HTTP negotiation headers.
    .filter(([name]) => !PUBLIC_PROTOCOL_HEADER_NAME.test(name))
    .map(([, value]) => value);
  const values = [
    ...configuredHeaderValues,
    ...(input.endpointCredentials ?? []),
    input.presetApiKey ?? undefined,
    input.oauthSession?.codeVerifier,
    input.oauthSession?.clientInformation?.client_secret,
  ];
  for (const value of configuredHeaderValues) {
    const credential = /^(?:basic|bearer|token)\s+(.+)$/iu.exec(value)?.[1];
    if (credential) values.push(credential);
  }
  const tokens = input.oauthSession?.tokens as
    Record<string, unknown> | undefined;
  if (tokens) {
    for (const [key, value] of Object.entries(tokens)) {
      if (typeof value === "string" && /(?:token|secret)$/iu.test(key))
        values.push(value);
    }
  }
  return uniqueRawSecrets(values);
}

function uniqueRawSecrets(values: readonly unknown[]): string[] {
  const raw = [
    ...new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
    ),
  ];
  if (raw.some((value) => value.length < MIN_REDACTABLE_CREDENTIAL_CHARS)) {
    throw new Error("MCP credential is too short for safe output filtering.");
  }
  return raw;
}

function secretValues(raw: readonly string[]): string[] {
  const forms = raw.flatMap((value) => {
    const queryEncoded = new URLSearchParams([["value", value]])
      .toString()
      .slice("value=".length);
    const base64 = Buffer.from(value, "utf8").toString("base64");
    return [
      value,
      encodeURIComponent(value),
      queryEncoded,
      JSON.stringify(value).slice(1, -1),
      base64,
      base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, ""),
    ];
  });
  return [...new Set(forms.filter(Boolean))].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

function redactorForRawSecrets(
  raw: readonly string[],
): SubagentMcpCredentialRedactor {
  const secrets = secretValues(raw);
  const percentPatterns = [
    ...new Set(secrets.filter((value) => value.includes("%"))),
  ]
    .map(percentEncodedPattern)
    .filter((pattern): pattern is RegExp => pattern !== undefined);
  return (text: string) => {
    let redacted = text;
    for (const secret of secrets)
      redacted = redacted.split(secret).join(REDACTION);
    for (const pattern of percentPatterns)
      redacted = redacted.replace(pattern, REDACTION);
    return redacted;
  };
}

/** Build a closure for OAuth tokens observed by the host transport. Raw values never leave it. */
export function createSubagentMcpOAuthTokenRedactor(
  tokens: Readonly<Record<string, unknown>>,
): SubagentMcpCredentialRedactor {
  return redactorForRawSecrets(uniqueRawSecrets(oauthTokenEntries(tokens).map(([, value]) => value)));
}

function oauthTokenEntries(
  tokens: Readonly<Record<string, unknown>>,
): Array<[string, string]> {
  return Object.entries(tokens)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && /(?:token|secret)$/iu.test(entry[0]),
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

/** Dedupe exact host-observed token sets and fail closed before redaction can grow unbounded. */
export function createSubagentMcpOAuthTokenObserver(
  register: (redactor: SubagentMcpCredentialRedactor) => void,
): (tokens: Readonly<Record<string, unknown>>) => void {
  const fingerprintKey = randomBytes(32);
  const observed = new Set<string>();
  return (tokens) => {
    const entries = oauthTokenEntries(tokens);
    const hmac = createHmac("sha256", fingerprintKey);
    hmac.update("aiden-subagent-mcp-observed-oauth-v1\0");
    for (const [name, value] of entries) frame(hmac, name, value);
    const fingerprint = hmac.digest("hex");
    if (observed.has(fingerprint)) return;
    if (observed.size >= MAX_SUBAGENT_MCP_OBSERVED_OAUTH_TOKEN_SETS) {
      throw new Error("MCP OAuth credential observation limit exceeded.");
    }
    register(createSubagentMcpOAuthTokenRedactor(tokens));
    observed.add(fingerprint);
  };
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function percentEncodedPattern(value: string): RegExp | undefined {
  let source = "";
  let containsEscape = false;
  for (let index = 0; index < value.length; index += 1) {
    if (
      value[index] === "%" &&
      /^[0-9a-f]$/iu.test(value[index + 1] ?? "") &&
      /^[0-9a-f]$/iu.test(value[index + 2] ?? "")
    ) {
      containsEscape = true;
      const first = value[index + 1]!;
      const second = value[index + 2]!;
      const hex = (character: string) =>
        /[a-f]/iu.test(character)
          ? `[${character.toLowerCase()}${character.toUpperCase()}]`
          : character;
      source += `%${hex(first)}${hex(second)}`;
      index += 2;
    } else {
      source += regexLiteral(value[index]!);
    }
  }
  return containsEscape ? new RegExp(source, "gu") : undefined;
}

export function createSubagentMcpCredentialBoundary(
  input: CreateSubagentMcpCredentialBoundaryInput,
): SubagentMcpCredentialBoundary {
  if (input.revisionKey.byteLength < 32) {
    throw new Error("MCP credential revision key is invalid.");
  }
  const hmac = createHmac("sha256", input.revisionKey);
  hmac.update("aiden-subagent-mcp-credential-v1\0");
  for (const [name, value] of Object.entries(
    input.configuredHeaders ?? {},
  ).sort(([a], [b]) => a.localeCompare(b))) {
    frame(hmac, `header.${name.toLowerCase()}`, value);
  }
  for (const [index, value] of [...(input.endpointCredentials ?? [])]
    .sort()
    .entries()) {
    frame(hmac, `endpoint_credential.${index}`, value);
  }
  frame(hmac, "preset_api_key", input.presetApiKey ?? undefined);
  frame(hmac, "oauth_generation", input.oauthGeneration);
  for (const [label, value] of oauthRevisionFields(input.oauthSession))
    frame(hmac, label, value);
  const revision = hmac.digest("hex");
  if (!REVISION.test(revision))
    throw new Error("MCP credential revision is invalid.");
  const redactText = redactorForRawSecrets(rawSecretValues(input));
  return Object.freeze({
    revision,
    redactText,
  });
}
