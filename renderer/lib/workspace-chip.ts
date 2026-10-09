const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/u;

/**
 * The github.com page for a repository's canonical key (`host/owner/name`), or
 * null when the repository is hosted elsewhere or the key is not a plain
 * owner/name pair (nested GitLab-style groups, enterprise hosts, odd input).
 */
export function githubRepositoryUrl(canonicalKey: string): string | null {
  const [host, owner, name, ...rest] = canonicalKey.split("/");
  if (host !== "github.com" || rest.length > 0 || !owner || !name) return null;
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(name)) return null;
  if (owner.startsWith(".") || name === "." || name === "..") return null;
  return `https://github.com/${owner}/${name}`;
}
