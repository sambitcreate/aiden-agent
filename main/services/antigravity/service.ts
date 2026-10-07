/**
 * Composition root for the Antigravity harness: install state, launches,
 * sessions, sign-in, and the Pi provider. Everything lives under
 * `<userData>/acp/antigravity`; the real `~/.gemini` is never touched.
 */
import type { Api, AuthInteraction, Model } from "@earendil-works/pi-ai";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { currentPlatformKey, type AcpHarnessDefinition, type AcpPlatformAsset } from "../acp/harness.js";
import { acpHosts } from "../acp/hosts.js";
import { AcpRuntimeInstaller, type AcpRuntimeState } from "../acp/installer.js";
import { AcpRuntimeLauncher } from "../acp/launcher.js";
import { AcpPidLedger } from "../acp/pid-ledger.js";
import { AcpHarnessRuntime } from "../acp/runtime.js";
import { AcpSessionStore } from "../acp/session-store.js";
import { statfsAvailableBytes } from "../managed-worktree-capacity.js";
import { hasAntigravitySignIn, signInWithGoogle, signOutOfGoogle } from "./auth.js";
import { AcpConnection } from "../acp/connection.js";
import {
  ANTIGRAVITY_LABEL,
  AUTH_URL_MARKER,
  authorizationUrlFromStderr,
  createAntigravityDefinition,
} from "./definition.js";
import { ANTIGRAVITY_RELEASE } from "./release.js";

export interface AntigravityStatus {
  runtime: AcpRuntimeState;
  signedIn: boolean;
  busy: boolean;
}

export interface AntigravityServiceOptions {
  baseDir: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
}

export class AntigravityService {
  readonly definition: AcpHarnessDefinition;
  readonly installer: AcpRuntimeInstaller;
  readonly runtime: AcpHarnessRuntime;
  readonly launcher: AcpRuntimeLauncher;
  private readonly stateDir: string;
  private readonly listeners = new Set<() => void>();
  private loaded: Promise<void> | undefined;

  constructor(options: AntigravityServiceOptions) {
    this.stateDir = path.join(options.baseDir, "state");
    this.definition = {
      ...createAntigravityDefinition({ hasSignIn: () => hasAntigravitySignIn(this.stateDir) }),
      detectSignInPrompt: (line) => authorizationUrlFromStderr(line) !== undefined,
    };
    this.installer = new AcpRuntimeInstaller(
      ANTIGRAVITY_RELEASE,
      currentPlatformKey(options.platform, options.arch),
      path.join(options.baseDir, "runtime"),
      {
        fetch: (url, init) => (options.fetch ?? fetch)(url, { ...init, redirect: "follow" }),
        freeBytes: statfsAvailableBytes,
        validate: (runtimeDir, asset, signal) => this.validate(runtimeDir, asset, signal),
        afterExtract: async (runtimeDir) => {
          if ((options.platform ?? process.platform) !== "darwin") return;
          const { execFile } = await import("node:child_process");
          await new Promise<void>((resolve) =>
            execFile("/usr/bin/xattr", ["-dr", "com.apple.quarantine", runtimeDir], () => resolve()),
          );
        },
      },
    );
    this.launcher = new AcpRuntimeLauncher({
      definition: this.definition,
      installer: this.installer,
      stateDir: this.stateDir,
      tmpRoot: path.join(options.baseDir, "tmp"),
      ledger: new AcpPidLedger(path.join(options.baseDir, "processes.json")),
      browserUrlMarker: AUTH_URL_MARKER,
    });
    this.runtime = new AcpHarnessRuntime(
      this.definition,
      this.launcher,
      acpHosts,
      new AcpSessionStore(path.join(options.baseDir, "sessions.json")),
    );
    this.runtime.onSignInLost = () => this.notify();
    this.installer.onChange(() => this.notify());
  }

  /** Read install state and clean up after a previous crash. Idempotent. */
  ready(): Promise<void> {
    this.loaded ??= (async () => {
      await this.installer.load();
      await this.launcher.sweep();
    })();
    return this.loaded;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI notification only.
      }
    }
  }

  async status(): Promise<AntigravityStatus> {
    await this.ready();
    return {
      runtime: this.installer.state(),
      signedIn: await hasAntigravitySignIn(this.stateDir),
      busy: this.runtime.busy,
    };
  }

  async install(): Promise<void> {
    await this.ready();
    await this.installer.install();
  }

  cancelInstall(): void {
    this.installer.cancel();
  }

  async removeRuntime(): Promise<void> {
    await this.ready();
    if (this.runtime.busy) throw new Error("Stop running Antigravity chats before removing the runtime.");
    await this.runtime.close().catch(() => undefined);
    await this.installer.remove();
  }

  async signOut(): Promise<void> {
    await this.ready();
    await this.runtime.reset();
    const installed = this.installer.state().status === "installed";
    await signOutOfGoogle(this.stateDir, installed ? () => this.launcher.launch("auth", this.scratchDir()) : undefined);
    this.notify();
  }

  /** Interactive Google sign-in for the provider's OAuth method. */
  async signIn(interaction: AuthInteraction): Promise<void> {
    await this.ready();
    if (this.installer.state().status !== "installed") {
      throw new Error(`Install ${ANTIGRAVITY_LABEL} in Settings → Providers before signing in.`);
    }
    await signInWithGoogle(interaction, {
      cwd: this.scratchDir(),
      launch: (onStderrLine) => this.launcher.launch("auth", this.scratchDir(), { onStderrLine }),
    });
    this.notify();
  }

  async discoverModels(signal: AbortSignal): Promise<Model<Api>[]> {
    await this.ready();
    if (this.installer.state().status !== "installed" || !(await hasAntigravitySignIn(this.stateDir))) return [];
    return (await this.runtime.discoverModels(this.scratchDir(), signal)).models;
  }

  async shutdown(): Promise<void> {
    await this.runtime.close();
  }

  private scratchDir(): string {
    return tmpdir();
  }

  private async validate(runtimeDir: string, asset: AcpPlatformAsset, signal: AbortSignal): Promise<void> {
    const launched = await this.launcher.launchWith("validate", await realpath(tmpdir()), {}, {
      runtimeDir,
      asset,
      release() {},
    });
    try {
      const initialize = await new AcpConnection(launched.process).initialize(signal);
      const reason = this.definition.validateInitialize(initialize, ANTIGRAVITY_RELEASE.version);
      if (reason) throw new Error(reason);
    } finally {
      await launched.dispose();
    }
  }
}
