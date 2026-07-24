type AppPathOpener = (path: string) => void | Promise<void>;

let openPath: AppPathOpener | undefined;

export function registerAppPathOpener(opener: AppPathOpener): () => void {
  openPath = opener;
  return () => {
    if (openPath === opener) openPath = undefined;
  };
}

export async function requestAppPath(path: string): Promise<boolean> {
  if (!path.startsWith("/") || !openPath) return false;
  await openPath(path);
  return true;
}
