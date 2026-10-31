/**
 * Pipe writes are asynchronous on macOS and Windows, so process.exit() right
 * after a large stdout write drops whatever the kernel has not yet accepted
 * (`aiden <command> | jq` received JSON cut off at 64 KiB with exit status 0).
 * An empty write's callback runs only after every earlier write on that stream
 * has been handed to the OS, so wait on it for both streams before exiting.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map(flush));
  process.exit(code);
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) { resolve(); return; }
    stream.write("", () => resolve());
  });
}

/**
 * A reader that closes early (`aiden schedule list | head -1`) makes the next
 * stdout write fail with EPIPE. Aiden's own commands then exit quietly with
 * status 0 (a tool killed by SIGPIPE would report 141; exiting 0 keeps
 * `set -o pipefail` scripts from failing on a reader that stopped early)
 * instead of printing an unhandled 'error' stack.
 */
const closedStdout = (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") throw error; process.exit(0); };
export function exitQuietlyOnClosedStdout(): void { if (!process.stdout.listeners("error").includes(closedStdout)) process.stdout.on("error", closedStdout); }
