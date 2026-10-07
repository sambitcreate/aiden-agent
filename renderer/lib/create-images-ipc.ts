import type {
  CreateWorkflowRequest,
  GetRunRequest,
  GetRunResponse,
  GetWorkflowResponse,
  ImportImageRequest,
  ImportImageResponse,
  ListModelsResponse,
  ListRunsResponse,
  ListWorkflowsResponse,
  MutateWorkflowRequest,
  MutateWorkflowResponse,
  PrepareRunRequest,
  PrepareRunResponse,
  SaveWorkflowRequest,
  SaveWorkflowResponse,
  StartRunResponse,
  WorkflowResponse,
} from "../shared/images/ipc-types";
import type { RunSnapshot } from "../shared/images/run-types";
import { invoke, onNotification } from "./ipc-bridge";

export const createImagesIpc = {
  list: () => invoke<ListWorkflowsResponse>("imageWorkflows:list", {}),
  create: (request: CreateWorkflowRequest) => invoke<WorkflowResponse>("imageWorkflows:create", request),
  get: (workflowId: string) => invoke<GetWorkflowResponse>("imageWorkflows:get", { workflowId }),
  save: (request: SaveWorkflowRequest) => invoke<SaveWorkflowResponse>("imageWorkflows:save", request),
  mutate: (request: MutateWorkflowRequest) => invoke<MutateWorkflowResponse>("imageWorkflows:mutate", request),
  listModels: () => invoke<ListModelsResponse>("imageWorkflows:list-models", {}),
  importImage: (request: ImportImageRequest) => invoke<ImportImageResponse>("imageWorkflows:import-image", request),
  prepareRun: (request: PrepareRunRequest) => invoke<PrepareRunResponse>("imageWorkflows:prepare-run", request),
  startRun: (consentId: string) => invoke<StartRunResponse>("imageWorkflows:start-run", { consentId }),
  cancelRun: (runId: string) => invoke<{ ok: boolean }>("imageWorkflows:cancel-run", { runId }),
  getRun: (request: GetRunRequest) => invoke<GetRunResponse>("imageWorkflows:get-run", request),
  listRuns: (workflowId: string, limit = 20) =>
    invoke<ListRunsResponse>("imageWorkflows:list-runs", { workflowId, limit }),
  onRunChanged: (handler: (snapshot: RunSnapshot) => void) =>
    onNotification<RunSnapshot>("imageWorkflows:run-changed", handler),
};
