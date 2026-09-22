/** The desktop browser is shared by the visible Environment surface and agent tools. */
export type BrowserAppearance = "system" | "light" | "dark";
export const BROWSER_VIEWPORT_PRESETS = [
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-xr", name: "iPhone XR", width: 414, height: 896 },
  { id: "iphone-12-pro", name: "iPhone 12 Pro", width: 390, height: 844 },
  { id: "iphone-14-pro-max", name: "iPhone 14 Pro Max", width: 430, height: 932 },
  { id: "pixel-7", name: "Pixel 7", width: 412, height: 915 },
  { id: "samsung-galaxy-s8-plus", name: "Samsung Galaxy S8+", width: 360, height: 740 },
  { id: "samsung-galaxy-s20-ultra", name: "Samsung Galaxy S20 Ultra", width: 412, height: 915 },
  { id: "ipad-mini", name: "iPad Mini", width: 768, height: 1024 },
  { id: "ipad-air", name: "iPad Air", width: 820, height: 1180 },
  { id: "ipad-pro", name: "iPad Pro", width: 1024, height: 1366 },
  { id: "surface-pro-7", name: "Surface Pro 7", width: 912, height: 1368 },
  { id: "surface-duo", name: "Surface Duo", width: 540, height: 720 },
  { id: "galaxy-z-fold-5", name: "Galaxy Z Fold 5", width: 344, height: 882 },
  { id: "asus-zenbook-fold", name: "Asus Zenbook Fold", width: 853, height: 1280 },
  { id: "samsung-galaxy-a51-71", name: "Samsung Galaxy A51/71", width: 412, height: 914 },
  { id: "nest-hub", name: "Nest Hub", width: 1024, height: 600 },
  { id: "nest-hub-max", name: "Nest Hub Max", width: 1280, height: 800 },
] as const;
export interface BrowserViewport {
  mode: "fill" | "responsive";
  width: number;
  height: number;
  deviceName?: string;
  ratioLocked?: boolean;
}
export interface BrowserProfile {
  id: string;
  name: string;
  kind: "persistent" | "incognito";
}
export interface BrowserDefaults {
  profileId: string;
  viewport: BrowserViewport;
  appearance: BrowserAppearance;
  zoom: number;
  recordingFps: number;
  linkTarget: "browser" | "external";
  agentAccess: "off" | "allow";
  autoShow: boolean;
}
export type BrowserAgentAccessOverride = "inherit" | "allow" | "off";
export function resolveBrowserAgentAccess(
  globalAccess: BrowserDefaults["agentAccess"],
  override: BrowserAgentAccessOverride,
): boolean {
  return (override === "inherit" ? globalAccess : override) === "allow";
}
export interface BrowserTab {
  id: string;
  workspaceId: string;
  profileId: string;
  url: string;
  title: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  crashed: boolean;
  audible: boolean;
  muted: boolean;
  viewport: BrowserViewport;
  appearance: BrowserAppearance;
  zoom: number;
  recording: boolean;
  agentControlling: boolean;
  floating: boolean;
  pictureInPicture?: boolean;
  visible?: boolean;
}
export interface BrowserHistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}
export interface BrowserServer {
  url: string;
  label: string;
}
export interface BrowserState {
  workspaceId: string;
  revision: number;
  tabs: BrowserTab[];
  activeTabId: string | null;
  profiles: BrowserProfile[];
  defaults: BrowserDefaults;
  agentAccessOverride: BrowserAgentAccessOverride;
  agentAccessAllowed: boolean;
  history: BrowserHistoryEntry[];
  servers: BrowserServer[];
}
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface BrowserDiagnostic {
  level: string;
  message: string;
  timestamp: number;
}
export interface BrowserElement {
  ref: string;
  tag: string;
  role?: string;
  text: string;
  selector: string;
  bounds: BrowserBounds;
  attributes?: Record<string, string>;
  source?: string;
}
export interface BrowserImage {
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}
export interface BrowserSnapshot {
  tab: BrowserTab;
  text: string;
  elements: BrowserElement[];
  image?: BrowserImage;
  diagnostics: BrowserDiagnostic[];
  accessibilityTree?: unknown;
  consoleEntries?: unknown[];
  networkEntries?: unknown[];
  actionTimeline?: unknown[];
}
export interface BrowserRecording {
  id: string;
  path: string;
  mimeType: string;
  durationMs: number;
  sizeBytes: number;
}
export interface BrowserImportSource {
  id: string;
  browser: string;
  profile: string;
  path: string;
  running?: boolean;
}
export interface BrowserImportResult {
  imported: number;
  skipped: number;
  warnings: string[];
}
export interface BrowserStylePreview {
  ref: string;
  selector: string;
  styles: Record<string, string>;
}
export interface BrowserElementStyleChange {
  ref: string;
  selector: string;
  changes: Record<string, { previous: string; current: string }>;
}
export interface BrowserAnnotation {
  url: string;
  selectedText?: string;
  imageBounds?: BrowserBounds;
  elements: BrowserElement[];
  regions: BrowserBounds[];
  strokes: Array<Array<{ x: number; y: number }>>;
  comment: string;
  styleChanges?: Record<string, string>;
  elementStyleChanges?: BrowserElementStyleChange[];
  image?: BrowserImage;
}

export type BrowserCommand =
  | { action: "agent_access"; access: BrowserAgentAccessOverride }
  | { action: "open_link"; url: string; alternateTarget?: boolean }
  | {
      action: "open_file";
      path: string;
      assetPaths?: string[];
      tabId?: string;
      show?: boolean;
      readiness?: "none" | "domContentLoaded" | "load";
      timeoutMs?: number;
    }
  | { action: "create"; url?: string; profileId?: string; show?: boolean }
  | {
      action:
        | "select"
        | "close"
        | "back"
        | "forward"
        | "stop"
        | "focus"
        | "devtools"
        | "open_external";
      tabId: string;
    }
  | {
      action: "navigate";
      tabId: string;
      url: string;
      readiness?: "load" | "domContentLoaded" | "none";
      timeoutMs?: number;
    }
  | { action: "reload"; tabId: string; ignoreCache?: boolean }
  | { action: "present"; tabId: string; visible: boolean; bounds?: BrowserBounds }
  | { action: "viewport"; tabId: string; viewport: BrowserViewport }
  | { action: "appearance"; tabId: string; appearance: BrowserAppearance }
  | { action: "zoom"; tabId: string; zoom: number }
  | { action: "mute"; tabId: string; muted: boolean }
  | { action: "float"; tabId: string; floating: boolean }
  | { action: "picture_in_picture"; tabId: string; enabled: boolean }
  | { action: "history_remove"; url: string }
  | { action: "save_image"; image: BrowserImage }
  | { action: "reveal_recording"; recordingId: string }
  | { action: "clear_cookies" | "clear_cache"; profileId: string }
  | { action: "profile_create"; name: string }
  | { action: "profile_rename"; profileId: string; name: string }
  | { action: "profile_delete"; profileId: string }
  | { action: "defaults"; defaults: Partial<BrowserDefaults> }
  | { action: "import_sources" }
  | { action: "import_cookies"; sourceId: string; profileId: string }
  | { action: "screenshot"; tabId: string; fullPage?: boolean; bounds?: BrowserBounds }
  | { action: "record_start"; tabId: string; fps?: number }
  | { action: "record_stop"; tabId: string }
  | { action: "snapshot"; tabId: string; includeImage?: boolean; includeAllElements?: boolean }
  | {
      action: "click";
      tabId: string;
      ref?: string;
      selector?: string;
      locator?: string;
      x?: number;
      y?: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
      timeoutMs?: number;
    }
  | {
      action: "type";
      tabId: string;
      text: string;
      ref?: string;
      selector?: string;
      locator?: string;
      clear?: boolean;
      timeoutMs?: number;
    }
  | {
      action: "press";
      tabId: string;
      key: string;
      modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
    }
  | {
      action: "scroll";
      tabId: string;
      x?: number;
      y?: number;
      deltaX: number;
      deltaY: number;
      selector?: string;
      locator?: string;
    }
  | {
      action: "evaluate";
      tabId: string;
      expression: string;
      awaitPromise?: boolean;
      returnByValue?: boolean;
    }
  | {
      action: "wait";
      tabId: string;
      selector?: string;
      locator?: string;
      text?: string;
      urlIncludes?: string;
      timeoutMs?: number;
    }
  | { action: "annotate"; tabId: string; enabled: boolean }
  | { action: "annotation_preview"; tabId: string; changes: BrowserStylePreview[] }
  | { action: "annotation_reset"; tabId: string }
  | {
      action: "annotation_submit";
      tabId: string;
      annotation: BrowserAnnotation;
      delivery?: "renderer";
    };

export interface BrowserCommandResult {
  state: BrowserState;
  tabId?: string;
  annotation?: BrowserAnnotation;
  elementStyleChanges?: BrowserElementStyleChange[];
  image?: BrowserImage;
  snapshot?: BrowserSnapshot;
  recording?: BrowserRecording;
  importSources?: BrowserImportSource[];
  importResult?: BrowserImportResult;
  value?: unknown;
}
export type BrowserEvent =
  | { type: "state"; state: BrowserState }
  | { type: "show"; workspaceId: string; tabId: string }
  | {
      type: "shortcut";
      workspaceId: string;
      tabId: string;
      shortcut: "annotate" | "focus_address" | "reload" | "hard_reload";
    }
  | { type: "annotation"; workspaceId: string; tabId: string; annotation: BrowserAnnotation };

export const DEFAULT_BROWSER_SETTINGS: BrowserDefaults = {
  profileId: "default",
  viewport: { mode: "fill", width: 1280, height: 720 },
  appearance: "system",
  zoom: 1,
  recordingFps: 30,
  linkTarget: "browser",
  agentAccess: "allow",
  autoShow: true,
};

export const BUILT_IN_BROWSER_PROFILES: BrowserProfile[] = [
  { id: "default", name: "Default", kind: "persistent" },
  { id: "incognito", name: "Incognito", kind: "incognito" },
];
