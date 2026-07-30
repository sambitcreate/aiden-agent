export interface McpOAuthGeneration {
  readonly serverId: string;
  readonly generation: number;
}

export interface McpOAuthOperation extends McpOAuthGeneration {
  readonly signal: AbortSignal;
}

interface ActiveOperation {
  generation: number;
  controller: AbortController;
}

/** Owns OAuth generations so cleanup can permanently supersede stale writers. */
export class McpOAuthOperationGate {
  private readonly interactive = new Map<string, ActiveOperation>();
  private readonly generations = new Map<string, number>();
  private readonly suspended = new Map<string, number>();

  snapshot(serverId: string): McpOAuthGeneration {
    return { serverId, generation: this.generations.get(serverId) ?? 0 };
  }

  begin(serverId: string): McpOAuthOperation {
    if ((this.suspended.get(serverId) ?? 0) > 0) {
      throw new Error("MCP credentials are being updated. Try again in a moment.");
    }
    if (this.interactive.has(serverId)) {
      throw new Error("Authorization is already in progress for this MCP server.");
    }
    const generation = (this.generations.get(serverId) ?? 0) + 1;
    const controller = new AbortController();
    this.generations.set(serverId, generation);
    this.interactive.set(serverId, { generation, controller });
    return { serverId, generation, signal: controller.signal };
  }

  invalidate(serverId: string): void {
    const active = this.interactive.get(serverId);
    active?.controller.abort(new Error("MCP authorization was superseded by a config change."));
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1);
    this.interactive.delete(serverId);
  }

  suspend(serverId: string): () => void {
    this.invalidate(serverId);
    this.suspended.set(serverId, (this.suspended.get(serverId) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.invalidate(serverId);
      const remaining = (this.suspended.get(serverId) ?? 1) - 1;
      if (remaining > 0) this.suspended.set(serverId, remaining);
      else this.suspended.delete(serverId);
    };
  }

  end(operation: McpOAuthOperation): void {
    const active = this.interactive.get(operation.serverId);
    if (active?.generation === operation.generation) {
      this.interactive.delete(operation.serverId);
    }
  }

  isCurrent(operation: McpOAuthGeneration): boolean {
    if ((this.suspended.get(operation.serverId) ?? 0) > 0) return false;
    if ((this.generations.get(operation.serverId) ?? 0) !== operation.generation) return false;
    const active = this.interactive.get(operation.serverId);
    if ("signal" in operation) {
      const interactive = operation as McpOAuthOperation;
      return !interactive.signal.aborted && active?.generation === operation.generation;
    }
    return active === undefined;
  }

  canMutate(serverId: string, operation: McpOAuthGeneration): boolean {
    return operation.serverId === serverId && this.isCurrent(operation);
  }

  assertMutationAllowed(serverId: string, operation: McpOAuthGeneration): void {
    if (!this.canMutate(serverId, operation)) {
      throw new Error("MCP authorization is in progress. Try the request again after sign-in.");
    }
  }
}
