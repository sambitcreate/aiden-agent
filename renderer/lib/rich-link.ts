export const MAX_RICH_LINKS_PER_MESSAGE = 50;

export type RichLinkProvider =
  | "github"
  | "gitlab"
  | "google-drive"
  | "sharepoint"
  | "box"
  | "notion"
  | "slack"
  | "teams"
  | "outlook";

export type RichLinkResourceKind =
  | "repository"
  | "pull-request"
  | "issue"
  | "commit"
  | "release"
  | "workflow"
  | "discussion"
  | "file"
  | "folder"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "workspace"
  | "message"
  | "meeting"
  | "email"
  | "calendar"
  | "link";

export interface RichLinkDescriptor {
  provider: RichLinkProvider;
  providerLabel: string;
  resourceKind: RichLinkResourceKind;
  resourceLabel: string;
  primaryLabel: string;
  secondaryLabel?: string;
  safeDisplayUrl: string;
}

export type WebLinkSegment =
  | { kind: "text"; text: string; start: number; end: number }
  | { kind: "link"; text: string; href: string; start: number; end: number };

const WEB_URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const SIMPLE_TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ":", ";", "'", '"']);
const CLOSING_TO_OPENING = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);
const PRIMARY_LABEL_LIMIT = 160;
const SECONDARY_LABEL_LIMIT = 120;
const DISPLAY_URL_LIMIT = 240;

function hasHost(url: URL, host: string): boolean {
  return url.hostname === host || url.hostname.endsWith(`.${host}`);
}

function exactHost(url: URL, ...hosts: string[]): boolean {
  return hosts.includes(url.hostname);
}

function pathParts(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => safeDecode(part));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanLabel(value: string, fallback: string): string {
  const cleaned = value.replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned || fallback;
}

function boundText(value: string, limit: number): string {
  const scalars = Array.from(value);
  if (scalars.length <= limit) return value;
  return `${scalars.slice(0, limit - 1).join("")}…`;
}

function safePath(url: URL, parts: string[] = pathParts(url)): string {
  const path = parts.length ? `/${parts.map((part) => encodeURIComponent(part)).join("/")}` : "";
  return `${url.hostname}${path}`;
}

function descriptor(
  provider: RichLinkProvider,
  providerLabel: string,
  resourceKind: RichLinkResourceKind,
  resourceLabel: string,
  primaryLabel: string,
  safeDisplayUrl: string,
  secondaryLabel?: string,
): RichLinkDescriptor {
  return {
    provider,
    providerLabel,
    resourceKind,
    resourceLabel,
    primaryLabel: boundText(primaryLabel, PRIMARY_LABEL_LIMIT),
    safeDisplayUrl: boundText(safeDisplayUrl, DISPLAY_URL_LIMIT),
    ...(secondaryLabel
      ? { secondaryLabel: boundText(secondaryLabel, SECONDARY_LABEL_LIMIT) }
      : {}),
  };
}

function describeGitHub(url: URL): RichLinkDescriptor | null {
  if (!exactHost(url, "github.com")) return null;
  const parts = pathParts(url);
  const owner = parts[0];
  const repository = parts[1];
  if (!owner || !repository) {
    return descriptor("github", "GitHub", "workspace", "Profile", owner || "GitHub", safePath(url));
  }

  const repoLabel = `${owner}/${repository}`;
  const section = parts[2]?.toLowerCase();
  const identifier = parts[3];
  if (section === "pull" && identifier) {
    return descriptor("github", "GitHub", "pull-request", "Pull request", repoLabel, safePath(url), `#${identifier}`);
  }
  if (section === "issues" && identifier) {
    return descriptor("github", "GitHub", "issue", "Issue", repoLabel, safePath(url), `#${identifier}`);
  }
  if (section === "commit" && identifier) {
    return descriptor("github", "GitHub", "commit", "Commit", repoLabel, safePath(url), identifier.slice(0, 12));
  }
  if (section === "releases") {
    const release = parts[4] || identifier;
    return descriptor("github", "GitHub", "release", "Release", repoLabel, safePath(url), release ? cleanLabel(release, "Release") : undefined);
  }
  if (section === "actions") {
    return descriptor("github", "GitHub", "workflow", "Workflow run", repoLabel, safePath(url));
  }
  if (section === "discussions" && identifier) {
    return descriptor("github", "GitHub", "discussion", "Discussion", repoLabel, safePath(url), `#${identifier}`);
  }
  if (section === "blob") {
    return descriptor("github", "GitHub", "file", "File", cleanLabel(parts[parts.length - 1] || repository, repository), safePath(url), repoLabel);
  }
  if (section === "tree") {
    return descriptor("github", "GitHub", "folder", "Folder", cleanLabel(parts[parts.length - 1] || repository, repository), safePath(url), repoLabel);
  }
  return descriptor("github", "GitHub", "repository", "Repository", repoLabel, safePath(url));
}

function describeGitLab(url: URL): RichLinkDescriptor | null {
  if (!exactHost(url, "gitlab.com")) return null;
  const parts = pathParts(url);
  if (!parts.length) {
    return descriptor("gitlab", "GitLab", "workspace", "Workspace", "GitLab", url.hostname);
  }
  const separator = parts.indexOf("-");
  const projectParts = separator >= 0 ? parts.slice(0, separator) : parts;
  const projectLabel = projectParts.join("/");
  if (separator < 0) {
    return descriptor("gitlab", "GitLab", "repository", "Project", projectLabel, safePath(url));
  }

  const section = parts[separator + 1]?.toLowerCase();
  const identifier = parts[separator + 2];
  if (section === "merge_requests" && identifier) {
    return descriptor("gitlab", "GitLab", "pull-request", "Merge request", projectLabel, safePath(url), `!${identifier}`);
  }
  if (section === "issues" && identifier) {
    return descriptor("gitlab", "GitLab", "issue", "Issue", projectLabel, safePath(url), `#${identifier}`);
  }
  if (section === "commit" && identifier) {
    return descriptor("gitlab", "GitLab", "commit", "Commit", projectLabel, safePath(url), identifier.slice(0, 12));
  }
  if (section === "pipelines") {
    return descriptor("gitlab", "GitLab", "workflow", "Pipeline", projectLabel, safePath(url), identifier ? `#${identifier}` : undefined);
  }
  if (section === "releases") {
    return descriptor("gitlab", "GitLab", "release", "Release", projectLabel, safePath(url), identifier ? cleanLabel(identifier, "Release") : undefined);
  }
  if (section === "blob") {
    return descriptor("gitlab", "GitLab", "file", "File", cleanLabel(parts[parts.length - 1] || projectParts[projectParts.length - 1] || "File", "File"), safePath(url), projectLabel);
  }
  if (section === "tree") {
    return descriptor("gitlab", "GitLab", "folder", "Folder", cleanLabel(parts[parts.length - 1] || projectParts[projectParts.length - 1] || "Folder", "Folder"), safePath(url), projectLabel);
  }
  return descriptor("gitlab", "GitLab", "repository", "Project", projectLabel, safePath(url));
}

function describeGoogle(url: URL): RichLinkDescriptor | null {
  const parts = pathParts(url);
  if (exactHost(url, "docs.google.com")) {
    const kind = parts[0]?.toLowerCase();
    if (kind === "document") {
      return descriptor("google-drive", "Google Drive", "document", "Google Doc", "Document", `${url.hostname}/document`);
    }
    if (kind === "spreadsheets") {
      return descriptor("google-drive", "Google Drive", "spreadsheet", "Google Sheet", "Spreadsheet", `${url.hostname}/spreadsheets`);
    }
    if (kind === "presentation") {
      return descriptor("google-drive", "Google Drive", "presentation", "Google Slides", "Presentation", `${url.hostname}/presentation`);
    }
  }
  if (exactHost(url, "drive.google.com")) {
    const isFolder = parts[0] === "drive" && parts[1] === "folders";
    return descriptor(
      "google-drive",
      "Google Drive",
      isFolder ? "folder" : "file",
      isFolder ? "Folder" : "File",
      isFolder ? "Shared folder" : "Shared file",
      url.hostname,
    );
  }
  return null;
}

function describeSharePoint(url: URL): RichLinkDescriptor | null {
  if (!hasHost(url, "sharepoint.com") && !exactHost(url, "onedrive.live.com", "1drv.ms")) return null;
  const parts = pathParts(url);
  const looksLikeFolder = parts.some((part) => {
    const lower = part.toLowerCase();
    return lower.includes("folder") || lower === ":f:";
  });
  const primary = hasHost(url, "sharepoint.com")
    ? cleanLabel(url.hostname.split(".")[0] || "SharePoint", "SharePoint")
    : "Shared item";
  return descriptor(
    "sharepoint",
    hasHost(url, "sharepoint.com") ? "SharePoint" : "OneDrive",
    looksLikeFolder ? "folder" : "file",
    looksLikeFolder ? "Folder" : "Shared item",
    primary,
    url.hostname,
  );
}

function describeBox(url: URL): RichLinkDescriptor | null {
  if (!hasHost(url, "box.com")) return null;
  const parts = pathParts(url);
  const folderIndex = parts.findIndex((part) => part.toLowerCase() === "folder");
  const fileIndex = parts.findIndex((part) => part.toLowerCase() === "file");
  const kind = folderIndex >= 0 ? "folder" : "file";
  const label = kind === "folder" ? "Shared folder" : fileIndex >= 0 ? "Shared file" : "Shared item";
  return descriptor("box", "Box", kind, kind === "folder" ? "Folder" : "File", label, url.hostname);
}

function describeNotion(url: URL): RichLinkDescriptor | null {
  if (!exactHost(url, "notion.so", "www.notion.so") && !hasHost(url, "notion.site")) return null;
  const parts = pathParts(url);
  const last = parts[parts.length - 1] || "Notion page";
  const withoutId = last.replace(/-[0-9a-f]{32}$/iu, "").replace(/^[0-9a-f]{32}$/iu, "");
  return descriptor(
    "notion",
    "Notion",
    "document",
    "Page",
    cleanLabel(withoutId, "Notion page"),
    url.hostname,
  );
}

function describeSlack(url: URL): RichLinkDescriptor | null {
  if (!hasHost(url, "slack.com")) return null;
  const parts = pathParts(url);
  const archiveIndex = parts.indexOf("archives");
  const channel = archiveIndex >= 0 ? parts[archiveIndex + 1] : undefined;
  const workspace = url.hostname === "app.slack.com" ? "Slack" : cleanLabel(url.hostname.split(".")[0] || "Slack", "Slack");
  return descriptor(
    "slack",
    "Slack",
    archiveIndex >= 0 ? "message" : "workspace",
    archiveIndex >= 0 ? "Message" : "Workspace",
    workspace,
    archiveIndex >= 0 && channel ? `${url.hostname}/archives/${encodeURI(channel)}` : url.hostname,
    channel ? `Channel ${channel}` : undefined,
  );
}

function describeTeams(url: URL): RichLinkDescriptor | null {
  if (!exactHost(url, "teams.microsoft.com", "teams.live.com")) return null;
  const parts = pathParts(url).map((part) => part.toLowerCase());
  const isMeeting = parts.some((part) => part === "meetup-join" || part === "meet");
  const isMessage = parts.some((part) => part === "message" || part === "l");
  return descriptor(
    "teams",
    "Microsoft Teams",
    isMeeting ? "meeting" : isMessage ? "message" : "workspace",
    isMeeting ? "Meeting" : isMessage ? "Message" : "Workspace",
    isMeeting ? "Teams meeting" : isMessage ? "Teams message" : "Microsoft Teams",
    url.hostname,
  );
}

function describeOutlook(url: URL): RichLinkDescriptor | null {
  if (!exactHost(url, "outlook.office.com", "outlook.office365.com", "outlook.live.com", "outlook.cloud.microsoft")) return null;
  const path = url.pathname.toLowerCase();
  const isCalendar = path.includes("calendar");
  return descriptor(
    "outlook",
    "Microsoft Outlook",
    isCalendar ? "calendar" : "email",
    isCalendar ? "Calendar" : "Email",
    isCalendar ? "Outlook calendar" : "Outlook email",
    url.hostname,
  );
}

export function describeRichLink(href: string): RichLinkDescriptor | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // URL normalizes explicit default ports to an empty string. Any remaining
  // port is a distinct origin and must not inherit a trusted provider label.
  if (url.port) return null;

  return (
    describeGitHub(url) ??
    describeGitLab(url) ??
    describeGoogle(url) ??
    describeSharePoint(url) ??
    describeBox(url) ??
    describeNotion(url) ??
    describeSlack(url) ??
    describeTeams(url) ??
    describeOutlook(url)
  );
}

function trimWebUrlCandidate(candidate: string): string {
  const unmatchedClosings = new Map<string, number>();
  for (const [closing, opening] of CLOSING_TO_OPENING) {
    let balance = 0;
    for (const character of candidate) {
      if (character === opening) balance -= 1;
      if (character === closing) balance += 1;
    }
    unmatchedClosings.set(closing, Math.max(0, balance));
  }
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1]!;
    if (SIMPLE_TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const unmatched = unmatchedClosings.get(last) ?? 0;
    if (unmatched > 0) {
      unmatchedClosings.set(last, unmatched - 1);
      end -= 1;
      continue;
    }
    break;
  }
  return candidate.slice(0, end);
}

function isValidWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function tokenizeWebLinks(content: string): WebLinkSegment[] {
  const segments: WebLinkSegment[] = [];
  let cursor = 0;
  WEB_URL_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(WEB_URL_PATTERN)) {
    const matchStart = match.index;
    const candidate = match[0];
    if (matchStart === undefined || !candidate) continue;
    const urlText = trimWebUrlCandidate(candidate);
    if (!urlText || !isValidWebUrl(urlText)) continue;
    if (matchStart > cursor) {
      segments.push({ kind: "text", text: content.slice(cursor, matchStart), start: cursor, end: matchStart });
    }
    const linkEnd = matchStart + urlText.length;
    segments.push({ kind: "link", text: urlText, href: urlText, start: matchStart, end: linkEnd });
    cursor = linkEnd;
  }
  if (cursor < content.length) {
    segments.push({ kind: "text", text: content.slice(cursor), start: cursor, end: content.length });
  }
  return segments.length ? segments : [{ kind: "text", text: content, start: 0, end: content.length }];
}
