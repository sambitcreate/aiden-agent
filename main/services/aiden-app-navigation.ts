import { randomUUID } from "node:crypto";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";

export const AIDEN_APP_DESTINATIONS = [
  "appearance",
  "memory",
  "skills",
  "providers",
  "web-search",
] as const;
type Destination = (typeof AIDEN_APP_DESTINATIONS)[number];
type Result = { status: "opened" | "blocked" | "unavailable"; destination: Destination };
/** Navigation is verified by the same renderer document that received it. */
export class AidenAppNavigation {
  private pending = new Map<
    string,
    { owner: ChatGenerationOwner; finish(status: Result["status"]): void }
  >();
  async open(
    destination: unknown,
    owner?: ChatGenerationOwner,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (!AIDEN_APP_DESTINATIONS.includes(destination as Destination))
      throw new Error("Unknown Aiden destination.");
    const target = destination as Destination;
    if (
      !owner ||
      owner.kind === "remote" ||
      owner.id === 0 ||
      owner.isDestroyed() ||
      signal?.aborted
    )
      return { status: "unavailable", destination: target };
    if (this.pending.size >= 16) throw new Error("Too many pending navigation requests.");
    const id = randomUUID();
    return new Promise<Result>((resolve) => {
      let unsubscribe = () => {};
      const finish = (status: Result["status"]) => {
        this.pending.delete(id);
        clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        resolve({ status, destination: target });
      };
      const abort = () => finish("unavailable");
      const timeout = setTimeout(abort, 5000);
      this.pending.set(id, { owner, finish });
      unsubscribe = owner.onInvalidated(abort);
      signal?.addEventListener("abort", abort, { once: true });
      if (!this.pending.has(id) || owner.isDestroyed() || signal?.aborted) {
        abort();
        return;
      }
      try {
        owner.send("app:navigate", {
          path: `/settings?section=${target === "web-search" ? "websearch" : target}`,
          requestId: id,
        });
      } catch {
        abort();
      }
    });
  }
  acknowledge(id: unknown, status: unknown, owner: ChatGenerationOwner): boolean {
    if (typeof id !== "string" || (status !== "opened" && status !== "blocked")) return false;
    const request = this.pending.get(id);
    if (
      !request ||
      request.owner.id !== owner.id ||
      request.owner.documentId !== owner.documentId ||
      request.owner.isDestroyed() ||
      owner.isDestroyed()
    )
      return false;
    request.finish(status);
    return true;
  }
}
export const aidenAppNavigation = new AidenAppNavigation();
