// What a watch routine checks, before any model runs: one bounded GET of an
// address the person approved, or a script inside the Bot's folder. A check
// either returns the output's exact bytes or a failure in words for the
// person; a failure is never a change.
//
// URL: https (http only to this Mac), GET, no credentials or cookies, no
// redirects (a 3xx is a failure that names the problem, so the person can
// paste the final address), 30 seconds, 256 KB.
// Script: a regular file inside the Bot's folder after following links, run
// with the Bot's folder as its working directory, 60 seconds, 1 MB.

import { promises as fs } from "node:fs";
import path from "node:path";
import { BOT_WATCH_LIMITS, parseBotWatchUrl, type BotWatchSource } from "../../../renderer/shared/bot-routine-trigger.js";
import { isPathInside } from "../../shared/path-containment.js";
import { runScheduledScript, type ScriptProcessResult } from "../schedule-script.js";

export type BotWatchCheck = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function failed(error: string): BotWatchCheck {
  return { ok: false, error };
}

/** One GET of `url`: the body's bytes, or why it didn't count as a check. */
export async function fetchBotWatchUrl(
  rawUrl: string,
  options: { fetch?: FetchLike; timeoutMs?: number; maxBytes?: number } = {},
): Promise<BotWatchCheck> {
  const url = parseBotWatchUrl(rawUrl);
  if (!url) return failed("This address isn't allowed. Use https, or http only for this Mac.");
  const maxBytes = options.maxBytes ?? BOT_WATCH_LIMITS.urlBytes;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? BOT_WATCH_LIMITS.urlTimeoutMs);
  timer.unref?.();
  const host = new URL(url).host;
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { accept: "*/*" },
        signal: controller.signal,
      });
    } catch {
      return failed(timedOut ? "The check timed out after 30 seconds." : `Aiden couldn't reach ${host}.`);
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return failed("The address redirects. Use the address it ends up at.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return failed(`${host} answered ${response.status}.`);
    }
    const declared = Number(response.headers.get("content-length"));
    const tooLarge = `The answer is larger than ${Math.round(maxBytes / 1024)} KB.`;
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return failed(tooLarge);
    }
    if (!response.body) return { ok: true, bytes: new Uint8Array() };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return failed(tooLarge);
        }
        chunks.push(value);
      }
    } catch {
      return failed(timedOut ? "The check timed out after 30 seconds." : `The answer from ${host} was cut off.`);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  } finally {
    clearTimeout(timer);
  }
}

export type BotWatchScriptRunner = (
  scriptPath: string,
  options: { cwd: string; timeoutMs: number; outputLimit: number },
) => Promise<ScriptProcessResult>;

/**
 * The script's real path when it is a regular file inside the Bot's folder
 * after following links; otherwise why not.
 */
export async function resolveBotWatchScript(home: string, script: string): Promise<{ path: string } | { error: string }> {
  const missing = { error: `${script} isn't in the Bot's folder.` };
  let realHome: string;
  let realScript: string;
  try {
    realHome = await fs.realpath(home);
    realScript = await fs.realpath(path.join(realHome, script));
  } catch {
    return missing;
  }
  if (!isPathInside(realHome, realScript, { allowRoot: false })) return { error: `${script} points outside the Bot's folder.` };
  const stat = await fs.stat(realScript).catch(() => undefined);
  if (!stat?.isFile()) return missing;
  return { path: realScript };
}

/** Runs the script with the Bot's folder as its working directory: stdout's bytes, or why it failed. */
export async function runBotWatchScript(
  home: string,
  script: string,
  options: { run?: BotWatchScriptRunner; timeoutMs?: number; maxBytes?: number } = {},
): Promise<BotWatchCheck> {
  const resolved = await resolveBotWatchScript(home, script);
  if ("error" in resolved) return failed(resolved.error);
  const run = options.run ?? ((scriptPath, runOptions) => runScheduledScript(scriptPath, runOptions));
  let result: ScriptProcessResult;
  try {
    result = await run(resolved.path, {
      cwd: await fs.realpath(home),
      timeoutMs: options.timeoutMs ?? BOT_WATCH_LIMITS.scriptTimeoutMs,
      outputLimit: options.maxBytes ?? BOT_WATCH_LIMITS.scriptBytes,
    });
  } catch {
    return failed(`${script} couldn't start.`);
  }
  if (result.timedOut) return failed(`${script} ran longer than 60 seconds.`);
  if (result.outputLimitExceeded) return failed(`${script} printed more than 1 MB.`);
  if (result.aborted) return failed(`${script} was stopped.`);
  if (result.exitCode !== 0) {
    return failed(result.exitCode === null ? `${script} was stopped by ${result.signal ?? "a signal"}.` : `${script} exited with code ${result.exitCode}.`);
  }
  return { ok: true, bytes: new TextEncoder().encode(result.stdout) };
}

/** Runs one check of a watch source. */
export function checkBotWatchSource(
  source: BotWatchSource,
  home: () => Promise<string>,
  options: { fetch?: FetchLike; run?: BotWatchScriptRunner } = {},
): Promise<BotWatchCheck> {
  if (source.type === "url") return fetchBotWatchUrl(source.url, { ...(options.fetch ? { fetch: options.fetch } : {}) });
  return home().then(
    (folder) => runBotWatchScript(folder, source.script, { ...(options.run ? { run: options.run } : {}) }),
    () => failed("Aiden couldn't find the Bot's folder."),
  );
}
