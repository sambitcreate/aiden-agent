// Which browser workspaces belong to a Bot. A Bot's managed workspace is not
// one of the person's configured workspaces, so the browser service admits it
// only once main has registered it here (from the Bot's own runtime or the
// Bot panel's request for its browser), and it always uses the Bot's own
// profile. Main-only; renderer input never registers a workspace.

const botsByWorkspace = new Map<string, string>();

export function registerBotBrowserWorkspace(workspaceId: string, botId: string): void {
  if (!workspaceId || !botId) throw new Error("A Bot browser needs its Bot and workspace.");
  const current = botsByWorkspace.get(workspaceId);
  if (current !== undefined && current !== botId) throw new Error("This browser workspace belongs to another Bot.");
  botsByWorkspace.set(workspaceId, botId);
}

/** The Bot whose managed workspace this is, or `undefined` for any other workspace. */
export function botIdForBrowserWorkspace(workspaceId: string): string | undefined {
  return botsByWorkspace.get(workspaceId);
}

/** The browser workspaces registered for one Bot. */
export function browserWorkspacesOfBot(botId: string): string[] {
  return [...botsByWorkspace].flatMap(([workspaceId, owner]) => (owner === botId ? [workspaceId] : []));
}

export function forgetBotBrowserWorkspace(botId: string): void {
  for (const [workspaceId, owner] of botsByWorkspace) if (owner === botId) botsByWorkspace.delete(workspaceId);
}
