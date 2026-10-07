// Create Images IPC. Every handler checks its renderer document first, parses
// an exact request shape second, and only then touches a store.
import { IMAGE_IMPORT_MAX_BYTES, type ImportImageResponse } from "../../../renderer/shared/images/ipc-types.js";
import { pickDefaultImageModel } from "../../../renderer/shared/images/port.js";
import type { CreateImagesServices } from "../../services/create-images/runtime.js";
import type { StudioAssetGrantOwner, StudioAssetGrants } from "../../services/studio-assets/delivery-core.js";
import {
  parseConsentRequest,
  parseCreateRequest,
  parseEmptyRequest,
  parseGetRunRequest,
  parseImportRequest,
  parseListRunsRequest,
  parseMutateRequest,
  parsePrepareRequest,
  parseRunRequest,
  parseSaveRequest,
  parseWorkflowRequest,
} from "./parse.js";

export interface CreateImagesOwner {
  /** `${webContentsId}:${documentId}`: consents are bound to exactly this document. */
  key: string;
  grants: StudioAssetGrantOwner;
}

export interface CreateImagesHandlerDependencies<Event> {
  enabled: boolean;
  handle(channel: string, listener: (event: Event, input: unknown) => unknown): void;
  owner(event: Event): CreateImagesOwner;
  services(): CreateImagesServices;
  grants: Pick<StudioAssetGrants, "issue">;
  pickImage(event: Event): Promise<Uint8Array | null>;
}

export function registerCreateImagesHandlers<Event>(deps: CreateImagesHandlerDependencies<Event>): number {
  if (!deps.enabled) return 0;
  let registered = 0;
  const handle = (channel: string, listener: (event: Event, input: unknown) => unknown) => {
    deps.handle(channel, listener);
    registered += 1;
  };
  const urls = (owner: CreateImagesOwner, assetIds: Iterable<string>): Record<string, string> => {
    const granted: Record<string, string> = {};
    for (const assetId of new Set(assetIds)) {
      try {
        granted[assetId] = deps.grants.issue(owner.grants, assetId, "thumb-512");
      } catch {
        // A collected or invalid asset simply has no URL; the UI shows its placeholder.
      }
    }
    return granted;
  };

  handle("imageWorkflows:list", async (event, input) => {
    deps.owner(event);
    parseEmptyRequest(input);
    const { workflows, coordinator } = deps.services();
    return { workflows: workflows.list(), imageCounts: await coordinator.imageCounts() };
  });

  handle("imageWorkflows:create", async (event, input) => {
    deps.owner(event);
    const request = parseCreateRequest(input);
    const services = deps.services();
    const model = pickDefaultImageModel(await services.port.listModels());
    const workflow = await services.workflows.create(request.template, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(model ? { model } : {}),
    });
    return { workflow };
  });

  handle("imageWorkflows:get", async (event, input) => {
    const owner = deps.owner(event);
    const { workflowId } = parseWorkflowRequest(input);
    const services = deps.services();
    const workflow = await services.workflows.get(workflowId);
    if (!workflow) throw new Error("This workflow no longer exists.");
    const latestOutputs = services.coordinator.latestOutputs(workflowId);
    const assetIds = [
      ...workflow.nodes.flatMap((node) => (node.type === "image-input" && node.data.assetId ? [node.data.assetId] : [])),
      ...Object.values(latestOutputs).flatMap((refs) => refs.map((ref) => ref.assetId)),
    ];
    return { workflow, latestOutputs, staleNodeIds: services.coordinator.staleNodeIds(workflow), assetUrls: urls(owner, assetIds) };
  });

  handle("imageWorkflows:save", async (event, input) => {
    deps.owner(event);
    const request = parseSaveRequest(input);
    return deps.services().workflows.save(request.workflowId, request.baseRevision, request.document);
  });

  handle("imageWorkflows:mutate", async (event, input) => {
    deps.owner(event);
    const request = parseMutateRequest(input);
    const { workflows, coordinator } = deps.services();
    if (request.op === "rename") return { ok: (await workflows.rename(request.workflowId, request.title)).ok };
    if (request.op === "duplicate") {
      const copy = await workflows.duplicate(request.workflowId);
      return copy ? { ok: true, workflowId: copy.id } : { ok: false };
    }
    // Refused while a run is starting or running; the coordinator also clears the workflow's run history and image holds.
    return { ok: (await coordinator.deleteWorkflow(request.workflowId)) === "deleted" };
  });

  handle("imageWorkflows:list-models", async (event, input) => {
    deps.owner(event);
    parseEmptyRequest(input);
    return { models: await deps.services().port.listModels() };
  });

  handle("imageWorkflows:import-image", async (event, input): Promise<ImportImageResponse> => {
    const owner = deps.owner(event);
    const request = parseImportRequest(input);
    const bytes = request.source === "dialog" ? await deps.pickImage(event) : request.data;
    if (!bytes) return { cancelled: true };
    if (bytes.byteLength > IMAGE_IMPORT_MAX_BYTES) throw new Error("Choose an image of 8 MiB or less.");
    // The store sniffs the content; a declared type must agree with it.
    const record = await deps.services().assets.put({
      bytes,
      ...(request.source === "bytes" ? { declaredMimeType: request.mimeType } : {}),
    });
    return {
      assetId: record.assetId,
      mimeType: record.mediaType,
      width: record.width,
      height: record.height,
      bytes: record.bytes,
      url: deps.grants.issue(owner.grants, record.assetId, "thumb-512"),
    };
  });

  handle("imageWorkflows:prepare-run", async (event, input) => {
    const owner = deps.owner(event);
    return deps.services().coordinator.prepare(owner.key, parsePrepareRequest(input));
  });

  handle("imageWorkflows:start-run", async (event, input) => {
    const owner = deps.owner(event);
    return deps.services().coordinator.start(owner.key, parseConsentRequest(input).consentId);
  });

  handle("imageWorkflows:cancel-run", async (event, input) => {
    deps.owner(event);
    return { ok: deps.services().coordinator.cancel(parseRunRequest(input).runId) };
  });

  handle("imageWorkflows:get-run", async (event, input) => {
    const owner = deps.owner(event);
    const snapshot = deps.services().coordinator.getRun(parseGetRunRequest(input));
    const assetIds = snapshot ? snapshot.attempts.flatMap((attempt) => attempt.output.map((ref) => ref.assetId)) : [];
    return { snapshot, assetUrls: urls(owner, assetIds) };
  });

  handle("imageWorkflows:list-runs", async (event, input) => {
    deps.owner(event);
    const request = parseListRunsRequest(input);
    return { runs: deps.services().coordinator.listRuns(request.workflowId, request.limit) };
  });

  return registered;
}
