export function resolveSkillCatalogWorkspaceId(
  workspaces: readonly { id: string }[] | undefined,
  storedId: string | null,
): string | undefined {
  return workspaces?.find((workspace) => workspace.id === storedId)?.id ?? workspaces?.[0]?.id;
}
