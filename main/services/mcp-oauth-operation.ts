/** Owns interactive OAuth state so background tool discovery cannot overwrite PKCE. */
export class McpOAuthOperationGate {
  private readonly interactive = new Set<string>();

  begin(serverId: string): void {
    if (this.interactive.has(serverId)) {
      throw new Error("Authorization is already in progress for this MCP server.");
    }
    this.interactive.add(serverId);
  }

  end(serverId: string): void {
    this.interactive.delete(serverId);
  }

  assertMutationAllowed(serverId: string, isInteractiveProvider: boolean): void {
    if (!isInteractiveProvider && this.interactive.has(serverId)) {
      throw new Error("MCP authorization is in progress. Try the request again after sign-in.");
    }
  }
}
