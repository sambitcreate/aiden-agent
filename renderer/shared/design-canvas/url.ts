// The aiden-design URL shape, shared by main (the scheme handler) and the
// renderer (frame `src`s). Kept free of Node imports so the renderer can use it.

export const DESIGN_SCHEME = "aiden-design";

/**
 * `aiden-design://<grant>/<relative-path>` with each path segment
 * percent-encoded, so `#`, `?` and spaces in file names survive.
 */
export function designUrl(grant: string, relativePath: string): string {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
  return `${DESIGN_SCHEME}://${grant}/${encoded}`;
}
