import { promises as fs } from "node:fs";
import path from "node:path";

/** Documents a user may hand to the operating system's default app from a chat link. */
const EXTERNAL_DOCUMENT_EXTENSIONS = new Set([".htm", ".html", ".pdf"]);

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a chat file link to the real path of an HTML or PDF document inside
 * the workspace folder, for opening in the system's default browser or app.
 * Symlinks are followed and the target must still be inside the workspace.
 */
export async function resolveExternalWorkspaceDocument(folderPath: string, suppliedPath: string): Promise<string> {
  if (!suppliedPath || suppliedPath.includes("\0")) throw new Error("A document path is required.");
  const configured = path.resolve(folderPath);
  const root = await fs.realpath(configured);
  const absolute = path.isAbsolute(suppliedPath);
  const lexical = absolute ? path.resolve(suppliedPath) : path.resolve(root, suppliedPath);
  // An absolute link names the configured folder, which may itself be a symlink.
  const candidate = absolute && inside(configured, lexical) ? path.join(root, path.relative(configured, lexical)) : lexical;
  if (!inside(root, candidate)) throw new Error("Aiden can only open files inside this workspace.");
  const real = await fs.realpath(candidate).catch(() => {
    throw new Error("This file no longer exists.");
  });
  if (!inside(root, real)) throw new Error("Aiden can only open files inside this workspace.");
  if (!EXTERNAL_DOCUMENT_EXTENSIONS.has(path.extname(real).toLowerCase()))
    throw new Error("Only HTML and PDF files can open in the system browser.");
  if (!(await fs.stat(real)).isFile()) throw new Error("Only files can open in the system browser.");
  return real;
}
