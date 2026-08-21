import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleStop,
  Clock3,
  ClipboardCopy,
  Cloud,
  Cpu,
  Download,
  History,
  Image as ImageIcon,
  LoaderCircle,
  OctagonX,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
  Workflow,
} from "lucide-react";
import { Button, toast } from "../components/ui";
import type {
  CreateImagesAssetGrantView,
  CreateImagesDegradedRunDiscardPlanResult,
  CreateImagesRunDetailResult,
  CreateImagesRunRecoveryView,
  CreateImagesRunView,
} from "../shared/create-images/ipc";
import { createImagesAdaptiveAssetGrantUrl } from "../shared/create-images/ipc";
import {
  CREATE_IMAGES_RUN_STATUS_LABELS,
  createImagesSafeRunDiagnosticSummary,
  createImagesRunErrorViewModel,
  createImagesTerminalRunHistoryViews,
  summarizeCreateImagesRunProgress,
  type CreateImagesNodeRunUiState,
  type CreateImagesNodeRunUiStatus,
  type CreateImagesRunConfirmationViewModel,
  type CreateImagesRunErrorAction,
  type CreateImagesRunErrorViewModel,
  type CreateImagesRunUiStatus,
  type CreateImagesTerminalRunHistoryItem,
} from "./run-ui-core";
import { type CreateImagesDownstreamPathChoiceView } from "./run-path-core";
import { CreateImagesDownstreamPathChooser } from "./run-path-chooser";
import { CreateImagesAmbiguityAcknowledgement } from "./run-ambiguity-confirmation";
import { CreateImagesDegradedRunDiscardConfirmation } from "./run-degraded-discard-confirmation";
import "./run-ui.css";

type FocusTargetRef = React.RefObject<HTMLElement | null>;

function restoreFocus(event: Event, target?: FocusTargetRef): void {
  if (!target?.current) return;
  event.preventDefault();
  target.current.focus();
}

export function CreateImagesRunConfirmationDialog({
  open,
  model,
  reviewed,
  submitting = false,
  downstreamPathSelection,
  returnFocusRef,
  onReviewedChange,
  onDownstreamPathSelectionChange,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  model: CreateImagesRunConfirmationViewModel;
  reviewed: boolean;
  submitting?: boolean;
  downstreamPathSelection?: {
    startNodeLabel: string;
    choices: readonly CreateImagesDownstreamPathChoiceView[];
    selectedChoiceId?: string;
    truncated: boolean;
    overflowReason?: "choice-limit" | "search-budget";
    unavailablePathCount: number;
  };
  returnFocusRef?: FocusTargetRef;
  onReviewedChange(reviewed: boolean): void;
  onDownstreamPathSelectionChange?(choiceId: string): void;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const reviewRef = React.useRef<HTMLInputElement | null>(null);
  const firstPathChoiceRef = React.useRef<HTMLInputElement | null>(null);
  const pathSelectionComplete =
    downstreamPathSelection === undefined || downstreamPathSelection.selectedChoiceId !== undefined;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="create-images-run-dialog-overlay" />
        <DialogPrimitive.Content
          className="create-images-run-dialog"
          data-create-images-run-confirmation
          data-slot="dialog-content"
          data-mock={model.isMock || undefined}
          aria-busy={submitting || undefined}
          onEscapeKeyDown={(event) => {
            if (submitting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (submitting) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (downstreamPathSelection) firstPathChoiceRef.current?.focus();
            else reviewRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => restoreFocus(event, returnFocusRef)}
        >
          <header className="create-images-run-dialog-heading">
            <span className="create-images-run-dialog-icon" aria-hidden="true">
              {model.isMock ? <Cpu /> : <Cloud />}
            </span>
            <div>
              <DialogPrimitive.Title>{model.title}</DialogPrimitive.Title>
              <DialogPrimitive.Description>
                Review the immutable run plan for workflow revision {model.workflowRevision}.
              </DialogPrimitive.Description>
            </div>
          </header>

          {model.isMock ? (
            <div className="create-images-run-mock-banner" role="status">
              <ShieldCheck aria-hidden="true" />
              <span>
                <strong>Local mock</strong>
                No network request or billable provider work will occur.
              </span>
            </div>
          ) : null}

          {downstreamPathSelection ? (
            <CreateImagesDownstreamPathChooser
              {...downstreamPathSelection}
              firstChoiceRef={firstPathChoiceRef}
              onSelectionChange={(choiceId) => {
                onReviewedChange(false);
                onDownstreamPathSelectionChange?.(choiceId);
              }}
            />
          ) : null}

          {pathSelectionComplete ? (
            <dl
              className="create-images-run-plan"
              aria-label="Run confirmation summary"
              aria-live="polite"
            >
              {model.rows.map((row) => (
                <div key={row.id} className="create-images-run-plan-row" data-row={row.id}>
                  <dt>{row.label}</dt>
                  <dd>
                    <strong>{row.value}</strong>
                    {row.detail ? <span>{row.detail}</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          {pathSelectionComplete ? (
            <section className="create-images-run-privacy" aria-labelledby="run-privacy-title">
              <div className="create-images-run-section-title">
                <ShieldCheck aria-hidden="true" />
                <h3 id="run-privacy-title">Privacy and consent</h3>
              </div>
              <ul>
                {model.privacyNotices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {pathSelectionComplete ? (
            <label className="create-images-run-review-check">
              <input
                ref={reviewRef}
                type="checkbox"
                checked={reviewed}
                disabled={submitting}
                onChange={(event) => onReviewedChange(event.target.checked)}
              />
              <span>
                <strong>Review complete</strong>
                {model.consentStatement}
              </span>
            </label>
          ) : null}

          <footer className="create-images-run-dialog-actions">
            <Button variant="transparent" disabled={submitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              disabled={!pathSelectionComplete || !reviewed || submitting}
              onClick={onConfirm}
            >
              {submitting ? <LoaderCircle className="create-images-run-spinner" /> : <Play />}
              {submitting ? "Starting…" : model.confirmLabel}
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function CreateImagesResolveRunAmbiguityDialog({
  open,
  journalRevision,
  reviewed,
  submitting = false,
  returnFocusRef,
  onReviewedChange,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  journalRevision: number;
  reviewed: boolean;
  submitting?: boolean;
  returnFocusRef?: FocusTargetRef;
  onReviewedChange(reviewed: boolean): void;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const reviewRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="create-images-run-dialog-overlay" />
        <DialogPrimitive.Content
          className="create-images-run-dialog"
          data-create-images-ambiguity-confirmation
          data-slot="dialog-content"
          aria-busy={submitting || undefined}
          onEscapeKeyDown={(event) => {
            if (submitting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (submitting) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => restoreFocus(event, returnFocusRef)}
        >
          <header className="create-images-run-dialog-heading">
            <span className="create-images-run-dialog-icon" data-tone="danger" aria-hidden="true">
              <CircleAlert />
            </span>
            <div>
              <DialogPrimitive.Title>Acknowledge unresolved submission?</DialogPrimitive.Title>
              <DialogPrimitive.Description>
                Review the consequences before unlocking new runs. Durable journal revision{" "}
                {journalRevision}.
              </DialogPrimitive.Description>
            </div>
          </header>
          <CreateImagesAmbiguityAcknowledgement
            reviewed={reviewed}
            disabled={submitting}
            reviewRef={reviewRef}
            onReviewedChange={onReviewedChange}
          />
          <footer className="create-images-run-dialog-actions">
            <Button
              ref={cancelRef}
              variant="transparent"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Keep blocked
            </Button>
            <Button variant="accent" disabled={!reviewed || submitting} onClick={onConfirm}>
              {submitting ? (
                <LoaderCircle className="create-images-run-spinner" />
              ) : (
                <CircleAlert />
              )}
              {submitting ? "Acknowledging…" : "Acknowledge & allow new run"}
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function CreateImagesDiscardDegradedRunDialog({
  open,
  plan,
  reviewed,
  submitting = false,
  returnFocusRef,
  onReviewedChange,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  plan: Extract<CreateImagesDegradedRunDiscardPlanResult, { status: "ready" }>;
  reviewed: boolean;
  submitting?: boolean;
  returnFocusRef?: FocusTargetRef;
  onReviewedChange(reviewed: boolean): void;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const reviewRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="create-images-run-dialog-overlay" />
        <DialogPrimitive.Content
          className="create-images-run-dialog"
          data-create-images-degraded-discard
          data-slot="dialog-content"
          aria-busy={submitting || undefined}
          onEscapeKeyDown={(event) => {
            if (submitting) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (submitting) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => restoreFocus(event, returnFocusRef)}
        >
          <header className="create-images-run-dialog-heading">
            <span className="create-images-run-dialog-icon" data-tone="danger" aria-hidden="true">
              <Trash2 />
            </span>
            <div>
              <DialogPrimitive.Title>Permanently discard this run record?</DialogPrimitive.Title>
              <DialogPrimitive.Description>
                Review the irreversible storage and duplicate-work consequences.
              </DialogPrimitive.Description>
            </div>
          </header>
          <CreateImagesDegradedRunDiscardConfirmation
            plan={plan}
            reviewed={reviewed}
            disabled={submitting}
            reviewRef={reviewRef}
            onReviewedChange={onReviewedChange}
          />
          <footer className="create-images-run-dialog-actions">
            <Button
              ref={cancelRef}
              variant="transparent"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Keep record
            </Button>
            <Button variant="destructive" disabled={!reviewed || submitting} onClick={onConfirm}>
              {submitting ? <LoaderCircle className="create-images-run-spinner" /> : <Trash2 />}
              {submitting ? "Discarding…" : "Permanently discard record"}
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function CreateImagesStopRunDialog({
  open,
  stopping = false,
  queuedNodeCount,
  runningNodeCount,
  providerMayComplete,
  returnFocusRef,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  stopping?: boolean;
  queuedNodeCount: number;
  runningNodeCount: number;
  providerMayComplete: boolean;
  returnFocusRef?: FocusTargetRef;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!stopping) onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="create-images-run-dialog-overlay" />
        <DialogPrimitive.Content
          className="create-images-run-dialog create-images-stop-dialog"
          data-create-images-stop-confirmation
          data-slot="dialog-content"
          aria-busy={stopping || undefined}
          onEscapeKeyDown={(event) => {
            if (stopping) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (stopping) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => restoreFocus(event, returnFocusRef)}
        >
          <header className="create-images-run-dialog-heading">
            <span className="create-images-run-dialog-icon" data-tone="danger" aria-hidden="true">
              <Square />
            </span>
            <div>
              <DialogPrimitive.Title>Stop this workflow run?</DialogPrimitive.Title>
              <DialogPrimitive.Description>
                Aiden will stop admitting queued work and request cancellation for active work.
              </DialogPrimitive.Description>
            </div>
          </header>
          <dl className="create-images-stop-summary">
            <div>
              <dt>Queued</dt>
              <dd>{queuedNodeCount} nodes</dd>
            </div>
            <div>
              <dt>Running</dt>
              <dd>{runningNodeCount} nodes</dd>
            </div>
          </dl>
          <div className="create-images-stop-note" role={providerMayComplete ? "alert" : "status"}>
            <CircleAlert aria-hidden="true" />
            <span>
              {providerMayComplete
                ? "A submitted provider request may still complete or incur cost. Any valid late result stays attached only to this cancelled run."
                : "Completed outputs stay available locally. Work that has not started will be cancelled."}
            </span>
          </div>
          <footer className="create-images-run-dialog-actions">
            <Button
              ref={cancelRef}
              variant="transparent"
              disabled={stopping}
              onClick={() => onOpenChange(false)}
            >
              Keep running
            </Button>
            <Button variant="destructive" disabled={stopping} onClick={onConfirm}>
              {stopping ? <LoaderCircle className="create-images-run-spinner" /> : <Square />}
              {stopping ? "Requesting stop…" : "Stop run"}
            </Button>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const NODE_STATUS_PRESENTATION = {
  queued: { label: "Queued", Icon: Clock3 },
  running: { label: "Running", Icon: LoaderCircle },
  retry: { label: "Retry needed", Icon: RotateCcw },
  blocked: { label: "Blocked", Icon: Ban },
  failed: { label: "Failed", Icon: OctagonX },
  cancelled: { label: "Cancelled", Icon: CircleStop },
  succeeded: { label: "Succeeded", Icon: CircleCheck },
} satisfies Record<
  CreateImagesNodeRunUiStatus,
  { label: string; Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> }
>;

const RUN_STATUS_PRESENTATION = {
  "awaiting-consent": { label: "Waiting for confirmation", Icon: ShieldCheck },
  queued: { label: "Queued", Icon: Clock3 },
  running: { label: "Running", Icon: LoaderCircle },
  paused: { label: "Paused", Icon: CircleStop },
  stopping: { label: "Stopping", Icon: Square },
  retry: { label: "Retry needs review", Icon: RotateCcw },
  failed: { label: "Failed", Icon: OctagonX },
  cancelled: { label: "Cancelled", Icon: CircleStop },
  succeeded: { label: "Succeeded", Icon: CircleCheck },
  interrupted: { label: "Interrupted", Icon: CircleAlert },
} satisfies Record<
  CreateImagesRunUiStatus,
  { label: string; Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> }
>;

export function CreateImagesNodeRunStatusBadge({
  status,
  retryMode,
  compact = false,
}: {
  status: CreateImagesNodeRunUiStatus;
  retryMode?: CreateImagesNodeRunUiState["retryMode"];
  compact?: boolean;
}) {
  const presentation = NODE_STATUS_PRESENTATION[status];
  const label =
    status === "retry" && retryMode === "automatic-mock"
      ? "Local retry waiting"
      : presentation.label;
  return (
    <span
      className="create-images-run-status"
      data-status={status}
      data-compact={compact || undefined}
      aria-label={`Node status: ${label}`}
    >
      <presentation.Icon
        className={status === "running" ? "create-images-run-spinner" : undefined}
        aria-hidden={true}
      />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}

export function CreateImagesRunStatusBadge({ status }: { status: CreateImagesRunUiStatus }) {
  const presentation = RUN_STATUS_PRESENTATION[status];
  return (
    <span
      className="create-images-run-status"
      data-status={status}
      aria-label={`Run status: ${presentation.label}`}
    >
      <presentation.Icon
        className={status === "running" ? "create-images-run-spinner" : undefined}
        aria-hidden={true}
      />
      {presentation.label}
    </span>
  );
}

const ERROR_ACTION_LABELS: Readonly<Record<CreateImagesRunErrorAction, string>> = {
  "review-retry": "Review & retry",
  "check-connection": "Check connection",
  "open-provider-settings": "Provider settings",
  "manage-storage": "Manage storage",
  "view-history": "View run record",
};

export function CreateImagesRunErrorCard({
  error,
  nodeLabel,
  onAction,
}: {
  error: CreateImagesRunErrorViewModel;
  nodeLabel?: string;
  onAction?(action: CreateImagesRunErrorAction, trigger: HTMLButtonElement): void;
}) {
  return (
    <section
      className="create-images-run-error"
      role="alert"
      aria-label={nodeLabel ? `${nodeLabel} error` : "Run error"}
    >
      <CircleAlert aria-hidden="true" />
      <div className="create-images-run-error-copy">
        <h3>{error.title}</h3>
        <p>{error.description}</p>
        {error.retainedOutputLabel ? <p>{error.retainedOutputLabel}</p> : null}
        <p className="create-images-run-error-next">{error.nextStep}</p>
        {onAction && error.actions.length > 0 ? (
          <div className="create-images-run-error-actions">
            {error.actions.map((action) =>
              action === "review-retry" && !error.retry.available ? null : (
                <Button
                  key={action}
                  size="small"
                  variant={action === "review-retry" ? "filled" : "transparent"}
                  onClick={(event) => onAction(action, event.currentTarget)}
                >
                  {action === "review-retry" ? <RotateCcw /> : null}
                  {action === "review-retry" ? error.retry.label : ERROR_ACTION_LABELS[action]}
                </Button>
              ),
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function runNodeTitle(label: string): string {
  const separator = label.indexOf(" · ");
  return separator > 0 ? label.slice(0, separator) : label;
}

function NodeProgressRow({
  node,
  onRetry,
  onErrorAction,
}: {
  node: CreateImagesNodeRunUiState;
  onRetry?(nodeId: string, error: CreateImagesRunErrorViewModel, trigger: HTMLButtonElement): void;
  onErrorAction?(
    nodeId: string,
    action: CreateImagesRunErrorAction,
    trigger: HTMLButtonElement,
  ): void;
}) {
  const error = node.error ? createImagesRunErrorViewModel(node.error) : undefined;
  const percentage = node.progress
    ? Math.round((node.progress.completed / node.progress.total) * 100)
    : undefined;
  return (
    <li className="create-images-run-node" data-status={node.status}>
      <div className="create-images-run-node-main">
        <span className="create-images-run-node-glyph" aria-hidden="true">
          <ImageIcon />
        </span>
        <span className="create-images-run-node-copy">
          <strong>{runNodeTitle(node.label)}</strong>
        </span>
        <CreateImagesNodeRunStatusBadge status={node.status} retryMode={node.retryMode} />
      </div>
      {node.progress ? (
        <div className="create-images-run-node-progress">
          <span>
            {node.progress.label} · {percentage}%
          </span>
          <progress
            max={node.progress.total}
            value={node.progress.completed}
            aria-label={`${node.label}: ${node.progress.label}`}
          />
        </div>
      ) : null}
      {node.status === "blocked" ? (
        <p className="create-images-run-node-note">
          Skipped because a required earlier step did not finish. No request was sent.
        </p>
      ) : null}
      {node.status === "retry" && node.retryMode === "automatic-mock" ? (
        <p className="create-images-run-node-note">
          The deterministic local mock is waiting for its bounded retry. No provider request or
          billable work is involved.
        </p>
      ) : null}
      {error ? (
        <div className="create-images-run-node-error">
          <strong>{error.title}</strong>
          <span>{error.nextStep}</span>
          <div>
            {error.retry.available && node.retryMode !== "automatic-mock" && onRetry ? (
              <Button
                size="small"
                variant="filled"
                onClick={(event) => onRetry(node.nodeId, error, event.currentTarget)}
              >
                <RotateCcw /> {error.retry.label}
              </Button>
            ) : null}
            {onErrorAction
              ? error.actions.map((action) =>
                  action === "review-retry" ? null : (
                    <Button
                      key={action}
                      size="small"
                      variant="transparent"
                      onClick={(event) => onErrorAction(node.nodeId, action, event.currentTarget)}
                    >
                      {ERROR_ACTION_LABELS[action]}
                    </Button>
                  ),
                )
              : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function CreateImagesRunProgressPanel({
  title = "Current run",
  status,
  nodes,
  announcement,
  stopping = false,
  onStop,
  onResume,
  onOpenHistory,
  onRetryNode,
  onNodeErrorAction,
}: {
  title?: string;
  status: CreateImagesRunUiStatus;
  nodes: readonly CreateImagesNodeRunUiState[];
  announcement: string;
  stopping?: boolean;
  onStop?(trigger: HTMLButtonElement): void;
  onResume?(trigger: HTMLButtonElement): void;
  onOpenHistory?(): void;
  onRetryNode?(
    nodeId: string,
    error: CreateImagesRunErrorViewModel,
    trigger: HTMLButtonElement,
  ): void;
  onNodeErrorAction?(
    nodeId: string,
    action: CreateImagesRunErrorAction,
    trigger: HTMLButtonElement,
  ): void;
}) {
  const titleId = React.useId();
  const summary = summarizeCreateImagesRunProgress(nodes);
  const canStop =
    status === "queued" || status === "running" || status === "paused" || status === "stopping";
  return (
    <section className="create-images-run-panel" aria-labelledby={titleId} data-status={status}>
      <header className="create-images-run-panel-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          <p>{summary.label}</p>
        </div>
        <CreateImagesRunStatusBadge status={status} />
      </header>
      <div className="create-images-run-overall-progress">
        <progress
          max={Math.max(summary.total, 1)}
          value={summary.completed}
          aria-label={summary.label}
        />
        <div>
          <span>{summary.percentage}%</span>
          <span>{summary.active} active</span>
          <span>{summary.waiting} waiting</span>
          <span>{summary.failed} need attention</span>
        </div>
      </div>
      {nodes.length > 0 ? (
        <ol className="create-images-run-node-list" aria-label="Node run progress">
          {nodes.map((node) => (
            <NodeProgressRow
              key={node.nodeId}
              node={node}
              onRetry={onRetryNode}
              onErrorAction={onNodeErrorAction}
            />
          ))}
        </ol>
      ) : (
        <p className="create-images-run-empty">No nodes are scheduled for this run.</p>
      )}
      <footer className="create-images-run-panel-actions">
        {onOpenHistory ? (
          <Button size="small" variant="transparent" onClick={onOpenHistory}>
            <History /> Run history
          </Button>
        ) : null}
        {status === "paused" && onResume ? (
          <Button size="small" variant="accent" onClick={(event) => onResume(event.currentTarget)}>
            <Play /> Resume
          </Button>
        ) : null}
        {canStop && onStop ? (
          <Button
            size="small"
            variant="filled"
            disabled={stopping || status === "stopping"}
            onClick={(event) => onStop(event.currentTarget)}
          >
            <Square /> {stopping || status === "stopping" ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </footer>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </section>
  );
}

function safeHistoryDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "Date unavailable";
}

export type CreateImagesRunHistoryDetailState =
  | { status: "idle" }
  | { status: "loading"; runId: string }
  | CreateImagesRunDetailResult;

const RUN_VIEW_UI_STATUS: Readonly<Record<CreateImagesRunView["status"], CreateImagesRunUiStatus>> =
  {
    queued: "queued",
    running: "running",
    paused: "paused",
    cancel_requested: "stopping",
    needs_attention: "retry",
    succeeded: "succeeded",
    failed: "failed",
    cancelled: "cancelled",
    interrupted: "interrupted",
  };

function RunHistoryOutput({
  assetId,
  index,
  nodeLabel,
  preview,
  onMount,
  onLoad,
  onError,
  onDownload,
}: {
  assetId: string;
  index: number;
  nodeLabel: string;
  preview?: CreateImagesAssetGrantView;
  onMount?(assetId: string): () => void;
  onLoad?(assetId: string, token: string): void;
  onError?(assetId: string, token: string): void;
  onDownload?(assetId: string): void;
}) {
  React.useEffect(() => onMount?.(assetId), [assetId, onMount]);
  const label = `${nodeLabel} output ${index + 1}`;
  return preview ? (
    <figure className="create-images-run-history-output">
      <img
        src={createImagesAdaptiveAssetGrantUrl(preview.token, 256)}
        alt={label}
        draggable={false}
        onLoad={() => onLoad?.(assetId, preview.token)}
        onError={() => onError?.(assetId, preview.token)}
      />
      <figcaption>{label}</figcaption>
      {onDownload ? (
        <Button
          iconOnly
          size="small"
          variant="filled"
          aria-label={`Save ${label}`}
          title="Save image and reveal in Finder"
          onClick={() => onDownload(assetId)}
        >
          <Download />
        </Button>
      ) : null}
    </figure>
  ) : (
    <div
      className="create-images-run-history-output create-images-run-history-output-loading"
      role="status"
      aria-label={`Loading ${label}`}
    >
      <ImageIcon aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function RunHistoryDetail({
  detail,
  previews,
  recoveringRunId,
  acknowledgingRunId,
  discardPlanning,
  onRecover,
  onDiscard,
  onAcknowledgeAmbiguity,
  onAssetPreviewMount,
  onAssetPreviewLoad,
  onAssetPreviewError,
  onDownloadAsset,
}: {
  detail: CreateImagesRunHistoryDetailState;
  previews: Readonly<Record<string, CreateImagesAssetGrantView>>;
  recoveringRunId?: string;
  acknowledgingRunId?: string;
  discardPlanning?: boolean;
  onRecover?(recovery: CreateImagesRunRecoveryView, trigger: HTMLButtonElement): void;
  onDiscard?(runId: string, trigger: HTMLButtonElement): void;
  onAcknowledgeAmbiguity?(run: CreateImagesRunView, trigger: HTMLButtonElement): void;
  onAssetPreviewMount?(assetId: string): () => void;
  onAssetPreviewLoad?(assetId: string, token: string): void;
  onAssetPreviewError?(assetId: string, token: string): void;
  onDownloadAsset?(runId: string, assetId: string): void;
}) {
  if (detail.status === "idle") return null;
  if (detail.status === "loading") {
    return (
      <section
        id="create-images-run-history-detail"
        className="create-images-run-history-detail"
        aria-live="polite"
        aria-busy="true"
      >
        <LoaderCircle className="create-images-run-spinner" aria-hidden="true" />
        <p>Loading the durable run record…</p>
      </section>
    );
  }
  if (detail.status === "not-found" || detail.status === "unavailable") {
    return (
      <section
        id="create-images-run-history-detail"
        className="create-images-run-history-detail"
        role="alert"
      >
        <CircleAlert aria-hidden="true" />
        <p>
          {detail.status === "not-found"
            ? "This run record is no longer available."
            : detail.message}
        </p>
      </section>
    );
  }
  if (detail.status === "recovery-required" || detail.status === "unsafe") {
    const recovery = detail.recovery;
    const recoverySource =
      recovery.status === "recovery-required" ? recovery.recoverySource : undefined;
    const candidateRevision =
      recovery.status === "recovery-required"
        ? recovery.expectedCandidateJournalRevision
        : undefined;
    return (
      <section
        id="create-images-run-history-detail"
        className="create-images-run-history-detail create-images-run-recovery"
        role={detail.status === "unsafe" ? "alert" : "status"}
      >
        <CircleAlert aria-hidden="true" />
        <div>
          <h3>
            {detail.status === "unsafe" ? "Run record is read-only" : "Run record needs recovery"}
          </h3>
          <p>
            {detail.status === "unsafe"
              ? "A newer or unsafe journal format was preserved without exposing its contents. Aiden cannot safely inspect or recover it; you can keep it read-only or review permanent discard."
              : recoverySource === "last-known-good"
                ? "Aiden preserved the damaged current record. It can restore only from the verified last-known-good journal without repeating provider work."
                : recoverySource === "current"
                  ? "The current run record is verified, but its recovery copy needs repair. Aiden can repair that copy without repeating provider work."
                  : "Aiden preserved the damaged record, but no verified recovery source is currently available. No provider work will repeat automatically."}
          </p>
          {recoverySource && candidateRevision !== undefined ? (
            <p>
              Verified {recoverySource === "current" ? "current" : "last-known-good"} source ·
              journal revision {candidateRevision}
            </p>
          ) : null}
          {detail.status === "recovery-required" &&
          recovery.status === "recovery-required" &&
          recoverySource &&
          candidateRevision !== undefined &&
          onRecover ? (
            <Button
              size="small"
              variant="filled"
              disabled={recoveringRunId === recovery.runId}
              onClick={(event) => onRecover(recovery, event.currentTarget)}
            >
              {recoveringRunId === recovery.runId ? (
                <LoaderCircle className="create-images-run-spinner" />
              ) : (
                <RotateCcw />
              )}
              {recoveringRunId === recovery.runId
                ? recoverySource === "current"
                  ? "Repairing…"
                  : "Restoring…"
                : recoverySource === "current"
                  ? "Repair recovery copy"
                  : "Restore last-known-good"}
            </Button>
          ) : null}
          {onDiscard &&
          (detail.status === "unsafe" ||
            (recovery.status === "recovery-required" && recoverySource === undefined)) ? (
            <Button
              size="small"
              variant="transparent"
              disabled={discardPlanning}
              onClick={(event) => onDiscard(recovery.runId, event.currentTarget)}
            >
              <Trash2 /> Review permanent discard
            </Button>
          ) : null}
        </div>
      </section>
    );
  }
  const run: CreateImagesRunView = detail.run;
  const outputNodes = run.nodes.filter((node) => node.outputAssetIds.length > 0);
  const hasAmbiguousNode = run.nodes.some((node) => node.status === "ambiguous");
  const unresolvedAmbiguity =
    run.status === "needs_attention" && hasAmbiguousNode && !run.ambiguityResolution;
  return (
    <section
      id="create-images-run-history-detail"
      className="create-images-run-history-detail"
      aria-label="Selected durable run details"
    >
      <header>
        <div>
          <h3>Run record</h3>
          <p>
            Revision {run.workflowRevision} · {run.nodes.length} scheduled nodes
          </p>
        </div>
        <CreateImagesRunStatusBadge status={RUN_VIEW_UI_STATUS[run.status]} />
      </header>
      <div className="create-images-run-diagnostic-action">
        <Button
          size="small"
          variant="transparent"
          onClick={() => {
            void navigator.clipboard
              .writeText(createImagesSafeRunDiagnosticSummary(run))
              .then(
                () => toast.success("Safe run diagnostic copied."),
                () => toast.error("Run diagnostic could not be copied."),
              );
          }}
        >
          <ClipboardCopy /> Copy diagnostic summary
        </Button>
        <span>No prompts, paths, credentials, image bytes, or provider responses.</span>
      </div>
      {unresolvedAmbiguity ? (
        <section className="create-images-run-ambiguity-record" role="alert">
          <CircleAlert aria-hidden="true" />
          <div>
            <h4>Submission outcome remains unknown</h4>
            <p>
              Aiden cannot tell whether this submission completed. New runs stay blocked until you
              explicitly acknowledge the unresolved durable record.
            </p>
            {onAcknowledgeAmbiguity ? (
              <Button
                size="small"
                variant="filled"
                disabled={acknowledgingRunId === run.runId}
                onClick={(event) => onAcknowledgeAmbiguity(run, event.currentTarget)}
              >
                <CircleAlert /> Review acknowledgement
              </Button>
            ) : null}
          </div>
        </section>
      ) : run.ambiguityResolution ? (
        <section className="create-images-run-ambiguity-record" role="status">
          <CircleCheck aria-hidden="true" />
          <div>
            <h4>Unresolved submission acknowledged</h4>
            <p>
              Acknowledged {safeHistoryDate(run.ambiguityResolution.acknowledgedAt)}. The outcome is
              still unknown and the original audit record is unchanged; separately confirmed new
              runs are now allowed.
            </p>
          </div>
        </section>
      ) : null}
      {outputNodes.length === 0 ? (
        <p className="create-images-run-history-detail-empty">
          This run retained no image outputs.
        </p>
      ) : (
        <div className="create-images-run-history-output-groups">
          {outputNodes.map((node) => (
            <section key={node.nodeId} aria-label={`${node.label} retained outputs`}>
              <h4>{node.label}</h4>
              <div className="create-images-run-history-output-grid">
                {node.outputAssetIds.map((assetId, index) => (
                  <RunHistoryOutput
                    key={`${assetId}:${index}`}
                    assetId={assetId}
                    index={index}
                    nodeLabel={node.label}
                    preview={previews[assetId]}
                    onMount={onAssetPreviewMount}
                    onLoad={onAssetPreviewLoad}
                    onError={onAssetPreviewError}
                    onDownload={(assetId) => onDownloadAsset?.(run.runId, assetId)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

export function CreateImagesTerminalRunHistory({
  items,
  recoveries = [],
  selectedRunId,
  detail = { status: "idle" },
  previews = {},
  recoveringRunId,
  acknowledgingRunId,
  discardPlanning,
  onSelectRun,
  onRecover,
  onDiscard,
  onAcknowledgeAmbiguity,
  onManageHistory,
  historyManagementBusy = false,
  onAssetPreviewMount,
  onAssetPreviewLoad,
  onAssetPreviewError,
  onDownloadAsset,
}: {
  items: readonly CreateImagesTerminalRunHistoryItem[];
  recoveries?: readonly CreateImagesRunRecoveryView[];
  selectedRunId?: string;
  detail?: CreateImagesRunHistoryDetailState;
  previews?: Readonly<Record<string, CreateImagesAssetGrantView>>;
  recoveringRunId?: string;
  acknowledgingRunId?: string;
  discardPlanning?: boolean;
  onSelectRun?(runId: string, trigger: HTMLButtonElement): void;
  onRecover?(recovery: CreateImagesRunRecoveryView, trigger: HTMLButtonElement): void;
  onDiscard?(runId: string, trigger: HTMLButtonElement): void;
  onAcknowledgeAmbiguity?(run: CreateImagesRunView, trigger: HTMLButtonElement): void;
  onManageHistory?(trigger: HTMLButtonElement): void;
  historyManagementBusy?: boolean;
  onAssetPreviewMount?(assetId: string): () => void;
  onAssetPreviewLoad?(assetId: string, token: string): void;
  onAssetPreviewError?(assetId: string, token: string): void;
  onDownloadAsset?(runId: string, assetId: string): void;
}) {
  const titleId = React.useId();
  const views = createImagesTerminalRunHistoryViews(items);
  return (
    <section className="create-images-run-history" aria-labelledby={titleId}>
      <header>
        <span aria-hidden="true">
          <History />
        </span>
        <div>
          <h2 id={titleId}>Terminal run history</h2>
          <p>Durable summaries only. History never repeats a request.</p>
        </div>
        {onManageHistory ? (
          <Button
            iconOnly
            size="small"
            variant="transparent"
            disabled={historyManagementBusy}
            aria-label="Clear oldest Create Images run history"
            title="Clear oldest history"
            onClick={(event) => onManageHistory(event.currentTarget)}
          >
            <Trash2 />
          </Button>
        ) : null}
      </header>
      {views.length === 0 && recoveries.length === 0 ? (
        <p className="create-images-run-history-empty">
          Completed and interrupted runs will appear here.
        </p>
      ) : (
        <ol aria-label="Terminal image workflow runs">
          {views.map((item) => (
            <li key={item.runId}>
              <button
                type="button"
                className="create-images-run-history-row"
                data-selected={selectedRunId === item.runId || undefined}
                aria-pressed={selectedRunId === item.runId}
                aria-controls="create-images-run-history-detail"
                onClick={(event) => onSelectRun?.(item.runId, event.currentTarget)}
              >
                <span className="create-images-run-history-lead">
                  <CreateImagesRunStatusBadge status={item.status} />
                  <strong>{item.scopeLabel}</strong>
                  <time dateTime={item.finishedAt}>{safeHistoryDate(item.finishedAt)}</time>
                </span>
                <span className="create-images-run-history-meta">
                  <span>
                    {item.providerLabel} · {item.modelLabel}
                  </span>
                  <span>
                    {item.requestCount} {item.requestCount === 1 ? "request" : "requests"}
                  </span>
                  <span>{item.nodeSummary}</span>
                  <span>{item.outputSummary}</span>
                  <span>{item.costLabel}</span>
                  {item.ambiguityAcknowledged ? (
                    <span>Unresolved submission acknowledged</span>
                  ) : null}
                  <span>{item.durationLabel}</span>
                </span>
              </button>
            </li>
          ))}
          {recoveries.map((recovery) => (
            <li key={recovery.runId}>
              <button
                type="button"
                className="create-images-run-history-row create-images-run-recovery-row"
                data-selected={selectedRunId === recovery.runId || undefined}
                aria-pressed={selectedRunId === recovery.runId}
                aria-controls="create-images-run-history-detail"
                onClick={(event) => onSelectRun?.(recovery.runId, event.currentTarget)}
              >
                <span className="create-images-run-history-lead">
                  <CircleAlert aria-hidden="true" />
                  <strong>
                    {recovery.status === "unsafe" ? "Read-only run record" : "Recovery required"}
                  </strong>
                </span>
                <span className="create-images-run-history-meta">
                  <span>
                    {recovery.status === "recovery-required" && recovery.recoverySource
                      ? `Verified ${recovery.recoverySource === "current" ? "current" : "last-known-good"} revision ${recovery.expectedCandidateJournalRevision}`
                      : "Durable journal preserved"}
                  </span>
                  <span>No work will be repeated automatically</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <RunHistoryDetail
        detail={detail}
        previews={previews}
        recoveringRunId={recoveringRunId}
        acknowledgingRunId={acknowledgingRunId}
        discardPlanning={discardPlanning}
        onRecover={onRecover}
        onDiscard={onDiscard}
        onAcknowledgeAmbiguity={onAcknowledgeAmbiguity}
        onAssetPreviewMount={onAssetPreviewMount}
        onAssetPreviewLoad={onAssetPreviewLoad}
        onAssetPreviewError={onAssetPreviewError}
        onDownloadAsset={onDownloadAsset}
      />
    </section>
  );
}

export function CreateImagesRunControls({
  status,
  selectedNodeLabel,
  runAllDisabledReason,
  runFromHereDisabledReason,
  onRunAll,
  onRunFromHere,
  onStop,
  onResume,
  onOpenHistory,
  historyOpen = false,
}: {
  status?: CreateImagesRunUiStatus;
  selectedNodeLabel?: string;
  runAllDisabledReason?: string;
  runFromHereDisabledReason?: string;
  onRunAll(trigger: HTMLButtonElement): void;
  onRunFromHere?(trigger: HTMLButtonElement): void;
  onStop?(trigger: HTMLButtonElement): void;
  onResume?(trigger: HTMLButtonElement): void;
  onOpenHistory(): void;
  historyOpen?: boolean;
}) {
  const runAllReasonId = React.useId();
  const runFromHereReasonId = React.useId();
  const active =
    status === "queued" || status === "running" || status === "paused" || status === "stopping";
  const runFromHereReason =
    runFromHereDisabledReason ??
    (!selectedNodeLabel
      ? "Select a node to run from here"
      : !onRunFromHere
        ? "Run from here is unavailable"
        : undefined);
  return (
    <div className="create-images-run-controls" role="group" aria-label="Workflow run controls">
      {active && onStop ? (
        <>
          {status === "paused" && onResume ? (
            <Button size="small" variant="accent" onClick={(event) => onResume(event.currentTarget)}>
              <Play /> <span>Resume</span>
            </Button>
          ) : null}
          <Button
            size="small"
            variant="filled"
            disabled={status === "stopping"}
            aria-label={status === "stopping" ? "Stopping workflow run" : "Stop workflow run"}
            onClick={(event) => onStop(event.currentTarget)}
          >
            <Square /> <span>{status === "stopping" ? "Stopping…" : "Stop"}</span>
          </Button>
        </>
      ) : (
        <>
          <Button
            size="small"
            variant="accent"
            className="aria-disabled:opacity-45"
            aria-label="Run workflow"
            aria-disabled={Boolean(runAllDisabledReason)}
            aria-describedby={runAllDisabledReason ? runAllReasonId : undefined}
            title={runAllDisabledReason}
            onClick={(event) => {
              if (!runAllDisabledReason) onRunAll(event.currentTarget);
            }}
          >
            <Workflow /> <span>Run workflow</span>
          </Button>
          <Button
            size="small"
            variant="filled"
            className="aria-disabled:opacity-45"
            aria-label={selectedNodeLabel ? `Run from ${selectedNodeLabel}` : "Run from here"}
            aria-disabled={Boolean(runFromHereReason)}
            aria-describedby={runFromHereReason ? runFromHereReasonId : undefined}
            title={runFromHereReason ?? `Run from ${selectedNodeLabel}`}
            onClick={(event) => {
              if (!runFromHereReason) onRunFromHere?.(event.currentTarget);
            }}
          >
            <Play /> <span>Run from here</span>
          </Button>
        </>
      )}
      <Button
        iconOnly
        size="small"
        variant="transparent"
        aria-label={historyOpen ? "Close terminal run history" : "Open terminal run history"}
        aria-pressed={historyOpen}
        onClick={onOpenHistory}
      >
        <History />
      </Button>
      {status ? <span className="sr-only">{CREATE_IMAGES_RUN_STATUS_LABELS[status]}</span> : null}
      {runAllDisabledReason ? (
        <span id={runAllReasonId} className="sr-only">
          {runAllDisabledReason}
        </span>
      ) : null}
      {runFromHereReason ? (
        <span id={runFromHereReasonId} className="sr-only">
          {runFromHereReason}
        </span>
      ) : null}
    </div>
  );
}
