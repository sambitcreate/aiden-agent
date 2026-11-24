// Aiden's own loopback ports (design mode v2 Phase 3a, D5, S59, S72). Live
// app frames may reach any loopback server except these, so every Aiden
// service that listens registers its port after a successful `listen` and
// removes it on close, and every daemon Aiden spawns or reuses does the same.
// `check:aiden-rules`' `loopback-listen-registered` rule fails a new `listen`
// that isn't registered or allowlisted with a reason.
//
// This module only records. With live apps off nothing reads it.

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535;
}

function createLoopbackPorts() {
  // A port can be held twice (two services racing for a reused daemon), so count holders.
  const holders = new Map<number, number>();
  return {
    add(port: number): void {
      if (!validPort(port)) return;
      holders.set(port, (holders.get(port) ?? 0) + 1);
    },
    delete(port: number): void {
      if (!validPort(port)) return;
      const count = holders.get(port) ?? 0;
      if (count <= 1) holders.delete(port);
      else holders.set(port, count - 1);
    },
    has(port: number): boolean {
      return holders.has(port);
    },
    snapshot(): ReadonlySet<number> {
      return new Set(holders.keys());
    },
  };
}

export type AidenLoopbackPorts = ReturnType<typeof createLoopbackPorts>;

export const aidenLoopbackPorts: AidenLoopbackPorts = createLoopbackPorts();

/** A fresh set, for tests. */
export function createAidenLoopbackPortsForTest(): AidenLoopbackPorts {
  return createLoopbackPorts();
}

/** Registers the port a listening server got, and returns its removal. */
export function registerListeningPort(server: { address(): unknown }): () => void {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address as { port?: unknown }).port : undefined;
  if (!validPort(port)) return () => {};
  aidenLoopbackPorts.add(port);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    aidenLoopbackPorts.delete(port);
  };
}
