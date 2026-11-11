/**
 * Control-socket lifetime for one `aiden serve` run: whether new commands are
 * taken, and which accepted ones still run. See docs/state-machines/serve-daemon.md.
 */
export type ServePhase = "starting" | "serving" | "draining";

export class ServeLifetime {
  private current: ServePhase = "starting";
  private readonly commands = new Set<Promise<void>>();

  get phase(): ServePhase { return this.current; }

  get acceptsCommands(): boolean { return this.current !== "draining"; }

  /** Draining is terminal: a late ready report cannot reopen the socket. */
  markServing(): void { if (this.current === "starting") this.current = "serving"; }

  /** Refuses new commands. The ones already accepted keep running. */
  beginDrain(): void { this.current = "draining"; }

  /** The command owns the serve lease until it settles. */
  track(command: Promise<void>): void {
    this.commands.add(command);
    const settled = () => { this.commands.delete(command); };
    void command.then(settled, settled);
  }

  /** Resolves once no accepted command runs. Their own failures were already answered. */
  async settleCommands(): Promise<void> {
    while (this.commands.size) await Promise.allSettled([...this.commands]);
  }
}
