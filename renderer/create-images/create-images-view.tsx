import * as React from "react";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Copy,
  Download,
  FolderOpen,
  HardDrive,
  ImagePlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  Check,
  ChevronDown,
  Cloud,
} from "lucide-react";
import {
  AlertDialog,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Text,
  toast,
  useSplitViewState,
} from "../components/ui";
import { appApi, createImagesApi } from "../lib/ipc";
import { clearRendererLifecycleGuard, setRendererLifecycleGuard } from "../lib/lifecycle-guard";
import {
  queryKeys,
  useCreateImagesProviderStatus,
  useCreateImagesWorkspace,
  useCreateImagesWorkflow,
  useCreateImagesWorkflows,
} from "../lib/queries";
import type {
  CreateImagesAssetGrantView,
  CreateImagesDegradedRunDiscardPlanResult,
  CreateImagesDegradedRunDiscardResult,
  CreateImagesRunHistoryPrunePlanResult,
  CreateImagesProviderConsentPlanView,
  CreateImagesRunRecoveryView,
  CreateImagesRunListResult,
  CreateImagesRunView,
  CreateImagesStorageHealthView,
  CreateImagesWorkflowLoadResult,
  CreateImagesWorkflowListResult,
  CreateImagesWorkflowMutationResult,
  CreateImagesWorkflowRecoveryView,
  CreateImagesWorkflowSummary,
  CreateImagesWorkspaceStatus,
} from "../shared/create-images/ipc";
import {
  enumerateWorkflowDownstreamPaths,
  isWorkflowDownstreamPathExplicit,
  planWorkflowExecution,
  WorkflowPlanError,
  type WorkflowRunScope,
} from "../shared/create-images/execution";
import { CREATE_IMAGES_NODE_DEFINITIONS } from "../shared/create-images/ports";
import type { WorkflowDocumentV1 } from "../shared/create-images/schema";
import {
  CREATE_IMAGES_WORKFLOW_TEMPLATES,
  type CreateImagesWorkflowTemplateId,
} from "../shared/create-images/templates";
import {
  CREATE_IMAGES_PROVIDER_STATUS_VERSION,
  type CreateImagesExecutionMode,
  type CreateImagesProviderStatus,
} from "../shared/create-images/providers";
import { createImagesFixture } from "./fixtures";
import {
  registerCreateImagesNavigationGuard,
  requestCreateImagesNavigation,
} from "./navigation-guard";
import {
  AssetPreviewLifecycleManager,
  AssetPreviewLoadError,
  deferAssetPreviewLifecycleDisposal,
} from "./asset-preview-lifecycle-core";
import {
  deferWorkflowAutosaveControllerDisposal,
  WorkflowAutosaveController,
  type CreateImagesAutosaveStatus,
} from "./workflow-autosave-core";
import { WorkflowCanvas } from "./workflow-canvas";
import {
  createImagesRunOutputAssetIds,
  createImagesRunAssetOwners,
  createImagesSelectedRunSnapshotTransition,
  createImagesRunSubscriptionController,
  isCreateImagesRunAmbiguityRequestCurrent,
  isCreateImagesRunHistoryRequestCurrent,
  isCreateImagesRunRecoveryRequestCurrent,
  reconcileCreateImagesRunMutation,
  reconcileCreateImagesRunState,
  removeCreateImagesRunRecord,
  type CreateImagesRendererRunState,
} from "./run-ui-adapter";
import {
  createImagesRunConfirmationViewModel,
  createImagesDegradedRunDiscardRequest,
  type CreateImagesRunConfirmationViewModel,
  type CreateImagesRunErrorAction,
} from "./run-ui-core";
import {
  CreateImagesResolveRunAmbiguityDialog,
  CreateImagesDiscardDegradedRunDialog,
  CreateImagesRunConfirmationDialog,
  CreateImagesStopRunDialog,
  type CreateImagesRunHistoryDetailState,
} from "./run-ui";
import {
  createImagesRunScopeForPathChoice,
  type CreateImagesDownstreamPathChoiceView,
} from "./run-path-core";
import "./create-images.css";

const WORKFLOW_UPDATED_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function updatedLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recovery needed";
  return WORKFLOW_UPDATED_FORMATTER.format(timestamp);
}

function storageBytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function mutationMessage(result: CreateImagesWorkflowMutationResult, fallback: string): string {
  if (result.status === "unavailable") return result.message;
  if (result.status === "conflict") return "The workflow changed in another Aiden window.";
  if (result.status === "not-found") return "The workflow no longer exists.";
  return fallback;
}

type ReadyCreateImagesWorkspace = Extract<CreateImagesWorkspaceStatus, { status: "ready" }>;

function workspaceLastSyncedLabel(value?: string): string {
  return value ? `Last synced ${updatedLabel(value)}` : "Not synced yet";
}

function CreateImagesWorkspaceSetup({
  loading,
  status,
  actionError,
  busy,
  onChoose,
  onRetry,
  onBack,
}: {
  loading?: boolean;
  status?: CreateImagesWorkspaceStatus;
  actionError?: string;
  busy?: string;
  onChoose: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const chooseRef = React.useRef<HTMLButtonElement | null>(null);
  const unavailable =
    !loading && (!status || status.status === "unavailable" || Boolean(actionError));
  const statusToken = loading ? "loading" : unavailable ? "unavailable" : "unconfigured";

  React.useEffect(() => {
    headingRef.current?.focus();
  }, [statusToken]);

  React.useEffect(() => {
    if (actionError) chooseRef.current?.focus();
  }, [actionError]);

  const unavailableMessage =
    status?.status === "unavailable"
      ? status.message
      : "Aiden could not read this image workspace.";
  const rememberedName = status?.status === "unavailable" ? status.displayName : undefined;

  return (
    <main className="create-images-workspace-setup" aria-labelledby="create-images-workspace-title">
      <div className="create-images-workspace-setup-card">
        <div className="create-images-workspace-mark" aria-hidden="true">
          {loading ? <Loader2 className="create-images-workspace-spinner" /> : <FolderOpen />}
        </div>
        <p className="create-images-workspace-eyebrow">
          <HardDrive aria-hidden="true" /> Device-local image workspace
        </p>
        <h2
          ref={headingRef}
          id="create-images-workspace-title"
          tabIndex={-1}
          className="create-images-workspace-title"
        >
          {loading
            ? "Checking your image workspace…"
            : unavailable
              ? "Your image workspace needs attention"
              : "Set up your image workspace"}
        </h2>
        <p className="create-images-workspace-copy">
          {loading
            ? "Aiden is checking the local folder that keeps your imported and generated images easy to find."
            : unavailable
              ? unavailableMessage
              : "Choose or create a local folder for imported and generated images. Aiden keeps recoverable workflow data in its protected local store, and you can change this Finder folder later."}
        </p>
        {rememberedName ? (
          <p className="create-images-workspace-remembered" title={rememberedName}>
            Last known workspace: <strong>{rememberedName}</strong>
          </p>
        ) : null}
        {actionError ? (
          <p className="create-images-workspace-error" role="alert">
            {actionError}
          </p>
        ) : null}
        {!loading ? (
          <div className="create-images-workspace-actions">
            <Button
              ref={chooseRef}
              variant="accent"
              size="large"
              disabled={Boolean(busy)}
              onClick={onChoose}
            >
              {busy === "workspace-choose" ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              {unavailable ? "Choose a different folder" : "Choose workspace folder"}
            </Button>
            {unavailable ? (
              <Button variant="filled" size="large" disabled={Boolean(busy)} onClick={onRetry}>
                {busy === "workspace-retry" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Try again
              </Button>
            ) : null}
            <Button variant="transparent" size="small" disabled={Boolean(busy)} onClick={onBack}>
              <ArrowLeft /> Back to Aiden
            </Button>
          </div>
        ) : (
          <div className="create-images-workspace-loading" role="status" aria-live="polite">
            <Loader2 className="animate-spin" aria-hidden="true" /> Preparing local workspace
            access…
          </div>
        )}
        <div className="create-images-workspace-note">
          <Check aria-hidden="true" />
          <span>
            Aiden keeps workspace names and sync status visible without exposing local paths.
          </span>
        </div>
      </div>
    </main>
  );
}

function CreateImagesWorkspaceMenu({
  workspace,
  busy,
  triggerRef,
  onOpen,
  onSync,
  onChange,
}: {
  workspace: ReadyCreateImagesWorkspace;
  busy?: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onSync: () => void;
  onChange: () => void;
}) {
  const blocked = Boolean(busy);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          size="small"
          variant="transparent"
          className="create-images-workspace-trigger max-w-[15rem]"
          aria-label={`Image workspace: ${workspace.displayName}`}
        >
          <FolderOpen aria-hidden="true" />
          <span className="create-images-workspace-trigger-name">{workspace.displayName}</span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="create-images-workspace-menu-content w-[min(20rem,calc(100vw-1.5rem))]"
      >
        <DropdownMenuLabel>Image workspace</DropdownMenuLabel>
        <div className="create-images-workspace-menu-summary">
          <strong className="truncate text-small-strong text-primary">
            {workspace.displayName}
          </strong>
          <span>
            {workspace.importedAssetCount} imported · {workspace.generatedAssetCount} generated
          </span>
          <span>{workspaceLastSyncedLabel(workspace.lastSyncedAt)}</span>
          {workspace.conflictCount > 0 ? (
            <span className="create-images-workspace-menu-conflict" role="status">
              {workspace.conflictCount} conflict{workspace.conflictCount === 1 ? "" : "s"} to review
            </span>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={blocked} onSelect={onOpen}>
          <FolderOpen aria-hidden="true" /> Open in Finder
        </DropdownMenuItem>
        <DropdownMenuItem disabled={blocked} onSelect={onSync}>
          {busy === "workspace-sync" ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            <Cloud aria-hidden="true" />
          )}
          Sync now
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={blocked} onSelect={onChange}>
          <RefreshCw aria-hidden="true" /> Change workspace folder
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ReadyDegradedRunDiscardPlan = Extract<
  CreateImagesDegradedRunDiscardPlanResult,
  { status: "ready" }
>;

function useDegradedRunDiscard({
  onDiscarded,
}: {
  onDiscarded(
    result: Extract<CreateImagesDegradedRunDiscardResult, { status: "discarded" }>,
    plan: ReadyDegradedRunDiscardPlan,
  ): void | Promise<void>;
}) {
  const [plan, setPlan] = React.useState<ReadyDegradedRunDiscardPlan>();
  const [reviewed, setReviewed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const request = React.useCallback(
    async (runId: string, trigger: HTMLButtonElement) => {
      if (busy) return;
      returnFocusRef.current = trigger;
      setReviewed(false);
      setBusy(true);
      try {
        const result = await createImagesApi.planDegradedRunDiscard({ runId });
        if (!mountedRef.current) return;
        if (result.status === "ready") {
          setPlan(result);
        } else if (result.status === "recoverable") {
          toast.info(
            "A verified recovery source exists. Recover this record instead of discarding it.",
          );
        } else if (result.status === "not-degraded") {
          toast.info("This run record is healthy and cannot be discarded from recovery tools.");
        } else if (result.status === "not-found") {
          toast.error("The degraded run record no longer exists.");
        } else {
          toast.error(result.message);
        }
      } catch {
        if (mountedRef.current) toast.error("Aiden could not prepare a safe discard summary.");
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy],
  );

  const close = React.useCallback(() => {
    if (busy) return;
    setPlan(undefined);
    setReviewed(false);
  }, [busy]);

  const confirm = React.useCallback(async () => {
    if (!plan || !reviewed || busy) return;
    const request = createImagesDegradedRunDiscardRequest(plan, reviewed);
    if (!request) return;
    setBusy(true);
    try {
      const result = await createImagesApi.discardDegradedRun(request);
      if (!mountedRef.current) return;
      if (result.status === "discarded") {
        await onDiscarded(result, plan);
        if (!mountedRef.current) return;
        setPlan(undefined);
        setReviewed(false);
        toast.success(
          `Permanently discarded the irrecoverable run record and released ${result.releasedAssetCount} retained image or asset reference${result.releasedAssetCount === 1 ? "" : "s"}, which may include imported inputs and generated outputs.`,
        );
      } else if (result.status === "conflict") {
        setPlan(undefined);
        setReviewed(false);
        toast.error("The run record changed. Review a fresh discard summary before confirming.");
      } else if (result.status === "recoverable") {
        setPlan(undefined);
        setReviewed(false);
        toast.info("A verified recovery source is now available, so discard was refused.");
      } else if (result.status === "not-degraded") {
        setPlan(undefined);
        setReviewed(false);
        toast.info("This run record is no longer degraded, so discard was refused.");
      } else if (result.status === "not-found") {
        setPlan(undefined);
        setReviewed(false);
        toast.error("The degraded run record no longer exists.");
      } else {
        toast.error(result.message);
      }
    } catch {
      if (mountedRef.current) toast.error("Aiden could not discard the run record safely.");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, onDiscarded, plan, reviewed]);

  return { plan, reviewed, busy, returnFocusRef, request, close, confirm, setReviewed };
}

interface PreparedRun {
  scope?: WorkflowRunScope;
  workflowId: string;
  workflowRevision: number;
  workflowSnapshot: WorkflowDocumentV1;
  executionMode: CreateImagesExecutionMode;
  providerConsent?: CreateImagesProviderConsentPlanView;
  model: CreateImagesRunConfirmationViewModel;
  downstreamPathSelection?: {
    startNodeId: string;
    startNodeLabel: string;
    choices: readonly CreateImagesDownstreamPathChoiceView[];
    selectedChoiceId?: string;
    truncated: boolean;
    overflowReason?: "choice-limit" | "search-budget";
    unavailablePathCount: number;
  };
}

function runNodeLabel(document: WorkflowDocumentV1, nodeId: string): string {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  return node ? `${CREATE_IMAGES_NODE_DEFINITIONS[node.type].title} · ${node.id}` : nodeId;
}

function downstreamPathDetail(document: WorkflowDocumentV1, nodeIds: readonly string[]): string {
  const labels = nodeIds.map((nodeId) => runNodeLabel(document, nodeId));
  if (labels.length <= 4) return labels.join(" → ");
  return `${labels[0]} → ${labels[1]} → … ${labels.length - 3} more → ${labels[labels.length - 1]}`;
}

function downstreamPathChoiceViews(
  document: WorkflowDocumentV1,
  startNodeId: string,
): NonNullable<PreparedRun["downstreamPathSelection"]> {
  const result = enumerateWorkflowDownstreamPaths(document, startNodeId);
  const executableChoices = result.choices.filter((choice) =>
    isWorkflowDownstreamPathExplicit(document, startNodeId, choice.downstreamPath),
  );
  return {
    startNodeId,
    startNodeLabel: runNodeLabel(document, startNodeId),
    choices: executableChoices.map((choice, index) => ({
      id: choice.id,
      downstreamPath: [...choice.downstreamPath],
      title: `Path ${index + 1} · to ${runNodeLabel(document, choice.terminalNodeId)}`,
      detail: `${choice.downstreamPath.length} downstream node${choice.downstreamPath.length === 1 ? "" : "s"} · ${downstreamPathDetail(document, choice.downstreamPath)}`,
    })),
    truncated: result.truncated,
    unavailablePathCount: result.choices.length - executableChoices.length,
    ...(result.overflowReason ? { overflowReason: result.overflowReason } : {}),
  };
}

function runScopeView(workflow: WorkflowDocumentV1, scope: WorkflowRunScope) {
  const plan = planWorkflowExecution(workflow, scope);
  return {
    plan,
    scopeView:
      scope.kind === "all"
        ? ({ kind: "all", includedNodeCount: plan.orderedNodeIds.length } as const)
        : ({
            kind: "from-node",
            startNodeId: scope.nodeId,
            startNodeLabel: runNodeLabel(plan.snapshot, scope.nodeId),
            includedNodeCount: plan.orderedNodeIds.length,
            downstreamPathLabels: (scope.downstreamPath ?? []).map((nodeId) =>
              runNodeLabel(plan.snapshot, nodeId),
            ),
          } as const),
  };
}

function prepareLocalMockRun(workflow: WorkflowDocumentV1, scope: WorkflowRunScope): PreparedRun {
  const { plan, scopeView } = runScopeView(workflow, scope);
  const included = new Set(plan.orderedNodeIds);
  const nodes = plan.snapshot.nodes.filter((node) => included.has(node.id));
  const generationNodes = nodes.filter((node) => node.type === "generate-image");
  const sizes = [...new Set(generationNodes.map((node) => node.data.imageSize))];
  const outputCount = generationNodes.reduce((total, node) => total + node.data.count, 0);
  return {
    scope,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    workflowSnapshot: plan.snapshot,
    executionMode: "local-mock",
    model: createImagesRunConfirmationViewModel({
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      workflowRevision: workflow.revision,
      scope: scopeView,
      executionMode: "local-mock",
      providerLabel: "Aiden local mock",
      modelLabel: "Deterministic Phase 3",
      remoteRequestCount: generationNodes.length,
      outputCount,
      imageSizeLabel:
        sizes.length === 1 ? sizes[0]! : sizes.length > 1 ? "Mixed sizes" : "No image output",
      qualityLabel: "Deterministic preview",
      referenceImageCount: nodes.filter(
        (node) => node.type === "image-input" && Boolean(node.data.assetId),
      ).length,
      sendsPrompt: nodes.some((node) => node.type === "prompt"),
      estimate: {
        kind: "mock",
        amount: 0,
        currency: "USD",
        estimatedAt: new Date().toISOString(),
        sourceLabel: "Deterministic Phase 3 mock",
      },
    }),
  };
}

function prepareGeminiRun(
  workflow: WorkflowDocumentV1,
  scope: WorkflowRunScope,
  consent: CreateImagesProviderConsentPlanView,
): PreparedRun {
  const { plan, scopeView } = runScopeView(workflow, scope);
  const included = new Set(plan.orderedNodeIds);
  const generationNodes = plan.snapshot.nodes.filter(
    (node): node is Extract<(typeof plan.snapshot.nodes)[number], { type: "generate-image" }> =>
      included.has(node.id) && node.type === "generate-image",
  );
  const sizes = [...new Set(generationNodes.map((node) => node.data.imageSize))];
  return {
    scope,
    workflowId: workflow.id,
    workflowRevision: workflow.revision,
    workflowSnapshot: plan.snapshot,
    executionMode: "gemini",
    providerConsent: consent,
    model: createImagesRunConfirmationViewModel({
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      workflowRevision: workflow.revision,
      scope: scopeView,
      executionMode: "cloud",
      providerLabel: consent.providerLabel,
      modelLabel: consent.modelLabel,
      remoteRequestCount: consent.accounting.initialRequestCount,
      outputCount: consent.accounting.expectedOutputCount,
      imageSizeLabel:
        sizes.length === 1 ? sizes[0]! : sizes.length > 1 ? "Mixed sizes" : "No image output",
      qualityLabel: "Provider-validated output",
      referenceImageCount: consent.accounting.referenceImageCount,
      sendsPrompt: consent.accounting.promptBytes > 0,
      estimate:
        consent.estimate.kind === "best-effort" &&
        consent.estimate.amountMicros !== undefined &&
        consent.estimate.currency
          ? {
              kind: "best-effort",
              amount: consent.estimate.amountMicros / 1_000_000,
              currency: consent.estimate.currency,
              estimatedAt: consent.estimate.estimatedAt,
              sourceLabel: "Main-owned Gemini estimate snapshot",
            }
          : {
              kind: "unavailable",
              estimatedAt: consent.estimate.estimatedAt,
              sourceLabel: "Google Gemini pricing was not verified for this request",
            },
    }),
  };
}

function prepareGeminiPathChoice(
  workflow: WorkflowDocumentV1,
  scope: Extract<WorkflowRunScope, { kind: "from-node" }>,
): PreparedRun {
  const local = prepareLocalMockRun(workflow, scope);
  const plan = planWorkflowExecution(workflow, scope);
  const generationNodes = plan.snapshot.nodes.filter(
    (node): node is Extract<(typeof plan.snapshot.nodes)[number], { type: "generate-image" }> =>
      plan.orderedNodeIds.includes(node.id) && node.type === "generate-image",
  );
  return {
    ...local,
    executionMode: "gemini",
    model: createImagesRunConfirmationViewModel({
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      workflowRevision: workflow.revision,
      scope: {
        kind: "from-node",
        startNodeId: scope.nodeId,
        startNodeLabel: runNodeLabel(plan.snapshot, scope.nodeId),
        includedNodeCount: plan.orderedNodeIds.length,
        downstreamPathLabels: [],
      },
      executionMode: "cloud",
      providerLabel: "Google Gemini",
      modelLabel: "Choose an exact downstream path",
      remoteRequestCount: generationNodes.length,
      outputCount: generationNodes.reduce((total, node) => total + node.data.count, 0),
      imageSizeLabel: "Calculated after path selection",
      qualityLabel: "Provider-validated output",
      referenceImageCount: plan.snapshot.assetRefs.length,
      sendsPrompt: true,
      estimate: {
        kind: "unavailable",
        estimatedAt: new Date().toISOString(),
        sourceLabel: "Select a path to create a main-owned consent plan",
      },
    }),
  };
}

export function CreateImagesIndexView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const split = useSplitViewState();
  const workspace = useCreateImagesWorkspace();
  const workspaceReady = workspace.data?.status === "ready";
  const workflows = useCreateImagesWorkflows(workspaceReady);
  const [storageHealth, setStorageHealth] = React.useState<CreateImagesStorageHealthView>();
  const [busy, setBusy] = React.useState<string>();
  const [workspaceActionError, setWorkspaceActionError] = React.useState<string>();
  const workspaceMenuRef = React.useRef<HTMLButtonElement | null>(null);
  const previousWorkspaceReadyRef = React.useRef(workspaceReady);
  const [renameTarget, setRenameTarget] = React.useState<CreateImagesWorkflowSummary>();
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<CreateImagesWorkflowSummary>();
  const [assetCleanupPlan, setAssetCleanupPlan] = React.useState<
    Extract<Awaited<ReturnType<typeof createImagesApi.planAssetCleanup>>, { status: "ready" }>
  >();
  const [nodeBananaImport, setNodeBananaImport] = React.useState<
    Extract<Awaited<ReturnType<typeof createImagesApi.importNodeBanana>>, { status: "imported" }>
  >();

  React.useEffect(() => {
    if (workspaceReady && !previousWorkspaceReadyRef.current) {
      requestAnimationFrame(() => workspaceMenuRef.current?.focus());
    }
    previousWorkspaceReadyRef.current = workspaceReady;
  }, [workspaceReady]);

  const chooseWorkspace = React.useCallback(async () => {
    if (busy) return;
    setWorkspaceActionError(undefined);
    setBusy("workspace-choose");
    try {
      const result = await createImagesApi.chooseWorkspace();
      if (result.status === "canceled") return;
      if (result.status !== "ready") {
        setWorkspaceActionError(result.message);
        await workspace.refetch();
        return;
      }
      queryClient.setQueryData(queryKeys.createImagesWorkspace, result.workspace);
      await queryClient.invalidateQueries({ queryKey: queryKeys.createImagesWorkflows });
    } catch {
      setWorkspaceActionError(
        "Aiden could not choose that folder. Try again or choose another folder.",
      );
    } finally {
      setBusy(undefined);
    }
  }, [busy, queryClient, workspace]);

  const retryWorkspace = React.useCallback(async () => {
    if (busy) return;
    setWorkspaceActionError(undefined);
    setBusy("workspace-retry");
    try {
      await workspace.refetch();
    } catch {
      setWorkspaceActionError("Aiden could not check the image workspace. Try again.");
    } finally {
      setBusy(undefined);
    }
  }, [busy, workspace]);

  const openWorkspace = React.useCallback(async () => {
    if (busy) return;
    setBusy("workspace-open");
    try {
      const result = await createImagesApi.openWorkspace();
      if (result.status === "opened") toast.success("Opened the image workspace in Finder.");
      else if (result.status === "unavailable") toast.error(result.message);
      else toast.info("Choose an image workspace folder first.");
    } catch {
      toast.error("Aiden could not open the image workspace in Finder.");
    } finally {
      setBusy(undefined);
    }
  }, [busy]);

  const syncWorkspace = React.useCallback(async () => {
    if (busy) return;
    setBusy("workspace-sync");
    try {
      const result = await createImagesApi.syncWorkspace();
      if (result.status === "synced") {
        queryClient.setQueryData(queryKeys.createImagesWorkspace, result.workspace);
        await queryClient.invalidateQueries({ queryKey: queryKeys.createImagesWorkflows });
        toast.success("Image workspace synced.");
      } else if (result.status === "unavailable") {
        toast.error(result.message);
        await workspace.refetch();
      } else {
        toast.info("Choose an image workspace folder first.");
      }
    } catch {
      toast.error("Aiden could not sync the image workspace.");
    } finally {
      setBusy(undefined);
    }
  }, [busy, queryClient, workspace]);

  const backToAiden = React.useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  const refreshStorageHealth = React.useCallback(async () => {
    const health = await createImagesApi.storageHealth();
    setStorageHealth(health);
  }, []);

  const degradedDiscard = useDegradedRunDiscard({
    onDiscarded: async (_result, plan) => {
      if (plan.workflowId) {
        queryClient.removeQueries({
          queryKey: queryKeys.createImagesRuns(plan.workflowId),
          exact: true,
        });
      }
      await refreshStorageHealth();
    },
  });

  React.useEffect(() => {
    if (!workspaceReady) return;
    let disposed = false;
    void createImagesApi
      .storageHealth()
      .then((health) => {
        if (!disposed) setStorageHealth(health);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [workspaceReady]);

  const refresh = React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.createImagesWorkflows }),
    [queryClient],
  );

  const createWorkflow = React.useCallback(
    async (template: CreateImagesWorkflowTemplateId) => {
      if (busy || !workspaceReady) return;
      setBusy(`create-${template}`);
      try {
        const result = await createImagesApi.create({ template });
        if (result.status !== "saved") {
          toast.error(mutationMessage(result, "Aiden could not create the workflow."));
          return;
        }
        await refresh();
        await navigate({
          to: "/create-images/$workflowId",
          params: { workflowId: result.workflow.id },
        });
      } catch {
        toast.error("Aiden could not create the workflow.");
      } finally {
        setBusy(undefined);
      }
    },
    [busy, navigate, refresh, workspaceReady],
  );

  const duplicateWorkflow = React.useCallback(
    async (workflow: CreateImagesWorkflowSummary) => {
      if (busy) return;
      setBusy(`duplicate-${workflow.id}`);
      try {
        const result = await createImagesApi.duplicate({
          workflowId: workflow.id,
          expectedRevision: workflow.revision,
        });
        if (result.status !== "saved") {
          toast.error(mutationMessage(result, "Aiden could not duplicate the workflow."));
          return;
        }
        await refresh();
        await navigate({
          to: "/create-images/$workflowId",
          params: { workflowId: result.workflow.id },
        });
      } catch {
        toast.error("Aiden could not duplicate the workflow.");
      } finally {
        setBusy(undefined);
      }
    },
    [busy, navigate, refresh],
  );

  const importArchive = React.useCallback(async () => {
    if (busy) return;
    setBusy("import-archive");
    try {
      const result = await createImagesApi.importArchive();
      if (result.status === "canceled") return;
      if (result.status !== "imported") {
        toast.error(result.message);
        return;
      }
      await refresh();
      toast.success(
        `Imported ${result.sourceFileName} with ${result.importedAssetCount} image${result.importedAssetCount === 1 ? "" : "s"}.`,
      );
      await navigate({
        to: "/create-images/$workflowId",
        params: { workflowId: result.workflow.id },
      });
    } catch {
      toast.error("Aiden could not import the workflow archive.");
    } finally {
      setBusy(undefined);
    }
  }, [busy, navigate, refresh]);

  const importNodeBanana = React.useCallback(async () => {
    if (busy) return;
    setBusy("import-node-banana");
    try {
      const result = await createImagesApi.importNodeBanana();
      if (result.status === "canceled") return;
      if (result.status !== "imported") {
        toast.error(result.message);
        return;
      }
      await refresh();
      setNodeBananaImport(result);
      toast.success(
        `Imported ${result.sourceFileName} with ${result.report.importedNodeCount} mapped node${result.report.importedNodeCount === 1 ? "" : "s"}.`,
      );
    } catch {
      toast.error("Aiden could not import the Node Banana workflow safely.");
    } finally {
      setBusy(undefined);
    }
  }, [busy, refresh]);

  const exportArchive = React.useCallback(
    async (workflow: CreateImagesWorkflowSummary) => {
      if (busy) return;
      setBusy(`export-${workflow.id}`);
      try {
        const result = await createImagesApi.exportArchive({
          workflowId: workflow.id,
          expectedRevision: workflow.revision,
        });
        if (result.status === "canceled") return;
        if (result.status === "exported") {
          toast.success(
            `Exported ${result.fileName} with ${result.assetCount} image${result.assetCount === 1 ? "" : "s"}.`,
          );
          return;
        }
        if (result.status === "conflict") {
          toast.error("The workflow changed before export. Refresh and try again.");
          await refresh();
          return;
        }
        toast.error(
          result.status === "not-found" ? "The workflow no longer exists." : result.message,
        );
      } catch {
        toast.error("Aiden could not export the workflow archive.");
      } finally {
        setBusy(undefined);
      }
    },
    [busy, refresh],
  );

  const ready: Extract<CreateImagesWorkflowListResult, { status: "ready" }> | undefined =
    workflows.data?.status === "ready" ? workflows.data : undefined;
  return (
    <section
      className="relative h-full overflow-y-auto bg-background"
      aria-labelledby="create-images-title"
    >
      <header
        className="drag-region sticky top-0 z-20 flex h-13 items-center border-b border-separator bg-background/88 px-4 backdrop-blur-xl transition-[padding] duration-300 motion-reduce:transition-none"
        style={{ paddingLeft: split?.collapsed ? 142 : undefined }}
      >
        <div className="min-w-0 flex-1">
          <h1 id="create-images-title" className="truncate text-strong font-medium">
            Create Images
          </h1>
        </div>
        {workspaceReady && workspace.data?.status === "ready" ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <CreateImagesWorkspaceMenu
              workspace={workspace.data}
              busy={busy}
              triggerRef={workspaceMenuRef}
              onOpen={() => void openWorkspace()}
              onSync={() => void syncWorkspace()}
              onChange={() => void chooseWorkspace()}
            />
            <Button
              size="small"
              variant="accent"
              disabled={Boolean(busy)}
              onClick={() => void createWorkflow("blank")}
            >
              {busy === "create-blank" ? <Loader2 className="animate-spin" /> : <Plus />} New
              workflow
            </Button>
          </div>
        ) : null}
      </header>

      {workspace.isLoading ? (
        <CreateImagesWorkspaceSetup
          loading
          busy={busy}
          onChoose={() => undefined}
          onRetry={() => undefined}
          onBack={backToAiden}
        />
      ) : !workspaceReady ? (
        <CreateImagesWorkspaceSetup
          status={workspace.data}
          actionError={workspaceActionError}
          busy={busy}
          onChoose={() => void chooseWorkspace()}
          onRetry={() => void retryWorkspace()}
          onBack={backToAiden}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-5xl flex-col px-6 pb-12 pt-10 max-[700px]:px-4">
          <div className="max-w-2xl">
            <div className="mb-4 flex size-11 items-center justify-center rounded-card bg-control text-secondary shadow-control">
              <ImagePlus className="size-5" aria-hidden="true" />
            </div>
            <h2 className="text-heading1 font-semibold tracking-[-0.025em] text-primary">
              Build images as workflows.
            </h2>
            <Text as="p" color="secondary" className="mt-3 max-w-xl leading-relaxed">
              Connect prompts, reference images, generation, and outputs on a durable visual canvas.
              Aiden protects workflow data locally while keeping image copies easy to browse in
              Finder.
            </Text>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                variant="accent"
                disabled={Boolean(busy)}
                onClick={() => void createWorkflow("starter")}
              >
                {busy === "create-starter" ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Start with a workflow
              </Button>
              <Button
                variant="filled"
                disabled={Boolean(busy)}
                onClick={() => void createWorkflow("blank")}
              >
                <Boxes /> Blank canvas
              </Button>
              <Button
                variant="transparent"
                disabled={Boolean(busy)}
                onClick={() => void importArchive()}
              >
                {busy === "import-archive" ? <Loader2 className="animate-spin" /> : <Upload />}
                Import .aiden-images
              </Button>
              <Button
                variant="transparent"
                disabled={Boolean(busy)}
                onClick={() => void importNodeBanana()}
              >
                {busy === "import-node-banana" ? <Loader2 className="animate-spin" /> : <Upload />}
                Import Node Banana JSON
              </Button>
            </div>
          </div>

          {storageHealth && storageHealth.runIndex.status !== "healthy" ? (
            <div
              className="mt-7 flex max-w-2xl items-start gap-3 rounded-card border border-support-warning/25 bg-support-warning/[0.07] px-4 py-3"
              role={storageHealth.runIndex.status === "recovered" ? "status" : "alert"}
            >
              {storageHealth.runIndex.status === "recovered" ? (
                <RefreshCw
                  className="mt-0.5 size-4 shrink-0 text-support-warning"
                  aria-hidden="true"
                />
              ) : (
                <ShieldAlert
                  className="mt-0.5 size-4 shrink-0 text-support-warning"
                  aria-hidden="true"
                />
              )}
              <div>
                <h3 className="text-small-strong text-primary">
                  {storageHealth.runIndex.status === "recovered"
                    ? "Run history index recovered"
                    : storageHealth.runIndex.status === "unsafe"
                      ? "Run history index is read-only"
                      : "Run history needs attention"}
                </h3>
                <p className="mt-1 text-small text-secondary">
                  {storageHealth.runIndex.status === "recovered"
                    ? "Aiden rebuilt the local index from durable run journals. No image work was repeated."
                    : storageHealth.runIndex.status === "unsafe"
                      ? "Aiden preserved an unsafe or newer index without exposing its contents. Update Aiden before managing run history."
                      : "Some durable run records need recovery before Aiden can manage their history safely."}
                </p>
              </div>
            </div>
          ) : null}

          {storageHealth && storageHealth.runIndex.degradedRecords.length > 0 ? (
            <section
              className="mt-4 max-w-2xl rounded-card border border-field bg-popover/65 p-4"
              aria-labelledby="create-images-degraded-runs-title"
            >
              <div className="flex items-start gap-3">
                <ShieldAlert
                  className="mt-0.5 size-4 shrink-0 text-support-warning"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <h3
                    id="create-images-degraded-runs-title"
                    className="text-small-strong text-primary"
                  >
                    Degraded run records
                  </h3>
                  <p className="mt-1 text-small leading-relaxed text-secondary">
                    These device-local journals need recovery or explicit review. Aiden never reruns
                    their work automatically.
                  </p>
                </div>
              </div>
              <ul className="mt-3 grid gap-2" aria-label="Degraded Create Images run records">
                {storageHealth.runIndex.degradedRecords.map((record) => (
                  <li
                    key={record.runId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-well px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <strong className="block truncate text-small text-primary">
                        {record.association === "unassociated"
                          ? "Unassociated run record"
                          : "Workflow run record"}
                      </strong>
                      <span className="mt-0.5 block text-mini text-tertiary">
                        {record.status === "unsafe" ? "Unsafe journal" : "Recovery required"} · run
                        ID {record.runId}
                      </span>
                    </div>
                    {record.discardEligible ? (
                      <Button
                        size="small"
                        variant="transparent"
                        disabled={degradedDiscard.busy}
                        onClick={(event) =>
                          void degradedDiscard.request(record.runId, event.currentTarget)
                        }
                      >
                        <Trash2 /> Review permanent discard
                      </Button>
                    ) : (
                      <span className="text-mini text-secondary">Verified recovery available</span>
                    )}
                  </li>
                ))}
              </ul>
              {storageHealth.runIndex.degradedRecordsTruncated ? (
                <p className="mt-3 text-mini text-tertiary" role="status">
                  Showing 100 of {storageHealth.runIndex.degradedRecordCount} degraded records.
                  Clear or recover visible records, then refresh to review the next bounded set.
                </p>
              ) : null}
            </section>
          ) : null}

          <div className="mt-12 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-strong font-medium text-primary">Your workflows</h2>
              <p className="mt-1 text-small text-secondary">
                Autosaved locally and ordered by recent activity.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-pill bg-control px-2 py-1 text-mini text-tertiary">
                <HardDrive className="mr-1 inline size-3" aria-hidden="true" /> Device-local
              </span>
              {storageHealth && storageHealth.orphanAssetCount > 0 ? (
                <Button
                  size="small"
                  variant="transparent"
                  disabled={Boolean(busy)}
                  onClick={async () => {
                    if (busy) return;
                    setBusy("plan-asset-cleanup");
                    try {
                      const result = await createImagesApi.planAssetCleanup();
                      if (result.status === "ready") setAssetCleanupPlan(result);
                      else if (result.status === "empty")
                        toast.info("No unused images are old enough to clean up yet.");
                      else toast.error(result.message);
                    } catch {
                      toast.error("Aiden could not safely inspect unused image storage.");
                    } finally {
                      setBusy(undefined);
                    }
                  }}
                >
                  {busy === "plan-asset-cleanup" ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                  Review cleanup
                </Button>
              ) : null}
              <Button
                iconOnly
                size="small"
                variant="transparent"
                aria-label="Refresh workflows and run health"
                onClick={() => {
                  void workflows.refetch();
                  void refreshStorageHealth().catch(() =>
                    toast.error("Aiden could not refresh device-local run health."),
                  );
                }}
              >
                <RefreshCw className={workflows.isFetching ? "animate-spin" : undefined} />
              </Button>
            </div>
          </div>

          {workflows.isLoading ? (
            <div className="mt-8 flex items-center gap-2 text-small text-secondary" role="status">
              <Loader2 className="size-4 animate-spin" /> Loading workflows…
            </div>
          ) : workflows.isError || workflows.data?.status === "unavailable" ? (
            <div className="mt-5 rounded-card border border-field bg-popover p-5">
              <h3 className="text-small-strong text-primary">Workflow storage is unavailable</h3>
              <p className="mt-1 text-small text-secondary">
                {workflows.data?.status === "unavailable"
                  ? workflows.data.message
                  : "Aiden could not read the device-local workflow library."}
              </p>
              <Button className="mt-4" size="small" onClick={() => void workflows.refetch()}>
                Try again
              </Button>
            </div>
          ) : ready && ready.workflows.length > 0 ? (
            <div className="mt-4 grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[620px]:grid-cols-1">
              {ready.workflows.map((workflow) => (
                <article
                  key={workflow.id}
                  className="group relative flex min-h-44 flex-col rounded-card border border-field bg-popover/65 p-4 shadow-control transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out hover:-translate-y-0.5 hover:bg-popover hover:shadow-control motion-reduce:transform-none"
                >
                  <button
                    type="button"
                    className="absolute inset-0 rounded-card outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                    aria-label={`Open ${workflow.title}`}
                    onClick={() =>
                      void navigate({
                        to: "/create-images/$workflowId",
                        params: { workflowId: workflow.id },
                      })
                    }
                  />
                  <div
                    className="create-images-card-preview relative mb-4 h-20 overflow-hidden rounded-control bg-well"
                    aria-hidden="true"
                  >
                    <span className="absolute left-3 top-5 h-8 w-14 rounded-[7px] border border-field bg-popover shadow-control" />
                    <span className="absolute left-[5.4rem] top-3 h-12 w-16 rounded-[7px] border border-field bg-popover shadow-control" />
                    <span className="absolute right-3 top-6 h-8 w-14 rounded-[7px] border border-field bg-popover shadow-control" />
                    <span className="absolute left-[4.2rem] top-9 h-px w-7 bg-accent/55" />
                    <span className="absolute right-[4.2rem] top-9 h-px w-7 bg-accent/55" />
                  </div>
                  <div className="relative z-10 flex min-w-0 items-start gap-2 pointer-events-none">
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-small-strong font-medium text-primary">
                        {workflow.title}
                      </h3>
                      <p className="mt-1 text-small text-secondary">
                        {workflow.nodeCount} nodes · {workflow.edgeCount} connections
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          iconOnly
                          size="small"
                          variant="transparent"
                          className="pointer-events-auto"
                          aria-label={`Actions for ${workflow.title}`}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            setRenameTarget(workflow);
                            setRenameValue(workflow.title);
                          }}
                        >
                          <Pencil className="size-4" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void duplicateWorkflow(workflow)}>
                          <Copy className="size-4" /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void exportArchive(workflow)}>
                          <Download className="size-4" /> Export .aiden-images
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem color="red" onSelect={() => setDeleteTarget(workflow)}>
                          <Trash2 className="size-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="pointer-events-none relative z-10 mt-auto flex items-center justify-between gap-2 pt-4 text-mini text-tertiary">
                    <span>
                      {workflow.health === "healthy"
                        ? workflow.missingAssetCount > 0
                          ? `${workflow.missingAssetCount} missing image${workflow.missingAssetCount === 1 ? "" : "s"}`
                          : `${workflow.assetCount} assets`
                        : workflow.health === "unsafe"
                          ? "Newer format"
                          : "Recovery needed"}
                    </span>
                    <span>{updatedLabel(workflow.updatedAt)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-card border border-dashed border-field bg-popover/45 py-8">
              <EmptyState
                placement="inline"
                title="No image workflows yet"
                description="Choose a focused starter, import a portable archive, or begin with a blank canvas."
              />
              <div
                className="mx-auto grid max-w-3xl grid-cols-3 gap-2 px-5 pb-4 max-[700px]:grid-cols-1"
                aria-label="Create Images starter templates"
              >
                {CREATE_IMAGES_WORKFLOW_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    disabled={Boolean(busy)}
                    className="rounded-control border border-field bg-well px-3 py-3 text-left outline-none transition-colors hover:bg-control focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
                    onClick={() => void createWorkflow(template.id)}
                  >
                    <span className="block text-small-strong text-primary">{template.title}</span>
                    <span className="mt-1 block text-mini leading-relaxed text-secondary">
                      {template.description}
                    </span>
                  </button>
                ))}
              </div>
              <div className="flex justify-center gap-2 pb-6">
                <Button size="small" variant="filled" onClick={() => void createWorkflow("blank")}>
                  <Boxes /> Blank canvas
                </Button>
                <Button size="small" variant="transparent" onClick={() => void importArchive()}>
                  <Upload /> Import archive
                </Button>
                <Button
                  size="small"
                  variant="transparent"
                  disabled={Boolean(busy)}
                  onClick={() => void importNodeBanana()}
                >
                  <Upload /> Import Node Banana JSON
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={Boolean(nodeBananaImport)}
        onOpenChange={(open) => !open && setNodeBananaImport(undefined)}
        title="Node Banana import report"
        description={
          nodeBananaImport
            ? `${nodeBananaImport.sourceFileName} was converted into a new Aiden workflow. Review every rewritten or skipped source node before opening it.`
            : undefined
        }
        size="large"
        confirmLabel="Open workflow"
        onConfirm={async () => {
          if (!nodeBananaImport) return;
          const workflowId = nodeBananaImport.workflow.id;
          setNodeBananaImport(undefined);
          await navigate({
            to: "/create-images/$workflowId",
            params: { workflowId },
          });
        }}
      >
        {nodeBananaImport ? (
          <div className="space-y-4">
            <div className="rounded-control border border-support-warning/25 bg-support-warning/[0.07] px-3 py-2.5 text-small leading-relaxed text-secondary">
              {nodeBananaImport.report.securityNote}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-small max-[560px]:grid-cols-1">
              <div className="rounded-control bg-well px-3 py-2">
                <dt className="text-tertiary">Nodes</dt>
                <dd className="mt-0.5 text-primary">
                  {nodeBananaImport.report.importedNodeCount} mapped ·{" "}
                  {nodeBananaImport.report.skippedNodeCount} skipped
                </dd>
              </div>
              <div className="rounded-control bg-well px-3 py-2">
                <dt className="text-tertiary">Connections</dt>
                <dd className="mt-0.5 text-primary">
                  {nodeBananaImport.report.importedEdgeCount} mapped ·{" "}
                  {nodeBananaImport.report.skippedEdgeCount} skipped
                </dd>
              </div>
              <div className="rounded-control bg-well px-3 py-2">
                <dt className="text-tertiary">Embedded images</dt>
                <dd className="mt-0.5 text-primary">
                  {nodeBananaImport.report.importedEmbeddedImageCount} validated ·{" "}
                  {nodeBananaImport.report.skippedEmbeddedImageCount} rejected
                </dd>
              </div>
              <div className="rounded-control bg-well px-3 py-2">
                <dt className="text-tertiary">Source</dt>
                <dd className="mt-0.5 text-primary">Node Banana workflow version 1</dd>
              </div>
            </dl>
            <ol className="grid gap-2" aria-label="Node Banana import changes">
              {nodeBananaImport.report.entries.map((entry) => (
                <li
                  key={`${entry.sourceNodeIndex}-${entry.sourceType}`}
                  className="rounded-control border border-field px-3 py-2.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-small-strong text-primary">
                      Node {entry.sourceNodeIndex + 1} · {entry.sourceType}
                    </strong>
                    <span className="rounded-pill bg-control px-2 py-0.5 text-mini text-secondary">
                      {entry.action === "rewritten" ? "Rewritten" : "Skipped"}
                    </span>
                  </div>
                  <p className="mt-1 text-small leading-relaxed text-secondary">{entry.message}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => !open && setRenameTarget(undefined)}
        title="Rename workflow"
        description="Choose a concise name for the workflow library and canvas."
        confirmLabel="Rename"
        confirmDisabled={!renameValue.trim() || renameValue.trim() === renameTarget?.title}
        busy={busy === `rename-${renameTarget?.id}`}
        onConfirm={async () => {
          if (!renameTarget) return;
          setBusy(`rename-${renameTarget.id}`);
          try {
            const result = await createImagesApi.rename({
              workflowId: renameTarget.id,
              expectedRevision: renameTarget.revision,
              title: renameValue,
            });
            if (result.status !== "saved") {
              toast.error(mutationMessage(result, "Aiden could not rename the workflow."));
              return;
            }
            setRenameTarget(undefined);
            await refresh();
          } catch {
            toast.error("Aiden could not rename the workflow.");
          } finally {
            setBusy(undefined);
          }
        }}
      >
        <Input
          autoFocus
          value={renameValue}
          maxLength={120}
          aria-label="Workflow name"
          onChange={(event) => setRenameValue(event.target.value)}
        />
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(undefined)}
        title="Delete workflow?"
        description={
          deleteTarget
            ? `“${deleteTarget.title}” can be deleted only when it has no active run, retained run history, or recovery records. Shared assets remain protected until device-local cleanup confirms they are unused.`
            : undefined
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        busy={busy === `delete-${deleteTarget?.id}`}
        keepOpenOnConfirm
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(`delete-${deleteTarget.id}`);
          try {
            const result = await createImagesApi.delete({
              workflowId: deleteTarget.id,
              expectedRevision: deleteTarget.revision,
            });
            if (result.status !== "deleted") {
              toast.error(mutationMessage(result, "Aiden could not delete the workflow."));
              return;
            }
            setDeleteTarget(undefined);
            await refresh();
          } catch {
            toast.error("Aiden could not delete the workflow.");
          } finally {
            setBusy(undefined);
          }
        }}
      />
      <AlertDialog
        open={Boolean(assetCleanupPlan)}
        onOpenChange={(open) => !open && setAssetCleanupPlan(undefined)}
        title="Delete unused images?"
        description={
          assetCleanupPlan ? (
            <>
              Aiden verified that {assetCleanupPlan.candidateCount} device-local image
              {assetCleanupPlan.candidateCount === 1 ? " is" : "s are"} unreferenced by every
              workflow, retained run, export operation, and open preview. This permanently deletes
              {` ${storageBytesLabel(assetCleanupPlan.reclaimableBytes)}`} of images unused for at
              least seven days.
            </>
          ) : undefined
        }
        confirmLabel="Delete unused images"
        confirmVariant="destructive"
        busy={busy === "apply-asset-cleanup"}
        keepOpenOnConfirm
        onConfirm={async () => {
          if (!assetCleanupPlan) return;
          setBusy("apply-asset-cleanup");
          try {
            const result = await createImagesApi.applyAssetCleanup({
              planId: assetCleanupPlan.planId,
              confirmed: true,
            });
            if (result.status === "cleaned") {
              toast.success(
                `Deleted ${result.deletedCount} unused image${result.deletedCount === 1 ? "" : "s"} and reclaimed ${storageBytesLabel(result.reclaimedBytes)}.`,
              );
              setAssetCleanupPlan(undefined);
              await refreshStorageHealth();
            } else if (result.status === "stale") {
              toast.error("Image references changed. Review a fresh cleanup plan before deleting.");
              setAssetCleanupPlan(undefined);
              await refreshStorageHealth();
            } else toast.error(result.message);
          } catch {
            toast.error("Aiden did not delete images because cleanup could not be verified.");
          } finally {
            setBusy(undefined);
          }
        }}
      />
      {degradedDiscard.plan ? (
        <CreateImagesDiscardDegradedRunDialog
          open
          plan={degradedDiscard.plan}
          reviewed={degradedDiscard.reviewed}
          submitting={degradedDiscard.busy}
          returnFocusRef={degradedDiscard.returnFocusRef}
          onReviewedChange={degradedDiscard.setReviewed}
          onOpenChange={(open) => {
            if (!open) degradedDiscard.close();
          }}
          onConfirm={() => void degradedDiscard.confirm()}
        />
      ) : null}
    </section>
  );
}

function LoadingWorkflow() {
  return (
    <div
      className="flex h-full items-center justify-center gap-2 p-6 text-small text-secondary"
      role="status"
    >
      <Loader2 className="size-4 animate-spin" /> Opening workflow…
    </div>
  );
}

function WorkflowFailure({
  title,
  message,
  retry,
  secondaryAction,
}: {
  title: string;
  message: string;
  retry?(): void;
  secondaryAction?: { label: string; run(): void };
}) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-md">
        <ShieldAlert className="mx-auto size-7 text-secondary" aria-hidden="true" />
        <h1 className="mt-3 text-heading2 font-semibold text-primary">{title}</h1>
        <p className="mt-2 text-small leading-relaxed text-secondary">{message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => void navigate({ to: "/create-images" })}>Back to workflows</Button>
          {retry ? <Button onClick={retry}>Try again</Button> : null}
          {secondaryAction ? (
            <Button variant="transparent" onClick={secondaryAction.run}>
              <Copy aria-hidden="true" />
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RecoveryWorkflow({
  workflowId,
  recovery,
  reload,
}: {
  workflowId: string;
  recovery: CreateImagesWorkflowRecoveryView;
  reload(): Promise<unknown>;
}) {
  const [busy, setBusy] = React.useState<string>();
  const copyDiagnostics = React.useCallback(() => {
    const diagnostic = {
      format: "aiden-create-images-recovery-diagnostics",
      version: 1,
      workflowId,
      recovery,
    };
    void navigator.clipboard.writeText(`${JSON.stringify(diagnostic, null, 2)}\n`).then(
      () => toast.success("Recovery diagnostics copied."),
      () => toast.error("Recovery diagnostics could not be copied."),
    );
  }, [recovery, workflowId]);
  const act = async (
    action: string,
    request: () => Promise<CreateImagesWorkflowMutationResult>,
  ) => {
    setBusy(action);
    try {
      const result = await request();
      if (result.status !== "saved") {
        toast.error(mutationMessage(result, "Workflow recovery did not complete."));
        return;
      }
      await reload();
    } catch {
      toast.error("Workflow recovery did not complete.");
    } finally {
      setBusy(undefined);
    }
  };
  if (recovery.status === "unsafe") {
    return (
      <WorkflowFailure
        title="Newer workflow format"
        message="Aiden kept every file unchanged, but this version cannot safely open or overwrite the workflow. Update Aiden to continue."
        secondaryAction={{ label: "Copy diagnostics", run: copyDiagnostics }}
      />
    );
  }
  if (recovery.status !== "recovery-required") {
    return (
      <WorkflowFailure
        title="Workflow unavailable"
        message="No recoverable workflow data was found."
      />
    );
  }
  const repairable =
    recovery.currentRevision !== undefined &&
    (recovery.reason === "journal-corrupt" ||
      (recovery.reason === "last-known-good-corrupt" && recovery.autosave === "none"));
  const discardableAutosave =
    recovery.currentRevision !== undefined &&
    recovery.autosave === "pending" &&
    recovery.autosaveTargetRevision !== undefined;
  const recoverableAutosave =
    recovery.autosave === "pending" && recovery.autosaveTargetRevision !== undefined;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-card border border-field bg-popover p-6 shadow-control">
        <AlertTriangle className="size-6 text-yellow" aria-hidden="true" />
        <h1 className="mt-3 text-heading2 font-semibold text-primary">Workflow recovery needed</h1>
        <p className="mt-2 text-small leading-relaxed text-secondary">
          Aiden stopped before opening the canvas so damaged or conflicting files cannot silently
          overwrite a known-good copy. Choose the durable version to keep.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {recovery.lastKnownGoodRevision ? (
            <Button
              variant="accent"
              disabled={Boolean(busy)}
              onClick={() =>
                void act("last-good", () =>
                  createImagesApi.recover({
                    workflowId,
                    source: "last-known-good",
                    expectedCandidateRevision: recovery.lastKnownGoodRevision!,
                  }),
                )
              }
            >
              {busy === "last-good" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Restore last known good
            </Button>
          ) : null}
          {recoverableAutosave ? (
            <Button
              variant={recovery.reason === "journal-conflict" ? "accent" : "filled"}
              disabled={Boolean(busy)}
              onClick={() =>
                void act("autosave", () =>
                  createImagesApi.recover({
                    workflowId,
                    source: "autosave",
                    expectedCandidateRevision: recovery.autosaveTargetRevision!,
                  }),
                )
              }
            >
              Recover autosave
            </Button>
          ) : null}
          {discardableAutosave ? (
            <Button
              variant="filled"
              disabled={Boolean(busy)}
              onClick={() =>
                void act("discard-autosave", () =>
                  createImagesApi.discardAutosave({
                    workflowId,
                    expectedTargetRevision: recovery.autosaveTargetRevision!,
                  }),
                )
              }
            >
              Keep saved version
            </Button>
          ) : null}
          {repairable ? (
            <Button
              variant="accent"
              disabled={Boolean(busy)}
              onClick={() =>
                void act("repair", () =>
                  createImagesApi.repairRecoveryMetadata({
                    workflowId,
                    expectedRevision: recovery.currentRevision!,
                  }),
                )
              }
            >
              Repair recovery metadata
            </Button>
          ) : null}
          <Button variant="transparent" disabled={Boolean(busy)} onClick={copyDiagnostics}>
            <Copy aria-hidden="true" />
            Copy diagnostics
          </Button>
        </div>
      </div>
    </div>
  );
}

function SaveStatusBanner({
  status,
  onReload,
  onRetry,
  onSaveCopy,
}: {
  status: CreateImagesAutosaveStatus;
  onReload(): void;
  onRetry(): void;
  onSaveCopy(): void;
}) {
  if (status.state !== "conflict" && status.state !== "error") return null;
  return (
    <div
      className="absolute left-1/2 top-16 z-40 flex w-[min(92%,680px)] -translate-x-1/2 items-center gap-3 rounded-card border border-field bg-popover px-4 py-3 shadow-popover"
      role="alert"
    >
      <AlertTriangle className="size-5 shrink-0 text-yellow" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-small-strong font-medium text-primary">
          {status.state === "conflict" ? "This workflow changed elsewhere" : "Autosave paused"}
        </p>
        <p className="mt-0.5 text-mini text-secondary">
          {status.state === "conflict"
            ? "Reload the saved version or preserve your current canvas as a new workflow."
            : status.message}
        </p>
      </div>
      {status.state === "conflict" ? (
        <>
          <Button size="small" variant="filled" onClick={onReload}>
            Reload saved
          </Button>
          <Button size="small" variant="accent" onClick={onSaveCopy}>
            Save a copy
          </Button>
        </>
      ) : (
        <Button size="small" variant="accent" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

function PersistentWorkflowCanvas({
  initial,
  initialMissingAssetIds,
}: {
  initial: WorkflowDocumentV1;
  initialMissingAssetIds: readonly string[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const providerStatusQuery = useCreateImagesProviderStatus();
  const [executionMode, setExecutionMode] = React.useState<CreateImagesExecutionMode>("local-mock");
  const providerStatus: CreateImagesProviderStatus = providerStatusQuery.data ?? {
    schemaVersion: CREATE_IMAGES_PROVIDER_STATUS_VERSION,
    providerId: "gemini",
    displayName: "Google Gemini",
    connectionState: providerStatusQuery.isLoading ? "connecting" : "unavailable",
    ...(providerStatusQuery.isLoading ? {} : { safeErrorCode: "capability-check-failed" as const }),
  };
  const geminiReady =
    providerStatus.connectionState === "connected" &&
    providerStatus.capabilitySnapshot?.state === "current" &&
    providerStatus.capabilitySnapshot.models.length > 0;
  React.useEffect(() => {
    if (!geminiReady) setExecutionMode("local-mock");
  }, [geminiReady]);
  const [document, setDocument] = React.useState(initial);
  const documentRef = React.useRef(initial);
  const [status, setStatus] = React.useState<CreateImagesAutosaveStatus>({
    state: "saved",
    workflow: initial,
  });
  const [canvasEpoch, setCanvasEpoch] = React.useState(0);
  const [missingAssetIds, setMissingAssetIds] =
    React.useState<readonly string[]>(initialMissingAssetIds);
  const [initialAssetRefs] = React.useState<readonly string[]>(() => initial.assetRefs);
  const [controller] = React.useState(
    () =>
      new WorkflowAutosaveController(initial, {
        save: createImagesApi.save,
      }),
  );
  const cancelPendingControllerDisposalRef = React.useRef<() => void>(() => undefined);
  const cancelPendingPreviewDisposalRef = React.useRef<() => void>(() => undefined);
  const cancelPendingRunPreviewDisposalRef = React.useRef<() => void>(() => undefined);
  const previewManager = React.useMemo(
    () =>
      new AssetPreviewLifecycleManager({
        load: async (assetId) => {
          const result = await createImagesApi.grantAsset({ workflowId: initial.id, assetId });
          if (result.status === "ready") return result.grant;
          if (result.status === "not-found") {
            setMissingAssetIds((current) =>
              current.includes(assetId) ? current : [...current, assetId],
            );
            throw new AssetPreviewLoadError("The image file is missing.", false);
          }
          throw new AssetPreviewLoadError(
            result.status === "unavailable"
              ? result.message
              : "This workflow is not authorized to preview that image.",
            result.status === "unavailable",
          );
        },
        revoke: (token) => createImagesApi.revokeAssetGrant({ token }),
      }),
    [initial.id],
  );
  const [previews, setPreviews] = React.useState<
    Readonly<Record<string, CreateImagesAssetGrantView>>
  >(() => previewManager.snapshot());
  const initialRunState = React.useMemo(
    () =>
      queryClient.getQueryData<CreateImagesRendererRunState>(
        queryKeys.createImagesRuns(initial.id),
      ),
    [initial.id, queryClient],
  );
  const [runState, setRunState] = React.useState<CreateImagesRendererRunState | undefined>(
    initialRunState,
  );
  const [selectedHistoryRunId, setSelectedHistoryRunId] = React.useState<string>();
  const selectedHistoryRunIdRef = React.useRef<string | undefined>(undefined);
  const [runHistoryDetail, setRunHistoryDetail] = React.useState<CreateImagesRunHistoryDetailState>(
    { status: "idle" },
  );
  const runHistoryDetailRef = React.useRef<CreateImagesRunHistoryDetailState>({ status: "idle" });
  const runHistoryRequestSequence = React.useRef(0);
  const runHistoryLifecycleRef = React.useRef({ mounted: false, generation: 0 });
  React.useEffect(() => {
    const generation = runHistoryLifecycleRef.current.generation + 1;
    runHistoryLifecycleRef.current = { mounted: true, generation };
    return () => {
      if (runHistoryLifecycleRef.current.generation !== generation) return;
      runHistoryLifecycleRef.current = { mounted: false, generation: generation + 1 };
      runHistoryRequestSequence.current += 1;
      selectedHistoryRunIdRef.current = undefined;
    };
  }, []);
  const [recoveringRunId, setRecoveringRunId] = React.useState<string>();
  const [ambiguityAcknowledgementRun, setAmbiguityAcknowledgementRun] =
    React.useState<CreateImagesRunView>();
  const [ambiguityAcknowledgementReviewed, setAmbiguityAcknowledgementReviewed] =
    React.useState(false);
  const [ambiguityAcknowledgementSubmitting, setAmbiguityAcknowledgementSubmitting] =
    React.useState(false);
  const ambiguityAcknowledgementReturnFocusRef = React.useRef<HTMLButtonElement | null>(null);
  const [runHistoryPrunePlan, setRunHistoryPrunePlan] = React.useState<
    Extract<CreateImagesRunHistoryPrunePlanResult, { status: "ready" }> | undefined
  >();
  const [runHistoryPruneBusy, setRunHistoryPruneBusy] = React.useState(false);
  const runHistoryPruneReturnFocusRef = React.useRef<HTMLButtonElement | null>(null);
  const runStateRef = React.useRef<CreateImagesRendererRunState | undefined>(initialRunState);
  const runAssetOwnersRef = React.useRef<Readonly<Record<string, string>>>(
    initialRunState?.runAssetOwners ?? {},
  );
  const runPreviewManager = React.useMemo(
    () =>
      new AssetPreviewLifecycleManager({
        load: async (assetId) => {
          const runId = runAssetOwnersRef.current[assetId];
          if (!runId) {
            throw new AssetPreviewLoadError(
              "This output is not authorized by the current run record.",
              false,
            );
          }
          const result = await createImagesApi.grantRunAsset({
            workflowId: initial.id,
            runId,
            assetId,
          });
          if (result.status === "ready") return result.grant;
          throw new AssetPreviewLoadError(
            result.status === "unavailable"
              ? result.message
              : "This run output is no longer available.",
            result.status === "unavailable",
          );
        },
        revoke: (token) => createImagesApi.revokeAssetGrant({ token }),
      }),
    [initial.id],
  );
  const [runAssetPreviews, setRunAssetPreviews] = React.useState<
    Readonly<Record<string, CreateImagesAssetGrantView>>
  >(() => runPreviewManager.snapshot());
  const [preparedRun, setPreparedRun] = React.useState<PreparedRun>();
  const [reviewedRun, setReviewedRun] = React.useState(false);
  const [runPreparing, setRunPreparing] = React.useState(false);
  const [runSubmitting, setRunSubmitting] = React.useState(false);
  const [stopDialogOpen, setStopDialogOpen] = React.useState(false);
  const [stopSubmitting, setStopSubmitting] = React.useState(false);
  const runRequestActiveRef = React.useRef(false);
  const runPreparationGenerationRef = React.useRef(0);
  const runReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const stopReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const handleDocumentChange = React.useCallback(
    (next: WorkflowDocumentV1) => {
      documentRef.current = next;
      previewManager.setAssets(next.assetRefs);
      setMissingAssetIds((current) =>
        current.filter((assetId) => next.assetRefs.includes(assetId)),
      );
      controller.update(next);
    },
    [controller, previewManager],
  );
  const retainAssetPreview = React.useCallback(
    (assetId: string) => previewManager.retain(assetId),
    [previewManager],
  );
  const assetPreviewStatus = React.useCallback(
    (assetId: string) => previewManager.status(assetId),
    [previewManager],
  );
  const retainRunAssetPreview = React.useCallback(
    (assetId: string) => runPreviewManager.retain(assetId),
    [runPreviewManager],
  );
  const syncRunPreviewAuthority = React.useCallback(
    (
      next: CreateImagesRendererRunState | undefined,
      detail: CreateImagesRunHistoryDetailState = runHistoryDetailRef.current,
    ) => {
      const detailOwners = detail.status === "ready" ? createImagesRunAssetOwners(detail.run) : {};
      const owners = { ...(next?.runAssetOwners ?? {}), ...detailOwners };
      runAssetOwnersRef.current = owners;
      runPreviewManager.setAssets(Object.keys(owners));
    },
    [runPreviewManager],
  );
  const commitRunState = React.useCallback(
    (next: CreateImagesRendererRunState) => {
      runStateRef.current = next;
      syncRunPreviewAuthority(next);
      queryClient.setQueryData(queryKeys.createImagesRuns(initial.id), next);
      setRunState(next);
    },
    [initial.id, queryClient, syncRunPreviewAuthority],
  );
  const applyRunList = React.useCallback(
    (result: CreateImagesRunListResult) => {
      const labels = Object.fromEntries(
        documentRef.current.nodes.map((node) => [
          node.id,
          CREATE_IMAGES_NODE_DEFINITIONS[node.type].title,
        ]),
      );
      try {
        if (result.status === "ready" && result.authoritative) {
          const selectedRunId = selectedHistoryRunIdRef.current;
          if (selectedRunId) {
            const priorDetail = runHistoryDetailRef.current;
            const priorRecovery =
              (priorDetail.status === "recovery-required" || priorDetail.status === "unsafe") &&
              priorDetail.recovery.runId === selectedRunId
                ? priorDetail.recovery
                : runStateRef.current?.recoveries.find((item) => item.runId === selectedRunId);
            const transition = createImagesSelectedRunSnapshotTransition(
              result,
              selectedRunId,
              priorRecovery,
            );
            if (transition.kind === "recovery-changed") {
              runHistoryRequestSequence.current += 1;
              const { recovery } = transition;
              const nextDetail: CreateImagesRunHistoryDetailState =
                recovery.status === "unsafe"
                  ? {
                      status: "unsafe",
                      recovery,
                      message:
                        "Aiden preserved this run without exposing an unsafe journal format.",
                    }
                  : { status: "recovery-required", recovery };
              runHistoryDetailRef.current = nextDetail;
              setRunHistoryDetail(nextDetail);
              syncRunPreviewAuthority(runStateRef.current, nextDetail);
            } else if (transition.kind === "removed" || transition.kind === "became-healthy") {
              runHistoryRequestSequence.current += 1;
              selectedHistoryRunIdRef.current = undefined;
              setSelectedHistoryRunId(undefined);
              const idle = { status: "idle" as const };
              runHistoryDetailRef.current = idle;
              setRunHistoryDetail(idle);
              syncRunPreviewAuthority(runStateRef.current, idle);
            }
          }
        }
        commitRunState(
          reconcileCreateImagesRunState(runStateRef.current, result, initial.id, labels),
        );
      } catch {
        const previous = runStateRef.current;
        commitRunState({
          ...(previous ?? { history: [], recoveries: [], runAssetOwners: {} }),
          errorMessage: "Aiden rejected an invalid run snapshot.",
        });
      }
    },
    [commitRunState, initial.id, syncRunPreviewAuthority],
  );
  const handleDegradedRunDiscarded = React.useCallback(
    (result: Extract<CreateImagesDegradedRunDiscardResult, { status: "discarded" }>) => {
      if (selectedHistoryRunIdRef.current === result.runId) {
        runHistoryRequestSequence.current += 1;
        selectedHistoryRunIdRef.current = undefined;
        setSelectedHistoryRunId(undefined);
        const idle = { status: "idle" as const };
        runHistoryDetailRef.current = idle;
        setRunHistoryDetail(idle);
      }
      commitRunState(removeCreateImagesRunRecord(runStateRef.current, result.runId));
    },
    [commitRunState],
  );
  const degradedDiscard = useDegradedRunDiscard({ onDiscarded: handleDegradedRunDiscarded });
  const applyRunMutation = React.useCallback(
    (run: CreateImagesRunView) => {
      if (run.workflowId !== initial.id) return false;
      const previous = runStateRef.current;
      const next = reconcileCreateImagesRunMutation(previous, run, initial.id);
      if (next === previous || (!previous && !next.projection)) return false;
      commitRunState(next);
      return true;
    },
    [commitRunState, initial.id],
  );
  const requestRun = React.useCallback(
    async (scope: WorkflowRunScope, draft: WorkflowDocumentV1, trigger: HTMLButtonElement) => {
      if (runRequestActiveRef.current) return;
      runRequestActiveRef.current = true;
      const generation = ++runPreparationGenerationRef.current;
      runReturnFocusRef.current = trigger;
      setRunPreparing(true);
      try {
        controller.update(draft);
        const flushed = await controller.flush();
        if (flushed.state !== "saved") {
          toast.error(
            flushed.state === "conflict"
              ? "Resolve the workflow save conflict before starting a run."
              : "Autosave must finish before Aiden can prepare this run.",
          );
          runRequestActiveRef.current = false;
          return;
        }
        setReviewedRun(false);
        if (executionMode === "gemini" && scope.kind === "all") {
          const result = await createImagesApi.prepareRun({
            workflowId: flushed.workflow.id,
            expectedRevision: flushed.workflow.revision,
            scope,
            executionMode: "gemini",
          });
          if (generation !== runPreparationGenerationRef.current) return;
          if (result.status !== "ready") {
            toast.error(
              result.status === "conflict"
                ? "The workflow changed before cloud review. Prepare the run again."
                : result.message,
            );
            runRequestActiveRef.current = false;
            return;
          }
          setPreparedRun(prepareGeminiRun(flushed.workflow, scope, result.plan));
          return;
        }
        const prepared =
          executionMode === "gemini" && scope.kind === "from-node"
            ? prepareGeminiPathChoice(flushed.workflow, scope)
            : prepareLocalMockRun(flushed.workflow, scope);
        setPreparedRun(
          scope.kind === "from-node"
            ? {
                ...prepared,
                scope: undefined,
                downstreamPathSelection: downstreamPathChoiceViews(
                  prepared.workflowSnapshot,
                  scope.nodeId,
                ),
              }
            : prepared,
        );
      } catch (error) {
        toast.error(
          error instanceof WorkflowPlanError
            ? (error.issues[0]?.message ?? "This scope cannot run.")
            : executionMode === "gemini"
              ? "Aiden could not prepare this Gemini run."
              : "Aiden could not prepare this local mock run.",
        );
        runRequestActiveRef.current = false;
      } finally {
        setRunPreparing(false);
      }
    },
    [controller, executionMode],
  );
  const closeRunConfirmation = React.useCallback(() => {
    if (runSubmitting) return;
    setPreparedRun(undefined);
    setReviewedRun(false);
    runPreparationGenerationRef.current += 1;
    runRequestActiveRef.current = false;
  }, [runSubmitting]);
  const selectPreparedRunDownstreamPath = React.useCallback(
    async (choiceId: string) => {
      const current = preparedRun;
      const selection = current?.downstreamPathSelection;
      if (!current || !selection || runPreparing) return;
      const scope = createImagesRunScopeForPathChoice(
        selection.startNodeId,
        choiceId,
        selection.choices,
      );
      if (!scope) return;
      setReviewedRun(false);
      const generation = ++runPreparationGenerationRef.current;
      setRunPreparing(true);
      try {
        let recomputed: PreparedRun;
        if (current.executionMode === "gemini") {
          const result = await createImagesApi.prepareRun({
            workflowId: current.workflowId,
            expectedRevision: current.workflowRevision,
            scope,
            executionMode: "gemini",
          });
          if (generation !== runPreparationGenerationRef.current) return;
          if (result.status !== "ready") {
            toast.error(
              result.status === "conflict"
                ? "The workflow changed before cloud review. Prepare the run again."
                : result.message,
            );
            return;
          }
          recomputed = prepareGeminiRun(current.workflowSnapshot, scope, result.plan);
        } else {
          recomputed = prepareLocalMockRun(current.workflowSnapshot, scope);
        }
        if (generation !== runPreparationGenerationRef.current) return;
        setPreparedRun({
          ...recomputed,
          workflowSnapshot: current.workflowSnapshot,
          downstreamPathSelection: { ...selection, selectedChoiceId: choiceId },
        });
      } catch {
        if (generation === runPreparationGenerationRef.current) {
          toast.error("Aiden could not prepare the selected run path.");
        }
      } finally {
        if (generation === runPreparationGenerationRef.current) setRunPreparing(false);
      }
    },
    [preparedRun, runPreparing],
  );
  const startPreparedRun = React.useCallback(async () => {
    if (!preparedRun?.scope || !reviewedRun || runSubmitting) return;
    if (preparedRun.executionMode === "gemini" && !preparedRun.providerConsent) {
      toast.error("A current main-owned Gemini consent plan is required before launch.");
      return;
    }
    setRunSubmitting(true);
    try {
      const result = await createImagesApi.startRun({
        workflowId: preparedRun.workflowId,
        expectedRevision: preparedRun.workflowRevision,
        scope: preparedRun.scope,
        consent:
          preparedRun.executionMode === "gemini" && preparedRun.providerConsent
            ? {
                executionMode: "gemini",
                version: 1,
                authorizationId: preparedRun.providerConsent.authorizationId,
                consentFingerprint: preparedRun.providerConsent.consentFingerprint,
                token: preparedRun.providerConsent.token,
                reviewed: true,
              }
            : { executionMode: "local-mock", reviewed: true },
      });
      if (result.status === "started" || result.status === "already-running") {
        applyRunMutation(result.run);
        setPreparedRun(undefined);
        setReviewedRun(false);
        runRequestActiveRef.current = false;
        toast.success(
          result.status === "started"
            ? preparedRun.executionMode === "gemini"
              ? "Gemini run started. Submitted requests may incur provider charges."
              : "Local mock run started."
            : "The active run is open.",
        );
        return;
      }
      toast.error(
        result.status === "conflict"
          ? "The workflow changed after review. Prepare the run again."
          : "message" in result
            ? result.message
            : "Aiden returned an unexpected run state.",
      );
    } catch {
      toast.error("Aiden could not start the reviewed image run.");
    } finally {
      setRunSubmitting(false);
    }
  }, [applyRunMutation, preparedRun, reviewedRun, runSubmitting]);
  const requestStop = React.useCallback((trigger: HTMLButtonElement) => {
    stopReturnFocusRef.current = trigger;
    setStopDialogOpen(true);
  }, []);
  const stopRun = React.useCallback(async () => {
    const active = runStateRef.current?.projection;
    if (!active || stopSubmitting) return;
    setStopSubmitting(true);
    try {
      const result = await createImagesApi.stopRun({
        workflowId: active.workflowId,
        runId: active.runId,
      });
      if (result.status === "stopping" || result.status === "already-running") {
        applyRunMutation(result.run);
        setStopDialogOpen(false);
      } else {
        toast.error(
          result.status === "conflict"
            ? "The saved workflow revision changed."
            : "message" in result
              ? result.message
              : "Aiden returned an unexpected stop state.",
        );
      }
    } catch {
      toast.error("Aiden could not request a durable stop.");
    } finally {
      setStopSubmitting(false);
    }
  }, [applyRunMutation, stopSubmitting]);
  const handleRunErrorAction = React.useCallback(
    (action: CreateImagesRunErrorAction) => {
      if (action === "check-connection") {
        toast.info("This Phase 3 mock uses no network connection.");
      } else if (action === "open-provider-settings") {
        void (async () => {
          if ((await controller.flush()).state !== "saved") {
            toast.error("Save the workflow before opening provider settings.");
            return;
          }
          await navigate({ to: "/settings", search: { section: "providers" } });
        })();
      } else if (action === "manage-storage") {
        toast.info("Free device space before starting another image run.");
      }
    },
    [controller, navigate],
  );
  const selectHistoryRun = React.useCallback(
    async (runId: string, _trigger: HTMLButtonElement) => {
      const lifecycle = runHistoryLifecycleRef.current;
      if (!lifecycle.mounted) return;
      const requestSequence = runHistoryRequestSequence.current + 1;
      runHistoryRequestSequence.current = requestSequence;
      const requestIdentity = {
        runId,
        lifecycleGeneration: lifecycle.generation,
        requestSequence,
      };
      const responseIsCurrent = () =>
        isCreateImagesRunHistoryRequestCurrent(
          runStateRef.current,
          {
            mounted: runHistoryLifecycleRef.current.mounted,
            lifecycleGeneration: runHistoryLifecycleRef.current.generation,
            selectedRunId: selectedHistoryRunIdRef.current,
            requestSequence: runHistoryRequestSequence.current,
          },
          requestIdentity,
        );
      selectedHistoryRunIdRef.current = runId;
      setSelectedHistoryRunId(runId);
      const loading = { status: "loading" as const, runId };
      runHistoryDetailRef.current = loading;
      setRunHistoryDetail(loading);
      syncRunPreviewAuthority(runStateRef.current, loading);
      try {
        const result = await createImagesApi.getRun({ workflowId: initial.id, runId });
        if (!responseIsCurrent()) return;
        runHistoryDetailRef.current = result;
        setRunHistoryDetail(result);
        syncRunPreviewAuthority(runStateRef.current, result);
      } catch {
        if (!responseIsCurrent()) return;
        const unavailable = {
          status: "unavailable" as const,
          message: "The durable run record is temporarily unavailable.",
        };
        runHistoryDetailRef.current = unavailable;
        setRunHistoryDetail(unavailable);
        syncRunPreviewAuthority(runStateRef.current, unavailable);
      }
    },
    [initial.id, syncRunPreviewAuthority],
  );
  const recoverHistoryRun = React.useCallback(
    async (recovery: CreateImagesRunRecoveryView, trigger: HTMLButtonElement) => {
      if (
        recovery.status !== "recovery-required" ||
        recovery.recoverySource === undefined ||
        recovery.expectedCandidateJournalRevision === undefined ||
        recoveringRunId
      ) {
        return;
      }
      const lifecycle = runHistoryLifecycleRef.current;
      if (!lifecycle.mounted) return;
      const requestSequence = runHistoryRequestSequence.current + 1;
      runHistoryRequestSequence.current = requestSequence;
      const requestIdentity = {
        runId: recovery.runId,
        lifecycleGeneration: lifecycle.generation,
        requestSequence,
        source: recovery.recoverySource,
        expectedCandidateJournalRevision: recovery.expectedCandidateJournalRevision,
      } as const;
      const responseIsCurrent = () =>
        isCreateImagesRunRecoveryRequestCurrent(
          runStateRef.current,
          {
            mounted: runHistoryLifecycleRef.current.mounted,
            lifecycleGeneration: runHistoryLifecycleRef.current.generation,
            selectedRunId: selectedHistoryRunIdRef.current,
            requestSequence: runHistoryRequestSequence.current,
          },
          requestIdentity,
        );
      let responseOwned = false;
      setRecoveringRunId(recovery.runId);
      try {
        const result = await createImagesApi.recoverRun({
          workflowId: initial.id,
          runId: requestIdentity.runId,
          source: requestIdentity.source,
          expectedCandidateJournalRevision: requestIdentity.expectedCandidateJournalRevision,
        });
        if (!responseIsCurrent()) return;
        responseOwned = true;
        if (result.status === "recovered") {
          const detail = { status: "ready" as const, run: result.run };
          runHistoryDetailRef.current = detail;
          setRunHistoryDetail(detail);
          const current = runStateRef.current;
          if (current) {
            commitRunState({
              ...current,
              recoveries: (current.recoveries ?? []).filter(
                (item) => item.runId !== recovery.runId,
              ),
            });
          } else {
            syncRunPreviewAuthority(undefined, detail);
          }
          toast.success(
            recovery.recoverySource === "last-known-good"
              ? "The verified last-known-good run record was restored."
              : "The recovery copy was repaired from the verified current run record.",
          );
        } else if (result.status === "recovery-required" || result.status === "unsafe") {
          const detail =
            result.status === "unsafe"
              ? result
              : { status: "recovery-required" as const, recovery: result.recovery };
          runHistoryDetailRef.current = detail;
          setRunHistoryDetail(detail);
          toast.error(
            result.status === "unsafe"
              ? result.message
              : "The recovery candidate changed. Review the updated run health.",
          );
        } else {
          toast.error(
            result.status === "conflict"
              ? result.source === "last-known-good"
                ? "The last-known-good candidate changed. Open the run record again."
                : "The current repair candidate changed. Open the run record again."
              : result.status === "not-found"
                ? "The run record no longer exists."
                : result.message,
          );
        }
      } catch {
        if (!responseIsCurrent()) return;
        responseOwned = true;
        toast.error("Aiden could not recover the run record safely.");
      } finally {
        if (
          runHistoryLifecycleRef.current.mounted &&
          runHistoryLifecycleRef.current.generation === requestIdentity.lifecycleGeneration
        ) {
          setRecoveringRunId(undefined);
        }
        if (responseOwned) {
          requestAnimationFrame(() => {
            if (
              isCreateImagesRunHistoryRequestCurrent(
                runStateRef.current,
                {
                  mounted: runHistoryLifecycleRef.current.mounted,
                  lifecycleGeneration: runHistoryLifecycleRef.current.generation,
                  selectedRunId: selectedHistoryRunIdRef.current,
                  requestSequence: runHistoryRequestSequence.current,
                },
                requestIdentity,
              ) &&
              trigger.isConnected
            ) {
              trigger.focus();
            }
          });
        }
      }
    },
    [commitRunState, initial.id, recoveringRunId, syncRunPreviewAuthority],
  );
  const requestAmbiguityAcknowledgement = React.useCallback(
    (run: CreateImagesRunView, trigger: HTMLButtonElement) => {
      if (
        ambiguityAcknowledgementSubmitting ||
        run.status !== "needs_attention" ||
        run.ambiguityResolution ||
        !run.nodes.some((node) => node.status === "ambiguous")
      ) {
        return;
      }
      ambiguityAcknowledgementReturnFocusRef.current = trigger;
      setAmbiguityAcknowledgementReviewed(false);
      setAmbiguityAcknowledgementRun(run);
    },
    [ambiguityAcknowledgementSubmitting],
  );
  const closeAmbiguityAcknowledgement = React.useCallback(() => {
    if (ambiguityAcknowledgementSubmitting) return;
    setAmbiguityAcknowledgementRun(undefined);
    setAmbiguityAcknowledgementReviewed(false);
  }, [ambiguityAcknowledgementSubmitting]);
  const confirmAmbiguityAcknowledgement = React.useCallback(async () => {
    const run = ambiguityAcknowledgementRun;
    if (!run || !ambiguityAcknowledgementReviewed || ambiguityAcknowledgementSubmitting) return;
    const lifecycle = runHistoryLifecycleRef.current;
    if (!lifecycle.mounted || selectedHistoryRunIdRef.current !== run.runId) return;
    const requestSequence = runHistoryRequestSequence.current + 1;
    runHistoryRequestSequence.current = requestSequence;
    const requestIdentity = {
      runId: run.runId,
      lifecycleGeneration: lifecycle.generation,
      requestSequence,
      expectedLastSequence: run.lastSequence,
    };
    const responseIsCurrent = () =>
      isCreateImagesRunAmbiguityRequestCurrent(
        runStateRef.current,
        {
          mounted: runHistoryLifecycleRef.current.mounted,
          lifecycleGeneration: runHistoryLifecycleRef.current.generation,
          selectedRunId: selectedHistoryRunIdRef.current,
          requestSequence: runHistoryRequestSequence.current,
        },
        requestIdentity,
      );
    setAmbiguityAcknowledgementSubmitting(true);
    let closed = false;
    try {
      const result = await createImagesApi.resolveRunAmbiguity({
        workflowId: initial.id,
        runId: run.runId,
        expectedJournalRevision: run.journalRevision,
        resolution: "acknowledge-unresolved-submission",
      });
      if (!responseIsCurrent()) return;
      if (result.status === "resolved" || result.status === "already-resolved") {
        if (runStateRef.current?.projection?.runId === run.runId && !applyRunMutation(result.run)) {
          return;
        }
        const detail = { status: "ready" as const, run: result.run };
        runHistoryDetailRef.current = detail;
        setRunHistoryDetail(detail);
        syncRunPreviewAuthority(runStateRef.current, detail);
        setAmbiguityAcknowledgementRun(undefined);
        setAmbiguityAcknowledgementReviewed(false);
        closed = true;
        toast.success(
          result.status === "resolved"
            ? "The unresolved submission was acknowledged. New runs still require confirmation."
            : "This unresolved submission was already acknowledged.",
        );
      } else if (result.status === "conflict") {
        setAmbiguityAcknowledgementRun(undefined);
        setAmbiguityAcknowledgementReviewed(false);
        closed = true;
        toast.error(
          "The run record changed. Open the latest durable record before acknowledging it.",
        );
      } else if (result.status === "not-ambiguous") {
        setAmbiguityAcknowledgementRun(undefined);
        setAmbiguityAcknowledgementReviewed(false);
        closed = true;
        toast.info("This run no longer has an unresolved submission.");
      } else if (result.status === "not-found") {
        setAmbiguityAcknowledgementRun(undefined);
        setAmbiguityAcknowledgementReviewed(false);
        closed = true;
        toast.error("The run record no longer exists.");
      } else {
        toast.error(
          "message" in result
            ? result.message
            : "Aiden returned an unexpected ambiguity acknowledgement state.",
        );
      }
    } catch {
      if (!responseIsCurrent()) return;
      toast.error("Aiden could not acknowledge the unresolved submission safely.");
    } finally {
      if (
        runHistoryLifecycleRef.current.mounted &&
        runHistoryLifecycleRef.current.generation === requestIdentity.lifecycleGeneration
      ) {
        setAmbiguityAcknowledgementSubmitting(false);
      }
      if (closed) {
        requestAnimationFrame(() => {
          const trigger = ambiguityAcknowledgementReturnFocusRef.current;
          if (
            isCreateImagesRunHistoryRequestCurrent(
              runStateRef.current,
              {
                mounted: runHistoryLifecycleRef.current.mounted,
                lifecycleGeneration: runHistoryLifecycleRef.current.generation,
                selectedRunId: selectedHistoryRunIdRef.current,
                requestSequence: runHistoryRequestSequence.current,
              },
              requestIdentity,
            ) &&
            trigger?.isConnected
          ) {
            trigger.focus();
          }
        });
      }
    }
  }, [
    ambiguityAcknowledgementReviewed,
    ambiguityAcknowledgementRun,
    ambiguityAcknowledgementSubmitting,
    applyRunMutation,
    initial.id,
    syncRunPreviewAuthority,
  ]);
  const requestRunHistoryPrune = React.useCallback(
    async (trigger: HTMLButtonElement) => {
      if (runHistoryPruneBusy) return;
      const lifecycleGeneration = runHistoryLifecycleRef.current.generation;
      if (!runHistoryLifecycleRef.current.mounted) return;
      const lifecycleIsCurrent = () =>
        runHistoryLifecycleRef.current.mounted &&
        runHistoryLifecycleRef.current.generation === lifecycleGeneration;
      runHistoryPruneReturnFocusRef.current = trigger;
      setRunHistoryPruneBusy(true);
      try {
        const result = await createImagesApi.planRunHistoryPrune({ keepLatest: 100 });
        if (!lifecycleIsCurrent()) return;
        if (result.status === "ready") {
          setRunHistoryPrunePlan(result);
        } else if (result.status === "nothing-to-prune") {
          toast.info("There is no older Create Images run history to clear.");
        } else {
          toast.error(result.message);
        }
      } catch {
        if (lifecycleIsCurrent()) toast.error("Aiden could not prepare run history cleanup.");
      } finally {
        if (lifecycleIsCurrent()) setRunHistoryPruneBusy(false);
      }
    },
    [runHistoryPruneBusy],
  );
  const confirmRunHistoryPrune = React.useCallback(async () => {
    const plan = runHistoryPrunePlan;
    if (!plan || runHistoryPruneBusy) return;
    const lifecycleGeneration = runHistoryLifecycleRef.current.generation;
    if (!runHistoryLifecycleRef.current.mounted) return;
    const lifecycleIsCurrent = () =>
      runHistoryLifecycleRef.current.mounted &&
      runHistoryLifecycleRef.current.generation === lifecycleGeneration;
    setRunHistoryPruneBusy(true);
    try {
      const result = await createImagesApi.pruneRunHistory({
        keepLatest: plan.keepLatest,
        authorizationToken: plan.authorizationToken,
        confirmed: true,
      });
      if (!lifecycleIsCurrent()) return;
      if (result.status === "pruned") {
        setRunHistoryPrunePlan(undefined);
        toast.success(
          `Cleared ${result.removedRunCount} run record${result.removedRunCount === 1 ? "" : "s"} and released ${result.releasedAssetCount} retained image or asset reference${result.releasedAssetCount === 1 ? "" : "s"}, which may include imported inputs and generated outputs.`,
        );
      } else if (result.status === "nothing-to-prune") {
        setRunHistoryPrunePlan(undefined);
        toast.info("There is no older Create Images run history to clear.");
      } else if (result.status === "conflict") {
        setRunHistoryPrunePlan(undefined);
        toast.error("Run history changed. Review a fresh cleanup summary before confirming.");
      } else {
        toast.error(result.message);
      }
    } catch {
      if (lifecycleIsCurrent()) {
        toast.error("Aiden could not clear the selected run history safely.");
      }
    } finally {
      if (lifecycleIsCurrent()) setRunHistoryPruneBusy(false);
    }
  }, [runHistoryPruneBusy, runHistoryPrunePlan]);
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: async () => (await controller.flush()).state !== "saved",
  });

  React.useEffect(
    () =>
      controller.subscribe((next) => {
        setStatus(next);
        if (next.state === "saved") {
          documentRef.current = next.workflow;
          setDocument(next.workflow);
        }
        const dirty = next.state !== "saved";
        const saving = next.state === "saving";
        setRendererLifecycleGuard("create-images", { dirty, saving });
        void appApi.setCloseGuard({
          dirty,
          gitBusy: false,
          path: next.workflow.title,
          saving,
        });
      }),
    [controller],
  );

  React.useEffect(() => {
    cancelPendingControllerDisposalRef.current();
    const unregister = registerCreateImagesNavigationGuard(async () => {
      const result = await controller.flush();
      return result.state === "saved"
        ? { allowed: true }
        : {
            allowed: false,
            message:
              result.state === "conflict"
                ? "Resolve the workflow save conflict before leaving."
                : "Wait for autosave to finish or retry it before leaving.",
          };
    });
    const flushWhenHidden = () => {
      if (window.document.visibilityState === "hidden") void controller.flush();
    };
    window.document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      unregister();
      window.document.removeEventListener("visibilitychange", flushWhenHidden);
      cancelPendingControllerDisposalRef.current = deferWorkflowAutosaveControllerDisposal(
        controller,
        () => {
          clearRendererLifecycleGuard("create-images");
          void appApi.setCloseGuard({ dirty: false, gitBusy: false, saving: false });
        },
      );
    };
  }, [controller]);

  React.useEffect(() => {
    cancelPendingPreviewDisposalRef.current();
    const unsubscribe = previewManager.subscribe(setPreviews);
    previewManager.setAssets(initialAssetRefs);
    const refreshWhenVisible = () => {
      if (window.document.visibilityState === "visible") previewManager.refresh();
    };
    window.document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.document.removeEventListener("visibilitychange", refreshWhenVisible);
      unsubscribe();
      cancelPendingPreviewDisposalRef.current = deferAssetPreviewLifecycleDisposal(previewManager);
    };
  }, [initialAssetRefs, previewManager]);

  React.useEffect(() => {
    cancelPendingRunPreviewDisposalRef.current();
    const unsubscribe = runPreviewManager.subscribe(setRunAssetPreviews);
    runPreviewManager.setAssets(createImagesRunOutputAssetIds(initialRunState));
    const refreshWhenVisible = () => {
      if (window.document.visibilityState === "visible") runPreviewManager.refresh();
    };
    window.document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.document.removeEventListener("visibilitychange", refreshWhenVisible);
      unsubscribe();
      cancelPendingRunPreviewDisposalRef.current =
        deferAssetPreviewLifecycleDisposal(runPreviewManager);
    };
  }, [initialRunState, runPreviewManager]);

  React.useEffect(() => {
    const runSubscription = createImagesRunSubscriptionController({
      workflowId: initial.id,
      subscribe: createImagesApi.subscribeRuns,
      unsubscribe: createImagesApi.unsubscribeRuns,
      onChanged: createImagesApi.onRunsChanged,
      apply: applyRunList,
    });
    const retryWhenFocused = () => runSubscription.retryNow();
    const retryWhenVisible = () => {
      if (window.document.visibilityState === "visible") runSubscription.retryNow();
    };
    window.addEventListener("focus", retryWhenFocused);
    window.document.addEventListener("visibilitychange", retryWhenVisible);
    runSubscription.start();
    return () => {
      window.removeEventListener("focus", retryWhenFocused);
      window.document.removeEventListener("visibilitychange", retryWhenVisible);
      runSubscription.dispose();
    };
  }, [applyRunList, initial.id]);

  const statusLabel =
    status.state === "saved"
      ? "Saved on this device"
      : status.state === "dirty"
        ? "Autosave pending"
        : status.state === "saving"
          ? "Saving…"
          : status.state === "conflict"
            ? "Save conflict"
            : "Autosave paused";

  const reloadConflict = () => {
    if (status.state !== "conflict") return;
    previewManager.setAssets(status.current.assetRefs);
    documentRef.current = status.current;
    controller.replacePersisted(status.current);
    setDocument(status.current);
    setCanvasEpoch((current) => current + 1);
  };

  const saveConflictCopy = async () => {
    if (status.state !== "conflict") return;
    const created = await createImagesApi.create({
      template: "blank",
      title: `${status.workflow.title} copy`,
    });
    if (created.status !== "saved") {
      toast.error(mutationMessage(created, "Aiden could not create a conflict copy."));
      return;
    }
    const copy: WorkflowDocumentV1 = {
      ...structuredClone(status.workflow),
      id: created.workflow.id,
      title: created.workflow.title,
      revision: 2,
      createdAt: created.workflow.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const saved = await createImagesApi.save({ expectedRevision: 1, workflow: copy });
    if (saved.status !== "saved") {
      toast.error(mutationMessage(saved, "Aiden could not save the conflict copy."));
      return;
    }
    controller.replacePersisted(status.current);
    await queryClient.invalidateQueries({ queryKey: queryKeys.createImagesWorkflows });
    await navigate({ to: "/create-images/$workflowId", params: { workflowId: saved.workflow.id } });
  };

  return (
    <div className="relative h-full min-h-0">
      <WorkflowCanvas
        key={`${document.id}:${canvasEpoch}`}
        document={document}
        assetPreviews={previews}
        runProjection={runState?.projection}
        runHistory={runState?.history}
        runRecoveries={runState?.recoveries}
        selectedHistoryRunId={selectedHistoryRunId}
        runHistoryDetail={runHistoryDetail}
        recoveringRunId={recoveringRunId}
        acknowledgingRunId={ambiguityAcknowledgementRun?.runId}
        degradedRunDiscardBusy={degradedDiscard.busy}
        runHistoryManagementBusy={runHistoryPruneBusy}
        runBusy={
          runPreparing || runSubmitting || stopSubmitting || ambiguityAcknowledgementSubmitting
        }
        runAssetPreviews={runAssetPreviews}
        missingAssetIds={missingAssetIds}
        onAssetPreviewMount={retainAssetPreview}
        onAssetPreviewStatus={assetPreviewStatus}
        onAssetPreviewLoad={(assetId, token) => previewManager.reportLoadSuccess(assetId, token)}
        onAssetPreviewError={(assetId, token) => previewManager.reportLoadError(assetId, token)}
        onRunAssetPreviewMount={retainRunAssetPreview}
        onRunAssetPreviewLoad={(assetId, token) =>
          runPreviewManager.reportLoadSuccess(assetId, token)
        }
        onRunAssetPreviewError={(assetId, token) =>
          runPreviewManager.reportLoadError(assetId, token)
        }
        onDownloadRunAsset={(runId, assetId) => {
          void createImagesApi
            .downloadRunAsset({
              workflowId: documentRef.current.id,
              runId,
              assetId,
            })
            .then((result) => {
              if (result.status === "canceled") return;
              if (result.status === "saved") {
                toast.success(`Saved ${result.fileName} and revealed it in Finder.`);
                return;
              }
              if (result.status === "forbidden")
                toast.error("This run record no longer authorizes that image.");
              else if (result.status === "not-found")
                toast.error("The retained image file is missing.");
              else if ("message" in result) toast.error(result.message);
            })
            .catch(() => toast.error("Aiden could not save this retained image."));
        }}
        statusLabel={`${statusLabel}${missingAssetIds.length > 0 ? ` · ${missingAssetIds.length} image file${missingAssetIds.length === 1 ? "" : "s"} missing` : ""}${runState?.errorMessage ? " · Run updates unavailable" : ""}`}
        providerStatus={providerStatus}
        executionMode={executionMode}
        onExecutionModeChange={setExecutionMode}
        onOpenProviderSettings={() =>
          void navigate({ to: "/settings", search: { section: "providers" } })
        }
        onDocumentChange={handleDocumentChange}
        onRunRequest={(scope, draft, trigger) => void requestRun(scope, draft, trigger)}
        onStopRun={requestStop}
        onRunErrorAction={handleRunErrorAction}
        onSelectHistoryRun={(runId, trigger) => void selectHistoryRun(runId, trigger)}
        onRecoverRun={(recovery, trigger) => void recoverHistoryRun(recovery, trigger)}
        onDiscardDegradedRun={(runId, trigger) => void degradedDiscard.request(runId, trigger)}
        onAcknowledgeRunAmbiguity={requestAmbiguityAcknowledgement}
        onManageRunHistory={(trigger) => void requestRunHistoryPrune(trigger)}
        onImportDroppedImages={async (files) => {
          let result;
          try {
            result = await window.aidenAPI.createImages.importDroppedFiles(
              documentRef.current.id,
              files,
            );
          } catch {
            return { imported: [], failures: ["The dropped images could not be imported."] };
          }
          if (result.status !== "completed") {
            return { imported: [], failures: [result.message] };
          }
          const imported = [];
          const failures: string[] = [];
          for (const item of result.items) {
            if (item.status === "unavailable") {
              failures.push(`${item.fileName}: ${item.message}`);
              continue;
            }
            previewManager.adopt(item.grant.asset.assetId, item.grant);
            setMissingAssetIds((current) =>
              current.filter((assetId) => assetId !== item.grant.asset.assetId),
            );
            imported.push({
              assetId: item.grant.asset.assetId,
              ...(item.grant.asset.originalName ? { label: item.grant.asset.originalName } : {}),
            });
          }
          return { imported, failures };
        }}
        onChooseImage={async () => {
          let result;
          try {
            result = await createImagesApi.pickAsset({ workflowId: document.id });
          } catch {
            toast.error("The image picker is unavailable.");
            return undefined;
          }
          if (result.status === "canceled") return undefined;
          if (result.status !== "imported") {
            toast.error(result.message);
            return undefined;
          }
          previewManager.adopt(result.grant.asset.assetId, result.grant);
          setMissingAssetIds((current) =>
            current.filter((assetId) => assetId !== result.grant.asset.assetId),
          );
          return {
            assetId: result.grant.asset.assetId,
            ...(result.grant.asset.originalName ? { label: result.grant.asset.originalName } : {}),
          };
        }}
        onBack={() => {
          void (async () => {
            const decision = await requestCreateImagesNavigation();
            if (!decision.allowed) {
              toast.error(decision.message ?? "Resolve the workflow save issue before leaving.");
              return;
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.createImagesWorkflows });
            await navigate({ to: "/create-images" });
          })();
        }}
      />
      <SaveStatusBanner
        status={status}
        onReload={reloadConflict}
        onRetry={() => void controller.retry()}
        onSaveCopy={() => void saveConflictCopy()}
      />
      {preparedRun ? (
        <CreateImagesRunConfirmationDialog
          open
          model={preparedRun.model}
          reviewed={reviewedRun}
          submitting={runSubmitting}
          downstreamPathSelection={preparedRun.downstreamPathSelection}
          returnFocusRef={runReturnFocusRef}
          onReviewedChange={setReviewedRun}
          onDownstreamPathSelectionChange={selectPreparedRunDownstreamPath}
          onOpenChange={(open) => {
            if (!open) closeRunConfirmation();
          }}
          onConfirm={() => void startPreparedRun()}
        />
      ) : null}
      <CreateImagesStopRunDialog
        open={stopDialogOpen}
        stopping={stopSubmitting}
        queuedNodeCount={
          Object.values(runState?.projection?.nodes ?? {}).filter(
            (node) =>
              node.status === "queued" ||
              (node.status === "retry" && node.retryMode === "automatic-mock"),
          ).length
        }
        runningNodeCount={
          Object.values(runState?.projection?.nodes ?? {}).filter(
            (node) => node.status === "running",
          ).length
        }
        providerMayComplete={runState?.projection?.executionMode === "gemini"}
        returnFocusRef={stopReturnFocusRef}
        onOpenChange={setStopDialogOpen}
        onConfirm={() => void stopRun()}
      />
      {ambiguityAcknowledgementRun ? (
        <CreateImagesResolveRunAmbiguityDialog
          open
          journalRevision={ambiguityAcknowledgementRun.journalRevision}
          reviewed={ambiguityAcknowledgementReviewed}
          submitting={ambiguityAcknowledgementSubmitting}
          returnFocusRef={ambiguityAcknowledgementReturnFocusRef}
          onReviewedChange={setAmbiguityAcknowledgementReviewed}
          onOpenChange={(open) => {
            if (!open) closeAmbiguityAcknowledgement();
          }}
          onConfirm={() => void confirmAmbiguityAcknowledgement()}
        />
      ) : null}
      {degradedDiscard.plan ? (
        <CreateImagesDiscardDegradedRunDialog
          open
          plan={degradedDiscard.plan}
          reviewed={degradedDiscard.reviewed}
          submitting={degradedDiscard.busy}
          returnFocusRef={degradedDiscard.returnFocusRef}
          onReviewedChange={degradedDiscard.setReviewed}
          onOpenChange={(open) => {
            if (!open) degradedDiscard.close();
          }}
          onConfirm={() => void degradedDiscard.confirm()}
        />
      ) : null}
      <AlertDialog
        open={Boolean(runHistoryPrunePlan)}
        onOpenChange={(open) => {
          if (!open) setRunHistoryPrunePlan(undefined);
        }}
        title="Clear oldest run history?"
        description={
          runHistoryPrunePlan ? (
            <div className="space-y-2">
              <p>
                This clears {runHistoryPrunePlan.candidateRunCount} of the oldest terminal run
                records across all Create Images workflows. Aiden will keep at least the newest{" "}
                {runHistoryPrunePlan.keepLatest} records.
              </p>
              <p>
                {runHistoryPrunePlan.releasedAssetCount} retained image or asset reference
                {runHistoryPrunePlan.releasedAssetCount === 1 ? "" : "s"} will be released. These
                may include imported inputs and generated outputs. Any released file with no other
                workflow or run reference may later be removed by device-local cleanup.
              </p>
              <p>This does not rerun, stop, or submit provider work.</p>
            </div>
          ) : undefined
        }
        confirmLabel={
          runHistoryPrunePlan
            ? `Clear ${runHistoryPrunePlan.candidateRunCount} record${runHistoryPrunePlan.candidateRunCount === 1 ? "" : "s"}`
            : "Clear records"
        }
        confirmVariant="destructive"
        busy={runHistoryPruneBusy}
        keepOpenOnConfirm
        returnFocus={() => runHistoryPruneReturnFocusRef.current}
        onConfirm={() => void confirmRunHistoryPrune()}
      />
    </div>
  );
}

function DurableWorkflowView({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useCreateImagesWorkspace();
  const workspaceReady = workspace.data?.status === "ready";
  const workflow = useCreateImagesWorkflow(workflowId, workspaceReady);
  const [workspaceBusy, setWorkspaceBusy] = React.useState(false);
  const [workspaceActionError, setWorkspaceActionError] = React.useState<string>();

  const chooseWorkspace = React.useCallback(async () => {
    if (workspaceBusy) return;
    setWorkspaceActionError(undefined);
    setWorkspaceBusy(true);
    try {
      const result = await createImagesApi.chooseWorkspace();
      if (result.status === "canceled") return;
      if (result.status !== "ready") {
        setWorkspaceActionError(result.message);
        await workspace.refetch();
        return;
      }
      queryClient.setQueryData(queryKeys.createImagesWorkspace, result.workspace);
    } catch {
      setWorkspaceActionError(
        "Aiden could not choose that folder. Try again or choose another folder.",
      );
    } finally {
      setWorkspaceBusy(false);
    }
  }, [queryClient, workspace, workspaceBusy]);

  const retryWorkspace = React.useCallback(async () => {
    if (workspaceBusy) return;
    setWorkspaceActionError(undefined);
    setWorkspaceBusy(true);
    try {
      await workspace.refetch();
    } catch {
      setWorkspaceActionError("Aiden could not check the image workspace. Try again.");
    } finally {
      setWorkspaceBusy(false);
    }
  }, [workspace, workspaceBusy]);

  if (workspace.isLoading || !workspaceReady) {
    return (
      <CreateImagesWorkspaceSetup
        loading={workspace.isLoading}
        status={workspace.data}
        actionError={workspaceActionError}
        busy={workspaceBusy ? "workspace-choose" : undefined}
        onChoose={() => void chooseWorkspace()}
        onRetry={() => void retryWorkspace()}
        onBack={() => void navigate({ to: "/create-images" })}
      />
    );
  }
  if (workflow.isLoading) return <LoadingWorkflow />;
  if (workflow.isError || !workflow.data) {
    return (
      <WorkflowFailure
        title="Workflow unavailable"
        message="Aiden could not read this device-local workflow."
        retry={() => void workflow.refetch()}
      />
    );
  }
  const result: CreateImagesWorkflowLoadResult = workflow.data;
  if (result.status === "ready") {
    return (
      <PersistentWorkflowCanvas
        key={result.workflow.id}
        initial={result.workflow}
        initialMissingAssetIds={result.missingAssetIds}
      />
    );
  }
  if (result.status === "recovery-required" || result.status === "unsafe") {
    return (
      <RecoveryWorkflow
        workflowId={workflowId}
        recovery={result.recovery}
        reload={() => workflow.refetch()}
      />
    );
  }
  if (result.status === "not-found") {
    return (
      <WorkflowFailure title="Workflow not found" message="That workflow was deleted or moved." />
    );
  }
  return (
    <WorkflowFailure
      title="Workflow unavailable"
      message={result.message}
      retry={() => void workflow.refetch()}
    />
  );
}

export function CreateImagesWorkflowView({ workflowId }: { workflowId: string }) {
  const fixture = React.useMemo(
    () =>
      workflowId === "stress-100" || workflowId === "stress-250"
        ? createImagesFixture(workflowId)
        : undefined,
    [workflowId],
  );
  if (fixture) {
    return (
      <WorkflowCanvas
        key={workflowId}
        document={fixture}
        onBack={() => {
          window.history.back();
        }}
      />
    );
  }
  return <DurableWorkflowView workflowId={workflowId} />;
}
