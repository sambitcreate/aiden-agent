import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { linuxDesktopBusEnvironment } from "./linux-desktop-bus-environment.js";

export function resolveDictationPortalHelper(): string {
  return process.resourcesPath && !process.defaultApp
    ? path.resolve(process.resourcesPath, "..", "Helpers", "aiden-global-shortcuts-portal")
    : path.resolve(process.cwd(), "build/native/aiden-global-shortcuts-portal");
}

export interface DictationPortalCallbacks {
  activated(): void;
  deactivated(): void;
  lost(): void;
}

const DESKTOP_ENTRY = "com.sambitcreate.aiden-agent.desktop";

export function linuxDictationDesktopEntryAvailable(
  home = process.env.HOME,
  exists: (candidate: string) => boolean = existsSync,
): boolean {
  const candidates = [
    `/usr/local/share/applications/${DESKTOP_ENTRY}`,
    `/usr/share/applications/${DESKTOP_ENTRY}`,
  ];
  if (home && path.isAbsolute(home)) {
    candidates.push(path.join(home, ".local", "share", "applications", DESKTOP_ENTRY));
  }
  return candidates.some(exists);
}

/** A fresh process owns one explicit desktop permission request and session. */
export class LinuxDictationPortal {
  private generation = 0;
  private child: ChildProcess | null = null;
  private cancelPending: (() => void) | null = null;
  private bound = false;
  private pressed = false;
  constructor(
    private readonly callbacks: DictationPortalCallbacks,
    private readonly spawnHelper: () => ChildProcess = () => spawn(resolveDictationPortalHelper(), ["bind"], { stdio: ["pipe", "pipe", "ignore"], env: linuxDesktopBusEnvironment() }),
    private readonly timeoutMs = 120_000,
  ) {}
  get active(): boolean { return this.bound; }

  bind(): Promise<{ triggerDescription: string | null }> {
    this.close();
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const fail = (message: string) => {
        if (generation !== this.generation) return;
        const wasBound = this.bound;
        if (!settled) { settled = true; reject(new Error(message)); }
        this.close();
        if (wasBound) this.callbacks.lost();
      };
      this.cancelPending = () => {
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new Error("Desktop shortcut setup was cancelled.")); }
      };
      timer = setTimeout(() => fail("Desktop shortcut setup timed out."), this.timeoutMs);
      let child: ChildProcess;
      try { child = this.spawnHelper(); } catch { fail("Desktop shortcuts are unavailable."); return; }
      this.child = child;
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (generation !== this.generation) return;
        buffer += chunk;
        if (buffer.length > 4096) { fail("Invalid desktop shortcut response."); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let event: { type?: unknown; triggerDescription?: unknown };
          try { event = JSON.parse(line); } catch { fail("Invalid desktop shortcut response."); return; }
          if (!event || typeof event !== "object") { fail("Invalid desktop shortcut response."); return; }
          if (event.type === "bound" && !this.bound) {
            if (typeof event.triggerDescription !== "string" || event.triggerDescription.length > 256) { fail("Desktop shortcut did not report its assigned trigger."); return; }
            const triggerDescription = event.triggerDescription.trim() || null;
            this.bound = true; settled = true; clearTimeout(timer);
            resolve({ triggerDescription });
          } else if (event.type === "activated" && this.bound) {
            if (!this.pressed) { this.pressed = true; this.callbacks.activated(); }
          } else if (event.type === "deactivated" && this.bound) {
            if (this.pressed) { this.pressed = false; this.callbacks.deactivated(); }
          } else { fail("Desktop shortcut session ended or became unavailable."); return; }
        }
      });
      child.stdin?.on("error", () => fail("Desktop shortcut session closed."));
      child.once("error", () => fail("Desktop shortcuts are unavailable."));
      child.once("exit", () => fail("Desktop shortcut session closed."));
    });
  }
  close(): void {
    ++this.generation;
    this.bound = false; this.pressed = false;
    this.cancelPending?.(); this.cancelPending = null;
    const child = this.child; this.child = null;
    if (child) {
      child.stdin?.end();
      if (child.exitCode === null && !child.killed) child.kill();
      if (child.exitCode === null) {
        const escalation = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1_000);
        escalation.unref();
        child.once("exit", () => clearTimeout(escalation));
      }
    }
  }
}
