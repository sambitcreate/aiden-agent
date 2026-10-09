// Types for the shared 0.34.1 fake driver used by the TypeScript tests.

export interface FakeToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface FakeWindow {
  pid: number;
  window_id: number;
  app_name: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  layer?: number;
  z_index: number;
  is_on_screen: boolean;
}

export interface FakeElementRow {
  role: string;
  label?: string;
  value?: string;
  frame?: { x: number; y: number; w: number; h: number };
  depth?: number;
  [key: string]: unknown;
}

export interface FakeCuaDriverOptions {
  windows?: FakeWindow[];
  apps?: Array<Record<string, unknown>>;
  elements?: (window: FakeWindow) => FakeElementRow[];
  screenshotScale?: number;
  hostBundleId?: string;
  permissions?: { accessibility: boolean; screen_recording: boolean };
  actionOverrides?: Record<
    string,
    FakeToolResult | ((args: Record<string, unknown>) => FakeToolResult)
  >;
}

export const TOOL_DEFINITIONS: Record<
  string,
  { inputSchema: Record<string, unknown>; capabilities: string[] }
>;
export const ACTION_RESULT_TOOLS: ReadonlySet<string>;
export const DEFAULT_WINDOWS: FakeWindow[];
export const DEFAULT_APPS: Array<Record<string, unknown>>;
export const DEFAULT_ELEMENTS: FakeElementRow[];

export function toolListEntries(names: readonly string[]): Array<Record<string, unknown>>;
export function toolListResult(names: readonly string[]): Record<string, unknown>;
export function argumentRefusal(name: string, args: Record<string, unknown>): FakeToolResult | null;
export function codedRefusal(
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): FakeToolResult;
export function actionResult(name: string, overrides?: Record<string, unknown>): FakeToolResult;
export function staleTokenRefusal(pid: number): FakeToolResult;
export function screenshotContextRefusal(pid: number, windowId: number): FakeToolResult;
export function elementToken(snapshotId: number, index: number): string;
export function pngHeaderBase64(width: number, height: number): string;

export class FakeSnapshotStore {
  publish(pid: number, windowId: number, withScreenshot: boolean): {
    id: number;
    invalidated: string[];
  };
  admit(name: string, args: Record<string, unknown>): FakeToolResult | null;
}

export class FakeCuaDriver {
  constructor(options?: FakeCuaDriverOptions);
  windows: FakeWindow[];
  apps: Array<Record<string, unknown>>;
  elements: (window: FakeWindow) => FakeElementRow[];
  readonly snapshots: FakeSnapshotStore;
  call(name: string, args?: Record<string, unknown>): FakeToolResult;
}
