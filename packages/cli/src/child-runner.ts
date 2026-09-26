import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export interface ChildRunInput {
  cwd: string; prompt: string; provider?: string; model?: string;
  permission: "read-only" | "full"; signal?: AbortSignal; timeoutMs?: number;
}
export interface ChildRunResult { output: string; messages: Record<string, unknown>[]; }
/** A fresh pi process has its own cancellation, session, and context budget. */
export function runChild(input: ChildRunInput): Promise<ChildRunResult> {
  const entry = process.env.AIDEN_CLI_ENTRY ?? join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const args = [entry, "--mode", "json", "--print", "--no-extensions", "--no-skills", "--no-prompt-templates", "--tools",
    input.permission === "full" ? "read,bash,edit,write,grep,find,ls" : "read,grep,find,ls"];
  if (input.provider) args.push("--provider", input.provider);
  if (input.model) args.push("--model", input.model);
  // Prompt travels on stdin so secrets never appear in process listings.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      env: { ...process.env, AIDEN_CHILD: "1", AIDEN_CHILD_PERMISSION: input.permission, AIDEN_CLI_ENTRY: entry } });
    let stdout = "", stderr = "", failure: Error | undefined;
    let stdoutBytes = 0;
    const decoder = new StringDecoder("utf8"), errorDecoder = new StringDecoder("utf8");
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, signal); } catch { /* Already exited. */ } };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error; kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1000); escalation.unref();
    };
    const abort = () => stop(new Error("Child run cancelled."));
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("Child run exceeded its time budget.")), input.timeoutMs ?? 300_000);
    child.stdout.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > 8 * 1024 * 1024) stop(new Error("Child run exceeded its output budget."));
      else stdout += decoder.write(data);
    });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + errorDecoder.write(data)).slice(-8192); });
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);
    const cleanup = () => { clearTimeout(timer); if (escalation) clearTimeout(escalation); input.signal?.removeEventListener("abort", abort); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      stdout += decoder.end(); stderr += errorDecoder.end();
      if (failure) kill("SIGKILL"); // Settle any descendants even if the direct child handled SIGTERM.
      cleanup();
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Child run failed (${code}): ${stderr}`));
      try {
        const events = stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
        const messages = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message);
        const last = messages.at(-1);
        if (last?.stopReason === "error" || last?.stopReason === "aborted") throw new Error(last.errorMessage ?? "Child generation failed.");
        const output = messages.flatMap((message) => message.content.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text)).join("\n");
        if (!messages.length) throw new Error("Child returned no assistant message.");
        resolve({ output, messages });
      } catch (error) { reject(error); }
    });
    if (input.signal?.aborted) abort();
  });
}
