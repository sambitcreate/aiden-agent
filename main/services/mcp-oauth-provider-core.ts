// Aiden's MCP OAuth provider and attended sign-in, free of Electron. The
// desktop wires them to the encrypted session store, the system browser and
// live status in mcp-oauth.ts; tests drive the same code against a fake OAuth
// server with an in-memory store.
//
// Aiden keeps its own `OAuthClientProvider` instead of building on Pi's
// `McpOAuthProvider` + `McpOAuthStateStore`: Pi's provider persists per-URL
// state with unconditional writes, while Aiden needs private transactions with
// rollback for attended sign-in, generation gates against superseded writers,
// compare-and-set token saves and compare-and-delete invalidation across
// clients that share one stored grant, background connections that never
// register or redirect, and live sign-in status.

import { McpAuthRequiredError, McpHttpError, type McpClient, type StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  OAuthError,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientMetadataDocument,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@earendil-works/pi-mcp/oauth";
import { isMcpFieldSecretMarker } from "../../renderer/shared/mcp-field-secrets.js";
import { mcpOAuthMetadataUrlForServer } from "../../renderer/shared/mcp-oauth-config.js";
import { closeAgainAfterSettled } from "./generation-bound-connection-cache.js";
import { connectMcpClient, createMcpClient } from "./mcp-client.js";
import { explainMcpOAuthFailure, mcpOAuthClientMetadata } from "./mcp-oauth-client-metadata.js";
import { mcpOAuthBindingForServer, mcpOAuthClientIdentity, type McpOAuthClientIdentity } from "./mcp-oauth-identity.js";
import { startMcpOAuthLoopback, type McpOAuthLoopback } from "./mcp-oauth-loopback.js";
import { loadMcpOAuthMetadataOverride } from "./mcp-oauth-metadata.js";
import type { McpOAuthGeneration, McpOAuthOperation, McpOAuthOperationGate } from "./mcp-oauth-operation.js";
import { McpOAuthCredentialStorageError } from "./mcp-oauth-session-cache.js";
import {
  clearMcpStepUpScope,
  hasMcpOAuthSessionData,
  mcpInteractiveAuthorizationScope,
  mcpOAuthDisplayText,
  mcpOAuthSignInState,
  McpOAuthAuthorizationFlow,
  McpOAuthSessionTransaction,
  sessionAfterTokenInvalidation,
  sessionForMcpAuthorizationAttempt,
  sessionMatchesMcpBinding,
  sessionWithMcpClientInformation,
  sessionWithRefreshedMcpTokens,
  sessionWithSavedMcpTokens,
  usableMcpClientInformation,
  type McpOAuthSession,
  type McpOAuthSignInState,
} from "./mcp-oauth-session.js";
import { assertMcpPresetServer } from "./mcp-presets.js";
import { createMcpRemoteFetch, createMcpRemoteTransport, type McpRemoteOAuthProvider } from "./mcp-remote-transport.js";
import type { McpServer } from "./types.js";

export interface McpOAuthSessionStore {
  get(serverId: string, isCurrent?: () => boolean): Promise<McpOAuthSession>;
  set(serverId: string, session: McpOAuthSession, isCurrent?: () => boolean): Promise<void>;
  clear(serverId: string, isCurrent?: () => boolean): Promise<void>;
}

/** The live sign-in health Settings shows (see McpLiveStatusRegistry). */
export interface McpOAuthStatusSink {
  clearAuthFailure(serverId: string): void;
  authFailure(serverId: string, reason: "needs-sign-in" | "invalid-grant"): void;
  backgroundSignInRequired(serverId: string, options: { hadStoredSignIn: boolean }): void;
}

export interface McpOAuthRuntime {
  store: McpOAuthSessionStore;
  gate: McpOAuthOperationGate;
  status: McpOAuthStatusSink;
  openBrowser(url: string): Promise<void>;
  log: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void };
  /** MCP `clientInfo.version` for sign-in connections. */
  readonly clientVersion: string;
  loopback: { port: number; redirectUri: string; timeoutMs: number; host?: string };
  /** Aiden's Client ID Metadata Document URL, when one is hosted (see AIDEN_MCP_CLIENT_METADATA_URL). */
  clientMetadataUrl?: string;
  /** Fence configuration leases around a credential publication. */
  publish<T>(serverId: string, operation: () => Promise<T>): Promise<T>;
}

/** A background connection reached a point that needs the user to sign in. */
export class McpOAuthSignInRequiredError extends Error {
  readonly code = "mcp-oauth-sign-in-required";
  constructor() {
    super("This MCP server needs sign-in. Open Settings → Plugins and click Authorize.");
    this.name = "McpOAuthSignInRequiredError";
  }
}

/**
 * Stored tokens could not be refreshed because the authorization server was
 * unreachable, timed out or answered with a server error. The sign-in is kept;
 * the next connection tries again.
 */
export class McpOAuthRefreshUnavailableError extends Error {
  readonly code = "mcp-oauth-refresh-unavailable";
  constructor(cause: Error) {
    super(`Couldn’t renew the sign-in for this MCP server right now (${cause.message.replace(/\.$/u, "")}). Aiden will try again on the next connection.`);
    this.name = "McpOAuthRefreshUnavailableError";
    Object.defineProperty(this, "cause", { value: cause, configurable: true, writable: true });
  }
}

/** The tokens a sign-in just received were rejected while verifying them. */
export class McpOAuthVerificationRejectedError extends Error {
  readonly code = "mcp-oauth-verification-rejected";
  constructor() {
    super("The MCP server did not accept the new sign-in. Try Authorize again.");
    this.name = "McpOAuthVerificationRejectedError";
  }
}

/**
 * - `background`: chat turns, prewarm, status checks, child agents and Bots.
 *   Uses stored tokens and may refresh them; never discovers, registers,
 *   writes a PKCE verifier or opens a browser for a server without them.
 * - `interactive`: Settings → Authorize. Works on a private transaction.
 * - `verify`: the check right after an attended sign-in; never redirects.
 */
export type McpOAuthProviderMode = "background" | "interactive" | "verify";

export interface McpOAuthProviderOptions {
  runtime: McpOAuthRuntime;
  serverId: string;
  binding: string;
  generation: McpOAuthGeneration;
  mode: McpOAuthProviderMode;
  identity: McpOAuthClientIdentity;
  isCurrent?: () => boolean;
  transaction?: McpOAuthSessionTransaction;
  observeTokens?: (tokens: OAuthTokens) => void;
  authorization?: McpOAuthAuthorizationFlow;
  /** The configured server (for an explicit metadata document and step-up scopes). */
  server?: McpServer;
  metadataSignal?: AbortSignal;
  /** The loopback this sign-in listens on; defaults to the runtime's. */
  redirectUri?: string;
}

/** OAuthClientProvider backed by Aiden's encrypted session store. One per connection. */
export class AidenMcpOAuthProvider implements McpRemoteOAuthProvider {
  private readonly runtime: McpOAuthRuntime;
  private readonly serverId: string;
  private readonly binding: string;
  private readonly generation: McpOAuthGeneration;
  private readonly mode: McpOAuthProviderMode;
  private readonly identity: McpOAuthClientIdentity;
  private readonly requestIsCurrent: () => boolean;
  private readonly transaction?: McpOAuthSessionTransaction;
  private readonly observeTokens?: (tokens: OAuthTokens) => void;
  private readonly authorization: McpOAuthAuthorizationFlow;
  private readonly server?: McpServer;
  private readonly metadataSignal?: AbortSignal;
  /** The tokens this provider last handed to (or received from) the OAuth flow. */
  private lastTokens?: Pick<OAuthTokens, "access_token" | "refresh_token">;
  /**
   * The flow reads the PKCE verifier only to exchange an authorization code and
   * reads tokens() before a refresh, so this tells the two saves apart.
   */
  private exchangingCode = false;
  /** Why the last refresh failed without an OAuth error, if it did. */
  private refreshFailure?: Error;
  /**
   * The running flow read the stored tokens itself (a 401 recovery), as
   * opposed to a step-up for more scope, which never reads them in the flow.
   */
  private flowReadTokens = false;
  private readonly redirectUri: string;

  constructor(options: McpOAuthProviderOptions) {
    this.runtime = options.runtime;
    this.serverId = options.serverId;
    this.binding = options.binding;
    this.generation = options.generation;
    this.mode = options.mode;
    this.identity = options.identity;
    this.requestIsCurrent = options.isCurrent ?? (() => true);
    this.transaction = options.transaction;
    this.observeTokens = options.observeTokens;
    this.authorization = options.authorization ?? new McpOAuthAuthorizationFlow();
    this.server = options.server;
    this.metadataSignal = options.metadataSignal;
    this.redirectUri = options.redirectUri ?? options.runtime.loopback.redirectUri;
    if (this.mode !== "background" && !this.transaction) {
      throw new Error("An attended MCP sign-in needs a private session transaction.");
    }
  }

  private assertCanMutate(): void {
    if (!this.requestIsCurrent()) throw new Error("The renderer document is no longer active.");
    this.runtime.gate.assertMutationAllowed(this.serverId, this.generation);
  }

  private mutationIsCurrent = (): boolean =>
    this.requestIsCurrent() && this.runtime.gate.canMutate(this.serverId, this.generation);

  private async boundSession(): Promise<McpOAuthSession> {
    this.assertCanMutate();
    const session = this.transaction
      ? this.transaction.read()
      : await this.runtime.store.get(this.serverId, this.mutationIsCurrent);
    this.assertCanMutate();
    return sessionMatchesMcpBinding(session, this.binding) ? session : { authorizationBinding: this.binding };
  }

  private async saveSession(session: McpOAuthSession): Promise<void> {
    this.assertCanMutate();
    if (this.transaction) {
      this.transaction.replace(session);
      this.assertCanMutate();
      return;
    }
    await this.runtime.store.set(this.serverId, session, this.mutationIsCurrent);
  }

  /**
   * Flag a background sign-in loss (only one that had a stored grant) and
   * build the error. With `dropPresentedTokens`, the tokens this flow found
   * and could not use are compare-and-deleted (the grant id stays), so the
   * stored session reads "needs sign-in" after a restart too.
   */
  private async signInRequired(dropPresentedTokens = false): Promise<McpOAuthSignInRequiredError> {
    let hadStoredSignIn = false;
    try {
      const session = await this.boundSession();
      hadStoredSignIn = Boolean(session.tokens || session.grantId);
      if (dropPresentedTokens && this.mode === "background" && this.lastTokens) {
        const next = sessionAfterTokenInvalidation(session, this.lastTokens);
        if (next) await this.saveSession(next);
      }
    } catch {
      // A superseded or unreadable session is not reported as expired.
    }
    if (this.mode === "background" && this.mutationIsCurrent()) {
      this.runtime.status.backgroundSignInRequired(this.serverId, { hadStoredSignIn });
    }
    return new McpOAuthSignInRequiredError();
  }

  /**
   * The flow wants to send the user to the browser. Only an attended sign-in
   * may; otherwise a refresh that failed for a transient reason keeps the
   * sign-in, and anything else needs the user.
   */
  private async refusedRedirect(): Promise<Error> {
    if (this.refreshFailure) return new McpOAuthRefreshUnavailableError(this.refreshFailure);
    if (this.mode === "verify") return new McpOAuthVerificationRejectedError();
    // The stored tokens were rejected and could not be renewed (no refresh
    // token, or a refresh answered without an OAuth error). A step-up keeps them.
    return this.signInRequired(this.flowReadTokens);
  }

  /**
   * Pi rethrows OAuth errors other than `server_error` from a refresh. When
   * the token endpoint was unavailable (for example `temporarily_unavailable`
   * with a 503), that is a transient failure too, not a raw OAuth error.
   */
  mapAuthorizationError(error: unknown): unknown {
    if (this.refreshFailure && error instanceof OAuthError && !["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code)) {
      return new McpOAuthRefreshUnavailableError(this.refreshFailure);
    }
    return error;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return mcpOAuthClientMetadata(
      this.identity.kind === "dynamic" ? this.identity.clientName : undefined,
      this.redirectUri,
    ) as OAuthClientMetadata;
  }

  /**
   * Identify with Aiden's Client ID Metadata Document instead of registering,
   * when Aiden hosts one and the authorization server supports it.
   */
  clientMetadataDocument(metadata: AuthorizationServerMetadata | undefined): OAuthClientMetadataDocument | undefined {
    const url = this.runtime.clientMetadataUrl;
    if (this.identity.kind === "dynamic" && url && metadata?.client_id_metadata_document_supported === true) {
      return { url, redirectUrl: this.redirectUrl };
    }
    // The flow would register a client next; a background connection never does.
    if (this.mode === "background") throw new McpOAuthSignInRequiredError();
    return undefined;
  }

  observeRefreshFailure(cause: Error): void {
    this.refreshFailure = cause;
  }

  async state(): Promise<string> {
    if (this.mode !== "interactive") throw await this.refusedRedirect();
    this.assertCanMutate();
    return this.authorization.state;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.assertCanMutate();
    this.authorization.saveDiscovery(state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    this.assertCanMutate();
    this.flowReadTokens = false;
    // Every flow starts here, before any discovery request: a background
    // connection without stored tokens stops without touching the network.
    if (this.mode === "background" && !(await this.boundSession()).tokens) throw await this.signInRequired();
    const metadataUrl = this.server && mcpOAuthMetadataUrlForServer(this.server);
    if (metadataUrl && !this.authorization.discoveryState()) {
      const state = await loadMcpOAuthMetadataOverride(metadataUrl, {
        serviceUrl: this.server!.url!, serviceHeaders: this.server!.headers,
        signal: this.metadataSignal, isCurrent: this.mutationIsCurrent,
      });
      this.assertCanMutate();
      this.authorization.saveDiscovery(state);
    }
    return this.authorization.discoveryState();
  }

  private configuredClient(identity: Extract<McpOAuthClientIdentity, { kind: "pre-registered" }>): OAuthClientInformationMixed {
    if (identity.clientSecret !== undefined && isMcpFieldSecretMarker(identity.clientSecret)) {
      // Never send the marker itself as a secret.
      throw new Error("The saved OAuth client secret for this MCP server is missing on this device. Enter it again in Settings → Plugins.");
    }
    return { client_id: identity.clientId, ...(identity.clientSecret ? { client_secret: identity.clientSecret } : {}) };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.identity.kind === "pre-registered") return this.configuredClient(this.identity);
    const session = await this.boundSession();
    const usable = usableMcpClientInformation(session.clientInformation);
    if (usable || this.mode !== "background") return usable;
    // An expired client secret, or no registration at all: registering is an
    // attended step. A metadata-document client stores no registration.
    if (session.clientInformation || !this.runtime.clientMetadataUrl) throw await this.signInRequired();
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this.identity.kind === "pre-registered") return;
    if (this.mode === "background") throw await this.signInRequired();
    const session = await this.boundSession();
    await this.saveSession(sessionWithMcpClientInformation(session, this.binding, info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    this.exchangingCode = false;
    this.refreshFailure = undefined;
    this.flowReadTokens = true;
    const tokens = (await this.boundSession()).tokens;
    if (tokens) this.observeTokens?.(tokens);
    this.lastTokens = tokens && { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
    return tokens;
  }

  async saveTokens(received: OAuthTokens): Promise<void> {
    this.assertCanMutate();
    // Pi accepts any numeric lifetime; a negative or non-finite one would make
    // the stored session unreadable, so it is dropped (the token is used as is).
    const tokens = { ...received };
    if (tokens.expires_in !== undefined && !(Number.isFinite(tokens.expires_in) && tokens.expires_in >= 0)) delete tokens.expires_in;
    // A refresh that minted tokens proves the stored sign-in works again.
    if (this.mode === "background") this.runtime.status.clearAuthFailure(this.serverId);
    // Register the exact material before either persistence or transport reuse.
    // Subagent callers use this hook to retain only a host-owned redactor.
    this.observeTokens?.(tokens);
    const exchangedCode = this.exchangingCode;
    this.exchangingCode = false;
    const session = await this.boundSession();
    // An authorization-code exchange always wins. A refresh response that
    // arrives after another client already rotated past the tokens it presented
    // must not roll the stored pair back to credentials the server consumed.
    const next = exchangedCode
      ? sessionWithSavedMcpTokens(session, this.binding, tokens, this.authorization.requestedScope)
      : sessionWithRefreshedMcpTokens(session, this.binding, this.lastTokens, tokens, this.authorization.requestedScope);
    if (!next) {
      this.runtime.log.info(`Kept newer stored tokens for "${this.serverId}" over a late refresh response.`);
      return;
    }
    await this.saveSession(next);
    this.lastTokens = { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    if (this.mode !== "interactive") throw await this.refusedRedirect();
    const session = await this.boundSession();
    await this.saveSession({ ...session, authorizationBinding: this.binding, codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    this.exchangingCode = true;
    const verifier = (await this.boundSession()).codeVerifier;
    if (!verifier) throw new Error("Missing PKCE code verifier — restart the sign-in.");
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.mode !== "interactive") throw await this.refusedRedirect();
    const session = await this.boundSession();
    const boundUrl = this.authorization.authorizationUrl(
      authorizationUrl,
      mcpInteractiveAuthorizationScope(this.server?.url, session.tokens?.scope || session.grantedScope),
    );
    this.assertCanMutate();
    await this.runtime.openBrowser(boundUrl.toString());
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    this.assertCanMutate();
    if (scope === "all" || scope === "discovery") this.authorization.clearDiscovery();
    if (scope === "discovery") return;
    const session = await this.boundSession();
    if (this.mode !== "background") {
      // The private replacement only: after `invalid_client` the flow
      // registers a new client within this sign-in.
      const next = structuredClone(session);
      if (scope === "all" || scope === "tokens") {
        const grantedScope = next.tokens?.scope || next.grantedScope;
        delete next.tokens;
        if (grantedScope) next.grantedScope = grantedScope;
      }
      if (scope === "all" || scope === "client") delete next.clientInformation;
      if (scope === "all" || scope === "verifier") delete next.codeVerifier;
      await this.saveSession(next);
      return;
    }
    if (scope === "all" || scope === "tokens") {
      // Compare-and-delete: newer tokens a concurrent client saved survive.
      // The grant id stays, so Settings reads "needs sign-in" after restarts.
      const next = sessionAfterTokenInvalidation(session, this.lastTokens);
      if (!next) return;
      if (scope === "all") {
        // `invalid_client`: the stored registration is dead too. A new one
        // is registered only by an attended sign-in.
        delete next.clientInformation;
        delete next.codeVerifier;
      }
      await this.saveSession(next);
      if (this.mutationIsCurrent()) this.runtime.status.authFailure(this.serverId, "invalid-grant");
      return;
    }
    const next = structuredClone(session);
    if (scope === "verifier") delete next.codeVerifier;
    if (scope === "client") delete next.clientInformation;
    await this.saveSession(next);
  }
}

/** Provider for a background connection (stored tokens only). */
export function createBackgroundMcpOAuthProvider(
  runtime: McpOAuthRuntime,
  server: McpServer,
  isCurrent: () => boolean = () => true,
  observeTokens?: (tokens: OAuthTokens) => void,
): AidenMcpOAuthProvider {
  return new AidenMcpOAuthProvider({
    runtime,
    serverId: server.id,
    binding: mcpOAuthBindingForServer(server),
    generation: runtime.gate.snapshot(server.id),
    mode: "background",
    identity: mcpOAuthClientIdentity(server),
    isCurrent,
    observeTokens,
    server: structuredClone(server),
  });
}

/** Build a remote transport wired with an OAuth provider for the given server. */
export function makeMcpOAuthTransport(
  server: McpServer,
  provider: McpRemoteOAuthProvider,
  signal?: AbortSignal,
): StreamableHttpTransport {
  assertMcpPresetServer(server);
  if (!server.url) throw new Error("This MCP server needs a URL.");
  if (server.transport === "stdio") throw new Error("OAuth requires a remote MCP server.");
  return createMcpRemoteTransport({
    serviceUrl: server.url,
    serviceHeaders: server.headers,
    signal,
    authProvider: provider,
  });
}

/** Stored sign-in state of a server for Settings; an unreadable session needs a new sign-in. */
export async function readMcpOAuthSignInState(
  store: McpOAuthSessionStore,
  serverId: string,
  server: McpServer | undefined,
): Promise<McpOAuthSignInState> {
  let session: McpOAuthSession;
  try {
    session = await store.get(serverId);
  } catch (error) {
    if (error instanceof McpOAuthCredentialStorageError) return { authorized: false, needsSignIn: true, hasSession: true };
    throw error;
  }
  let binding: string | undefined;
  try {
    binding = server?.url ? mcpOAuthBindingForServer(server) : undefined;
  } catch {
    binding = undefined;
  }
  return mcpOAuthSignInState(session, binding);
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("MCP authorization was superseded by a config change.");
}

function raceMcpOAuthCancellation<T>(
  operation: Promise<T>,
  signals: ReadonlyArray<AbortSignal | undefined>,
): Promise<T> {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  const alreadyCancelled = activeSignals.find((signal) => signal.aborted);
  if (alreadyCancelled) {
    operation.catch(() => undefined);
    return Promise.reject(cancellationError(alreadyCancelled));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const listeners = new Map<AbortSignal, () => void>();
    const settle = (result: () => void): void => {
      if (settled) return;
      settled = true;
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
      result();
    };
    for (const signal of activeSignals) {
      const listener = () => settle(() => reject(cancellationError(signal)));
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

async function connectWithMcpOAuthCancellation(
  client: McpClient,
  connection: Promise<unknown>,
  signals: ReadonlyArray<AbortSignal | undefined>,
): Promise<void> {
  try {
    await raceMcpOAuthCancellation(connection, signals);
  } catch (error) {
    await client.close().catch(() => {});
    if (signals.some((signal) => signal?.aborted)) {
      // A transport may not become closeable until connect settles.
      // Keep the raw promise and close once more at that boundary.
      closeAgainAfterSettled(connection, () => client.close());
    }
    throw error;
  }
}

/** Whether a failed check means the server refused the credentials (as opposed to being unreachable). */
function isMcpOAuthRejection(error: unknown): boolean {
  return error instanceof McpOAuthSignInRequiredError ||
    error instanceof McpOAuthVerificationRejectedError ||
    error instanceof McpOAuthAuthorizationRequiredError ||
    error instanceof McpAuthRequiredError ||
    (error instanceof McpHttpError && error.status === 403) ||
    (error instanceof OAuthError && error.code !== "server_error");
}

/**
 * The OAuth error (RFC 6749 §5.2) in a failed token response, for display:
 * the description is one bounded line, and a body that is not an OAuth error
 * document is reduced to its HTTP status.
 */
async function oauthErrorOf(response: Response): Promise<OAuthError> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    value = undefined;
  }
  const { error, error_description: description } = (value && typeof value === "object" ? value : {}) as { error?: unknown; error_description?: unknown };
  if (typeof error !== "string" || !/^[\w.-]{1,64}$/u.test(error)) {
    return new OAuthError("server_error", `The authorization server answered HTTP ${response.status}.`);
  }
  return new OAuthError(error, (typeof description === "string" ? mcpOAuthDisplayText(description) : undefined) ?? error);
}

/** How long the check after sign-in may take before it is reported as a connection error. */
const VERIFY_TIMEOUT_MS = 30_000;

export interface McpOAuthAuthorizationResult {
  authorized: true;
  /**
   * The sign-in was stored, but the follow-up connection failed for a reason
   * other than the server rejecting it (unreachable, timed out, 5xx).
   */
  connectionError?: string;
}

/**
 * Run the interactive OAuth flow for a remote MCP server: open the browser,
 * capture the code on the loopback, exchange it, and verify the connection.
 * Tokens land in the store for future connections only once they exist.
 */
export async function authorizeMcpServerWithRuntime(
  runtime: McpOAuthRuntime,
  server: McpServer,
  options: { isCurrent?: () => boolean; ownerSignal?: AbortSignal; reservedOperation?: McpOAuthOperation } = {},
): Promise<McpOAuthAuthorizationResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  const { gate, store } = runtime;
  assertMcpPresetServer(server);
  if (server.transport === "stdio") throw new Error("OAuth applies only to remote (HTTP) MCP servers.");
  if (!server.url) throw new Error("Add the server URL before authorizing.");
  const serviceUrl = server.url;
  const binding = mcpOAuthBindingForServer(server);
  const identity = mcpOAuthClientIdentity(server);
  if (!isCurrent()) throw new Error("The renderer document is no longer active.");
  const operation = options.reservedOperation ?? gate.begin(server.id);
  if (!gate.isCurrent(operation)) {
    gate.end(operation);
    throw operation.signal.aborted
      ? cancellationError(operation.signal)
      : new Error("MCP authorization was superseded by a config change.");
  }
  const operationIsCurrent = () => isCurrent() && gate.isCurrent(operation);
  const signals = [operation.signal, options.ownerSignal];
  const signal = options.ownerSignal ? AbortSignal.any([operation.signal, options.ownerSignal]) : operation.signal;
  let previousSession: McpOAuthSession = {};
  let loopback: McpOAuthLoopback | null = null;
  let commitAttempted = false;
  try {
    previousSession = await store.get(server.id, operationIsCurrent).catch((error: unknown) => {
      // Signing in again is how the user recovers from an unreadable sign-in.
      if (error instanceof McpOAuthCredentialStorageError) return {};
      throw error;
    });
    // Re-authorization is transactional: the durable old session stays while
    // the flow fills a private replacement. A renderer reload, a failed
    // provider or a crash before the commit cannot erase working credentials.
    const transaction = new McpOAuthSessionTransaction(sessionForMcpAuthorizationAttempt(previousSession, binding));
    const authorization = new McpOAuthAuthorizationFlow();
    loopback = await startMcpOAuthLoopback({
      port: runtime.loopback.port,
      redirectUri: runtime.loopback.redirectUri,
      host: runtime.loopback.host,
      label: server.name || "MCP server",
      timeoutMs: runtime.loopback.timeoutMs,
      authorization,
      signal,
    });
    const redirectUri = loopback.redirectUri;
    const providerFor = (mode: "interactive" | "verify") => new AidenMcpOAuthProvider({
      runtime, serverId: server.id, binding, generation: operation, mode, identity, isCurrent,
      transaction, authorization, server: structuredClone(server), metadataSignal: signal, redirectUri,
    });
    const provider = providerFor("interactive");
    const oauthFetch = () => createMcpRemoteFetch({ serviceUrl, serviceHeaders: server.headers, signal, authProvider: provider });

    // 1. Connect without tokens: the 401 starts discovery, registration (or
    // a metadata document) and the browser redirect.
    const probe = createMcpClient("aiden-agent", runtime.clientVersion);
    let redirected = false;
    try {
      await connectWithMcpOAuthCancellation(probe, probe.connect(makeMcpOAuthTransport(server, provider, signal)), signals);
    } catch (error) {
      if (!(error instanceof McpOAuthAuthorizationRequiredError)) throw error;
      redirected = true;
    } finally {
      await probe.close().catch(() => {});
    }
    if (!redirected) {
      // The server let an anonymous connection in. Sign in anyway, so that
      // "Authorized" always means stored tokens.
      let started: string;
      try {
        started = await raceMcpOAuthCancellation(authorizeMcp(provider, { serverUrl: serviceUrl, fetch: oauthFetch(), signal }), signals);
      } catch (error) {
        if (signals.some((entry) => entry?.aborted)) throw error;
        const reason = explainMcpOAuthFailure(error).message;
        throw new Error(`${server.name || "This MCP server"} connected without signing in, and its OAuth sign-in could not start: ${reason}`);
      }
      if (started !== "REDIRECT") throw new Error("MCP authorization did not start.");
    }

    // 2. The browser consent, then the code exchange (a new network phase,
    // still fenced by the owner signal; it reuses this sign-in's discovery).
    const code = await raceMcpOAuthCancellation(loopback.waitForCode(), signals);
    // Pi retries a code exchange the token endpoint answered with
    // `invalid_client` and then fails for a missing client; keep the token
    // endpoint's own error to report instead.
    let tokenEndpointError: OAuthError | undefined;
    const exchangeFetch = oauthFetch();
    const observedExchangeFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await exchangeFetch(input, init);
      if (!response.ok && init?.body instanceof URLSearchParams && init.body.get("grant_type") === "authorization_code") {
        tokenEndpointError ??= await oauthErrorOf(response.clone());
      }
      return response;
    };
    let exchanged: string;
    try {
      exchanged = await raceMcpOAuthCancellation(authorizeMcp(provider, {
        serverUrl: serviceUrl,
        ...authorization.codeExchange(code),
        fetch: observedExchangeFetch,
        signal,
      }), signals);
    } catch (error) {
      throw tokenEndpointError && !signals.some((entry) => entry?.aborted) ? tokenEndpointError : error;
    }
    if (exchanged !== "AUTHORIZED" || !transaction.read().tokens) {
      throw new Error("The authorization server did not issue tokens. Try Authorize again.");
    }

    // 3. Verify the new tokens without ever opening another browser tab. A
    // rejection fails the sign-in; an unreachable server keeps it.
    let connectionError: string | undefined;
    const verifier = createMcpClient("aiden-agent", runtime.clientVersion);
    try {
      await connectWithMcpOAuthCancellation(
        verifier,
        connectMcpClient(verifier, makeMcpOAuthTransport(server, providerFor("verify"), signal), { timeoutMs: VERIFY_TIMEOUT_MS }),
        signals,
      );
    } catch (error) {
      if (signals.some((entry) => entry?.aborted)) throw error;
      if (isMcpOAuthRejection(error)) {
        const rejected = new McpOAuthVerificationRejectedError();
        Object.defineProperty(rejected, "cause", { value: error, configurable: true, writable: true });
        throw rejected;
      }
      connectionError = mcpOAuthDisplayText(error instanceof Error ? error.message : String(error)) ?? "Connection failed.";
    } finally {
      await verifier.close().catch(() => {});
    }
    if (!transaction.read().tokens) throw new McpOAuthVerificationRejectedError();

    // 4. Commit.
    commitAttempted = true;
    await runtime.publish(server.id, () => store.set(server.id, transaction.read(), operationIsCurrent));
    clearMcpStepUpScope(serviceUrl);
    runtime.status.clearAuthFailure(server.id);
    loopback.finish({ ok: true });
    if (connectionError) {
      runtime.log.warn(`Signed in to "${server.name}", but the connection check failed: ${connectionError}`);
      return { authorized: true, connectionError };
    }
    return { authorized: true };
  } catch (error) {
    if (commitAttempted && gate.isCurrent(operation)) {
      try {
        if (hasMcpOAuthSessionData(previousSession)) {
          await runtime.publish(server.id, () => store.set(server.id, previousSession, () => gate.isCurrent(operation)));
        } else {
          await runtime.publish(server.id, () => store.clear(server.id, () => gate.isCurrent(operation)));
        }
      } catch (restoreError) {
        runtime.log.error(`Failed to restore the previous OAuth session for "${server.name}".`, restoreError);
      }
    }
    const explained = explainMcpOAuthFailure(error);
    loopback?.finish({ ok: false, message: explained.message });
    runtime.log.warn(`Authorization failed for "${server.name}": ${error instanceof Error ? error.message : String(error)}`);
    throw explained;
  } finally {
    loopback?.close();
    gate.end(operation);
  }
}
