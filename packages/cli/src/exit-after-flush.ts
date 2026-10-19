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
