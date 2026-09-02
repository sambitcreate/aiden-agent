export type ShellMode = "agent" | "design";

export const SHELL_MODE_STORAGE_KEY = "aiden-agent.shell-mode.v1";
export const LAST_AGENT_ROUTE_STORAGE_KEY = "aiden-agent.shell-mode.last-agent-route.v1";
export const LAST_DESIGN_PROJECT_STORAGE_KEY = "aiden-agent.shell-mode.last-design-project.v1";

const MAX_DESIGN_PROJECT_ID_CHARS = 256;
const SAFE_DESIGN_PROJECT_ID = /^[A-Za-z0-9._:@+-]+$/u;

export type AgentReturnTarget =
  | "/"
  | "/scheduled"
  | "/bots"
  | `/bots/${string}`
  | `/chat/${string}`;

export function parseShellMode(value: string | null | undefined): ShellMode {
  return value === "design" ? "design" : "agent";
}

export function shellModeForPath(
  pathname: string,
  rememberedMode: string | null | undefined,
): ShellMode {
  if (pathname === "/design" || pathname.startsWith("/design/")) return "design";
  if (pathname === "/profile") return parseShellMode(rememberedMode);
  return "agent";
}

export function agentReturnTarget(pathname: string | null | undefined): AgentReturnTarget {
  if (!pathname) return "/";
  if (pathname === "/scheduled") return "/scheduled";
  if (pathname === "/bots") return "/bots";
  const botMatch = /^\/bots\/([^/?#]+)(?:\/chat\/([^/?#]+))?$/u.exec(pathname);
  if (botMatch && botMatch.slice(1).filter(Boolean).every(isDecodableRouteSegment)) {
    return pathname as `/bots/${string}`;
  }
  const chatMatch = /^\/chat\/([^/?#]+)$/u.exec(pathname);
  if (chatMatch && isDecodableRouteSegment(chatMatch[1])) return pathname as `/chat/${string}`;
  return "/";
}

function isDecodableRouteSegment(value: string): boolean {
  try {
    return decodeURIComponent(value).length > 0;
  } catch {
    return false;
  }
}

export function designProjectIdFromPath(pathname: string): string | undefined {
  const match = /^\/design\/([^/?#]+)$/u.exec(pathname);
  if (!match) return undefined;
  try {
    return parseRememberedDesignProject(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}

export function parseRememberedDesignProject(value: string | null | undefined): string | undefined {
  if (
    !value ||
    value.length > MAX_DESIGN_PROJECT_ID_CHARS ||
    value.normalize("NFKC") !== value ||
    !SAFE_DESIGN_PROJECT_ID.test(value)
  ) {
    return undefined;
  }
  return value;
}
