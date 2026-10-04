/** The search params of `/host/$hostId/new`: the host project to start in, when the sidebar named one. */
export function parseRemoteNewChatSearch(search: Record<string, unknown>): { workspaceId?: string } {
  const { workspaceId } = search;
  return typeof workspaceId === "string" && /^[A-Za-z0-9._:-]{1,160}$/u.test(workspaceId) ? { workspaceId } : {};
}
