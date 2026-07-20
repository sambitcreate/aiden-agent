// Keep saved provider credentials bound to the endpoint configuration that
// originally stored them. This prevents a renderer payload from redirecting a
// key to a different host through Test/Refresh before that endpoint is saved.

export type ProviderConnection = {
  id: string;
  kind: string;
  baseUrl: string;
  needsKey: boolean;
};

export function sameProviderConnection(
  saved: ProviderConnection | null | undefined,
  draft: ProviderConnection,
): boolean {
  return Boolean(
    saved &&
    saved.id === draft.id &&
    saved.kind === draft.kind &&
    saved.baseUrl === draft.baseUrl &&
    saved.needsKey === draft.needsKey,
  );
}

export function canUseStoredProviderKey(
  saved: ProviderConnection | null | undefined,
  draft: ProviderConnection,
): boolean {
  return draft.needsKey && sameProviderConnection(saved, draft);
}
