/**
 * What a paired host offers for starting new work on it: its configured
 * models, the folders it lets this Mac browse, and the projects, chats and
 * Bot chats it creates. Every value comes from that host; none of it reaches
 * this Mac's own workspaces, models or files.
 */

import { isGenerationThinkingLevel, type GenerationThinkingLevel } from "../../shared/generation-thinking";

export interface HostModel {
  id: string;
  label: string;
  supportsImages: boolean;
  /** Effort levels the host runs this model at; empty when it has no choice. */
  thinkingLevels: GenerationThinkingLevel[];
  /** The level the host uses when a turn names none. */
  defaultThinkingLevel?: GenerationThinkingLevel;
  thinkingCanDisable: boolean;
  /**
   * Hidden on the host: an existing chat may still run on it, so it is listed
   * for that chat, but it is never offered as a new choice.
   */
  hidden: boolean;
}

export interface HostModelProvider {
  id: string;
  label: string;
  models: HostModel[];
}

export interface HostModelCatalog {
  providers: HostModelProvider[];
  /** The host's own default for new chats, when it has one. */
  defaults: { providerId?: string; modelId?: string };
}

export interface HostModelChoice {
  providerId: string;
  modelId: string;
}

export interface HostBrowserRoot {
  id: string;
  label: string;
  location: string;
}

export interface HostBrowserLocation {
  label: string;
  location: string;
}

export interface HostBrowserPage {
  rootId: string;
  label: string;
  breadcrumbs: HostBrowserLocation[];
  entries: Array<{ id: string; name: string; location: string }>;
  nextCursor?: string;
}

/** A single-use nonce the host minted for one browsed folder. */
export interface HostFolderSelection {
  selection: string;
  displayName: string;
}

export type HostWorkspaceCreate =
  | { mode: "scratch" }
  | { mode: "folderless"; name: string }
  | { mode: "selected-folder"; selection: string; name?: string };

export interface HostCreatedWorkspace {
  id: string;
  name: string;
}

export interface HostCreatedChat {
  id: string;
  workspaceId: string;
  botId?: string;
}

export interface HostNewChatInput {
  workspaceId: string;
  model?: HostModelChoice;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class HostResourceShapeError extends Error {
  constructor() {
    super("The host's answer was incomplete.");
    this.name = "HostResourceShapeError";
  }
}

function required(value: unknown): string {
  const result = text(value);
  if (!result) throw new HostResourceShapeError();
  return result;
}

/** Main validates every answer against the contract; this only narrows it to what the composer uses. */
export function mapHostModelCatalog(value: unknown): HostModelCatalog {
  const body = record(value);
  const providers = list(body.providers).flatMap((entry) => {
    const provider = record(entry);
    const id = text(provider.id);
    if (!id) return [];
    const models = list(provider.models).flatMap((item) => {
      const model = record(item);
      const modelId = text(model.id);
      if (!modelId) return [];
      const thinkingLevels = list(model.thinkingLevels).filter(isGenerationThinkingLevel);
      const defaultThinkingLevel = isGenerationThinkingLevel(model.defaultThinkingLevel) && thinkingLevels.includes(model.defaultThinkingLevel)
        ? model.defaultThinkingLevel
        : undefined;
      return [{
        id: modelId,
        label: text(model.label) ?? modelId,
        supportsImages: model.supportsImages === true,
        thinkingLevels,
        ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
        thinkingCanDisable: model.thinkingCanDisable !== false,
        // Hidden models stay usable by existing chats but are not offered for new ones.
        hidden: model.hidden === true,
      }];
    });
    return models.length > 0 ? [{ id, label: text(provider.label) ?? id, models }] : [];
  });
  const defaults = record(body.defaults);
  const providerId = text(defaults.providerId);
  const modelId = text(defaults.modelId);
  return { providers, defaults: providerId && modelId ? { providerId, modelId } : {} };
}

export function findHostModel(catalog: HostModelCatalog | undefined, choice: HostModelChoice | undefined): HostModel | undefined {
  if (!catalog || !choice) return undefined;
  return catalog.providers
    .find((provider) => provider.id === choice.providerId)
    ?.models.find((model) => model.id === choice.modelId);
}

/** A model a new chat may start on: listed and not hidden on the host. */
export function findOfferedHostModel(catalog: HostModelCatalog | undefined, choice: HostModelChoice | undefined): HostModel | undefined {
  const model = findHostModel(catalog, choice);
  return model && !model.hidden ? model : undefined;
}

/** The host default when it is still offered, else the first offered model. */
export function defaultHostModel(catalog: HostModelCatalog | undefined): HostModelChoice | undefined {
  if (!catalog) return undefined;
  const { providerId, modelId } = catalog.defaults;
  if (providerId && modelId && findOfferedHostModel(catalog, { providerId, modelId })) return { providerId, modelId };
  for (const provider of catalog.providers) {
    const model = provider.models.find((entry) => !entry.hidden);
    if (model) return { providerId: provider.id, modelId: model.id };
  }
  return undefined;
}

export function mapHostBrowserRoots(value: unknown): HostBrowserRoot[] {
  return list(record(value).roots).map((entry) => {
    const root = record(entry);
    return { id: required(root.id), label: text(root.label) ?? required(root.id), location: required(root.location) };
  });
}

export function mapHostBrowserPage(value: unknown): HostBrowserPage {
  const page = record(value);
  const nextCursor = text(page.nextCursor);
  return {
    rootId: required(page.rootId),
    label: text(page.label) ?? "",
    breadcrumbs: list(page.breadcrumbs).map((entry) => {
      const crumb = record(entry);
      return { label: text(crumb.label) ?? "", location: required(crumb.location) };
    }),
    entries: list(page.entries).map((entry) => {
      const item = record(entry);
      return { id: required(item.id), name: required(item.name), location: required(item.location) };
    }),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function mapHostFolderSelection(value: unknown): HostFolderSelection {
  const body = record(value);
  return { selection: required(body.selection), displayName: text(body.displayName) ?? "" };
}

export function mapHostCreatedWorkspace(value: unknown): HostCreatedWorkspace {
  const body = record(value);
  return { id: required(body.id), name: text(body.name) ?? "" };
}

export function mapHostCreatedChat(value: unknown): HostCreatedChat {
  const body = record(value);
  const botId = text(body.botId);
  return { id: required(body.id), workspaceId: required(body.workspaceId), ...(botId ? { botId } : {}) };
}
