import * as React from "react";
import {
  AlertCircle,
  Binary,
  Check,
  FileCode2,
  GitBranch,
  GitCompareArrows,
  RefreshCw,
} from "lucide-react";
import {
  Button,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
} from "./ui";
import { gitApi } from "../lib/ipc";
import { useGitBranches, useGitComparison, useGitReview } from "../lib/queries";
import { cn } from "../lib/ui-utils";
import type { GitComparison, GitFileDiff, GitReviewFile, Workspace } from "../lib/types";
import type { EnvironmentReviewMode } from "./environment-panel";

interface LoadState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface DiffLoadState extends LoadState<GitFileDiff> {
  requestKey: string | null;
}

const STATUS_LABEL: Record<GitReviewFile["status"], string> = {
  added: "A",
  conflicted: "U",
  copied: "C",
  deleted: "D",
  modified: "M",
  renamed: "R",
  untracked: "?",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function fileName(value: string): string {
  return value.split("/").pop() || value;
}

function parentPath(value: string): string {
  const parts = value.split("/");
  parts.pop();
  return parts.join("/");
}

function useFileDiff(
  workspaceId: string | undefined,
  path: string | null,
  active: boolean,
  snapshotKey: string,
  expectedReviewSnapshot?: string,
  comparison?: GitComparison,
) {
  const requestKey = workspaceId && path
    ? [workspaceId, path, snapshotKey].join("\u0000")
    : null;
  const [state, setState] = React.useState<DiffLoadState>({
    data: null,
    error: null,
    loading: false,
    requestKey: null,
  });
  React.useEffect(() => {
    let cancelled = false;
    if (!workspaceId || !path) {
      setState({ data: null, error: null, loading: false, requestKey: null });
      return;
    }
    if (!active) return;
    if (!comparison && !expectedReviewSnapshot) {
      setState({
        data: null,
        error: "This review is too large to freeze safely. Refresh changes or open the file directly.",
        loading: false,
        requestKey,
      });
      return;
    }
    setState((current) => ({
      data: current.requestKey === requestKey ? current.data : null,
      error: null,
      loading: true,
      requestKey,
    }));
    const request = comparison
      ? gitApi.comparisonDiff(workspaceId, {
          expectedHead: comparison.expectedHead,
          expectedTarget: comparison.expectedTarget,
          mergeBase: comparison.mergeBase,
          path,
          targetRef: comparison.targetRef,
        })
      : gitApi.diff(workspaceId, {
          expectedSnapshot: expectedReviewSnapshot as string,
          path,
        });
    void request.then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false, requestKey });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState((current) => ({
            data: current.requestKey === requestKey ? current.data : null,
            error: errorMessage(error, "Aiden could not load this diff."),
            loading: false,
            requestKey,
          }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, comparison, expectedReviewSnapshot, path, requestKey, workspaceId]);
  if (state.requestKey !== requestKey) {
    return {
      data: null,
      error: null,
      loading: Boolean(active && requestKey),
    };
  }
  return state;
}

type DiffLineKind = "addition" | "context" | "deletion" | "hunk" | "meta";

interface DiffLine {
  key: string;
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  content: string;
}

export function parseUnifiedDiff(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  patch.split("\n").forEach((line, index) => {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      result.push({ key: `${index}-hunk`, kind: "hunk", content: line });
      return;
    }
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file ") || line.startsWith("deleted file ") || line.startsWith("similarity ") || line.startsWith("rename ") || line.startsWith("Binary ") || line === "\\ No newline at end of file") {
      result.push({ key: `${index}-meta`, kind: "meta", content: line });
      return;
    }
    if (line.startsWith("+")) {
      result.push({ key: `${index}-add`, kind: "addition", newLine, content: line.slice(1) });
      newLine += 1;
      return;
    }
    if (line.startsWith("-")) {
      result.push({ key: `${index}-delete`, kind: "deletion", oldLine, content: line.slice(1) });
      oldLine += 1;
      return;
    }
    if (line.startsWith(" ")) {
      result.push({
        key: `${index}-context`,
        kind: "context",
        oldLine,
        newLine,
        content: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      return;
    }
    if (line) result.push({ key: `${index}-meta`, kind: "meta", content: line });
  });
  return result;
}

function ReviewSkeleton() {
  return (
    <div className="space-y-2 p-3" aria-label="Loading workspace changes">
      {[72, 86, 64, 78].map((width, index) => (
        <div key={index} className="flex h-10 items-center gap-3 rounded-control bg-well px-3">
          <span className="size-5 animate-pulse rounded-md bg-control" />
          <span className="h-2.5 animate-pulse rounded-pill bg-control" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

function DiffViewer({ diff }: { diff: GitFileDiff }) {
  const lines = React.useMemo(() => parseUnifiedDiff(diff.patch), [diff.patch]);
  if (diff.binary) {
    return (
      <EmptyState
        className="h-full"
        title="Binary change"
        description="Aiden can list this change, but there is no text diff to display."
      />
    );
  }
  if (lines.length === 0) {
    return (
      <EmptyState
        className="h-full"
        title="No textual changes"
        description="The file state changed without a line-level diff. Refresh if the workspace is still changing."
      />
    );
  }
  return (
    <div className="code-font-sized h-full overflow-auto bg-background font-mono leading-[18px] select-text">
      {diff.truncated ? (
        <div className="sticky top-0 z-10 border-b border-support-warning/25 bg-popover px-3 py-2 font-sans text-small text-support-warning">
          This large diff is truncated.
        </div>
      ) : null}
      <div className="min-w-max py-2">
        {lines.map((line) => (
          <div
            key={line.key}
            data-diff-line-kind={line.kind}
            className={cn(
              "grid min-h-[18px] grid-cols-[42px_42px_minmax(320px,1fr)]",
              line.kind === "addition" && "bg-support-green/[0.09]",
              line.kind === "deletion" && "bg-support-red/[0.09]",
              line.kind === "hunk" && "my-1 bg-accent/[0.08] text-accent",
              line.kind === "meta" && "text-tertiary",
            )}
          >
            <span className="border-r border-separator px-2 text-right tabular-nums text-tertiary">
              {line.oldLine ?? ""}
            </span>
            <span className="border-r border-separator px-2 text-right tabular-nums text-tertiary">
              {line.newLine ?? ""}
            </span>
            <pre className="m-0 whitespace-pre px-3 text-primary">
              {line.kind === "addition" || line.kind === "deletion" ? (
                <span className="sr-only">{line.kind === "addition" ? "Added line: " : "Deleted line: "}</span>
              ) : null}
              <span className="diff-line-marker" aria-hidden="true">
                {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
              </span>
              {line.content}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewFileContent({
  workspaceId,
  active,
  files,
  snapshotKey,
  expectedReviewSnapshot,
  comparison,
  onOpenFile,
}: {
  workspaceId: string;
  active: boolean;
  files: GitReviewFile[];
  snapshotKey: string;
  expectedReviewSnapshot?: string;
  comparison?: GitComparison;
  onOpenFile: (path: string) => void;
}) {
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [diffRetryKey, setDiffRetryKey] = React.useState(0);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;

  React.useEffect(() => {
    setSelectedPath(null);
    setDiffRetryKey((value) => value + 1);
  }, [comparison?.targetRef, workspaceId]);

  React.useEffect(() => {
    if (files.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !files.some((file) => file.path === selectedPath)) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

  const diff = useFileDiff(
    workspaceId,
    selectedFile?.path ?? null,
    active,
    `${snapshotKey}:${diffRetryKey}`,
    expectedReviewSnapshot,
    comparison,
  );

  return (
    <>
      <div className="max-h-48 shrink-0 overflow-y-auto border-b border-separator p-1.5">
        {files.map((file) => {
          const selected = selectedFile?.path === file.path;
          const stagedState = comparison
            ? "branch comparison"
            : file.staged && file.unstaged
              ? "staged and unstaged"
              : file.staged
                ? "staged"
                : "unstaged";
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelectedPath(file.path)}
              aria-current={selected ? "true" : undefined}
              aria-label={`${file.path}, ${file.status}, ${stagedState}${
                file.additions !== undefined || file.deletions !== undefined
                  ? `, ${file.additions ?? 0} additions, ${file.deletions ?? 0} deletions`
                  : ""
              }`}
              className={cn(
                "group flex min-h-10 w-full items-center gap-2 rounded-control px-2 text-left outline-none transition-colors duration-150 focus-visible:bg-list-selection focus-visible:outline-none",
                selected ? "bg-list-selection" : "hover:bg-list-hover active:bg-list-selection",
              )}
            >
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-md bg-control text-[10px] font-semibold",
                  (file.status === "added" || file.status === "untracked") && "text-support-green",
                  (file.status === "deleted" || file.status === "conflicted") && "text-support-red",
                )}
                aria-label={file.status}
              >
                {STATUS_LABEL[file.status]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-small-strong text-primary">{fileName(file.path)}</span>
                <span className="block truncate text-mini text-tertiary">
                  {file.previousPath ? `${file.previousPath} → ` : ""}{parentPath(file.path) || "Workspace root"}
                </span>
              </span>
              {file.binary ? <Binary className="size-3.5 shrink-0 text-tertiary" /> : null}
              {file.additions !== undefined || file.deletions !== undefined ? (
                <span className="flex shrink-0 gap-1 font-mono text-mini tabular-nums">
                  <span className="text-support-green">+{file.additions ?? 0}</span>
                  <span className="text-support-red">−{file.deletions ?? 0}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-separator px-3">
          <FileCode2 className="size-3.5 shrink-0 text-tertiary" />
          <Text variant="small-strong" truncate className="min-w-0 flex-1">
            {selectedFile?.path ?? "Diff"}
          </Text>
          <Button
            variant="transparent"
            size="small"
            onClick={() => selectedFile && onOpenFile(selectedFile.path)}
            disabled={!selectedFile || selectedFile.status === "deleted" || selectedFile.binary}
          >
            Open file
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {diff.loading && !diff.data ? (
            <div className="space-y-2 p-4" aria-label="Loading diff">
              {[88, 70, 92, 56, 76, 82].map((width, index) => (
                <div key={index} className="h-2 animate-pulse rounded-pill bg-control" style={{ width: `${width}%` }} />
              ))}
            </div>
          ) : diff.error && !diff.data ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <GitCompareArrows className="size-5 text-tertiary" />
              <Text variant="small" color="secondary" as="p">{diff.error}</Text>
              <Button size="small" onClick={() => setDiffRetryKey((value) => value + 1)}>Retry diff</Button>
            </div>
          ) : diff.data ? (
            <div className="flex h-full min-h-0 flex-col">
              {diff.error ? (
                <div className="shrink-0 border-b border-support-warning/25 bg-support-warning/[0.06] px-3 py-2 text-small text-support-warning">
                  Diff refresh failed. Showing the last snapshot.
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <DiffViewer diff={diff.data} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function WorkingChangesPanel({
  workspace,
  active,
  onOpenFile,
}: {
  workspace: Workspace | undefined;
  active: boolean;
  onOpenFile: (path: string) => void;
}) {
  const review = useGitReview(
    workspace?.id,
    active && Boolean(workspace?.folderPath) && workspace?.permission !== "none",
  );
  const files = review.data?.files ?? [];
  const reviewSnapshotKey = review.data?.commit.snapshot ?? `review:${review.dataUpdatedAt}`;
  const refresh = React.useCallback(() => {
    void review.refetch();
  }, [review.refetch]);
  const reviewError = review.error
    ? errorMessage(review.error, "Aiden could not load workspace changes.")
    : null;

  if (!workspace?.folderPath) {
    return (
      <EmptyState
        className="h-full"
        title="No workspace folder"
        description="Choose a local workspace to review file changes beside the conversation."
      />
    );
  }
  if (workspace.permission === "none") {
    return (
      <EmptyState
        className="h-full"
        title="File access is off"
        description="Change this workspace from No Access before opening Review or Files."
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-separator px-3">
        <GitBranch className="size-3.5 shrink-0 text-tertiary" />
        <Text variant="small-strong" truncate className="min-w-0 flex-1">
          {review.data?.branch ?? workspace.name}
        </Text>
        {review.data?.isRepo ? (
          <Text variant="small" color="tertiary" className="shrink-0 tabular-nums">
            {files.length} {files.length === 1 ? "file" : "files"}
          </Text>
        ) : null}
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={refresh}
          disabled={review.isFetching}
          aria-label="Refresh changes"
          title="Refresh changes"
        >
          <RefreshCw className={cn(review.isFetching && "animate-spin")} />
        </Button>
      </div>

      {review.isLoading && !review.data ? (
        <ReviewSkeleton />
      ) : reviewError && !review.data ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertCircle className="size-5 text-red" />
          <div>
            <Text variant="strong" as="p">Review unavailable</Text>
            <Text variant="small" color="secondary" as="p" className="mt-1 max-w-sm">
              {reviewError}
            </Text>
          </div>
          <Button size="small" onClick={() => void review.refetch()}>Try again</Button>
        </div>
      ) : review.data && !review.data.isRepo ? (
        <EmptyState
          className="h-full"
          title="Not a Git workspace"
          description="Review shows working-tree changes when the selected folder belongs to a Git repository. Files is still available."
        />
      ) : review.data && files.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="grid size-9 place-items-center rounded-full bg-support-green/10 text-support-green">
            <Check className="size-4.5" />
          </span>
          <Text variant="strong" as="p">Working tree is clean</Text>
          <Text variant="small" color="secondary" as="p" className="max-w-sm">
            New edits will appear here without moving you away from the conversation.
          </Text>
        </div>
      ) : (
        <>
          {reviewError ? (
            <div className="shrink-0 border-b border-support-warning/25 bg-support-warning/[0.06] px-3 py-2 text-small text-support-warning">
              Refresh failed. Showing the last review snapshot.
            </div>
          ) : null}
          <ReviewFileContent
            workspaceId={workspace.id}
            active={active}
            files={files}
            snapshotKey={reviewSnapshotKey}
            expectedReviewSnapshot={review.data?.commit.snapshot}
            onOpenFile={onOpenFile}
          />
        </>
      )}
    </div>
  );
}

interface ComparisonTarget {
  label: string;
  value: string;
  remote: boolean;
}

function comparisonTargets(branches: ReturnType<typeof useGitBranches>["data"]): ComparisonTarget[] {
  if (!branches?.isRepo) return [];
  const local = branches.branches
    .filter((branch) => branch !== branches.current)
    .map((branch) => ({ label: branch, value: `refs/heads/${branch}`, remote: false }));
  const remote = branches.remoteBranches.map((branch) => ({
    label: branch,
    value: `refs/remotes/${branch}`,
    remote: true,
  }));
  return [...local, ...remote];
}

function suggestedComparisonTarget(
  targets: ComparisonTarget[],
  upstream: string | undefined,
  defaultBranch: string | undefined,
): string | undefined {
  const upstreamTarget = upstream ? `refs/remotes/${upstream}` : undefined;
  return targets.find((target) => target.value === upstreamTarget)?.value
    ?? targets.find((target) => !target.remote && target.label === defaultBranch)?.value
    ?? targets.find((target) => target.remote && target.label.endsWith(`/${defaultBranch ?? ""}`))?.value
    ?? targets[0]?.value;
}

function CompareBranchPanel({
  workspace,
  active,
  onOpenFile,
}: {
  workspace: Workspace | undefined;
  active: boolean;
  onOpenFile: (path: string) => void;
}) {
  const available = Boolean(workspace?.folderPath) && workspace?.permission !== "none";
  const branches = useGitBranches(workspace?.id, active && available);
  const targets = React.useMemo(() => comparisonTargets(branches.data), [branches.data]);
  const [targetRef, setTargetRef] = React.useState<string | undefined>();

  React.useEffect(() => setTargetRef(undefined), [workspace?.id]);
  React.useEffect(() => {
    if (targetRef && targets.some((target) => target.value === targetRef)) return;
    setTargetRef(suggestedComparisonTarget(targets, branches.data?.upstream, branches.data?.defaultBranch));
  }, [branches.data?.defaultBranch, branches.data?.upstream, targetRef, targets]);

  const comparison = useGitComparison(workspace?.id, targetRef, active && available);
  const branchesError = branches.error
    ? errorMessage(branches.error, "Aiden could not load comparison branches.")
    : null;
  const comparisonError = comparison.error
    ? errorMessage(comparison.error, "Aiden could not compare these branches.")
    : null;
  const refresh = () => {
    void branches.refetch();
    if (targetRef) void comparison.refetch();
  };

  if (!workspace?.folderPath) {
    return <EmptyState className="h-full" title="No workspace folder" description="Choose a local workspace to compare branches." />;
  }
  if (workspace.permission === "none") {
    return <EmptyState className="h-full" title="File access is off" description="Enable workspace access before comparing branches." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-separator px-3">
        <GitBranch className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
        <Text variant="small-strong" truncate className="min-w-0 max-w-[32%] shrink-0">
          {comparison.data
            ? comparison.data.currentBranch ?? "Detached HEAD"
            : branches.data?.current ?? workspace.name}
        </Text>
        <span className="text-small text-tertiary" aria-hidden="true">with</span>
        <Select value={targetRef ?? ""} onValueChange={setTargetRef} disabled={targets.length === 0}>
          <SelectTrigger size="small" className="min-w-0 flex-1" aria-label="Comparison branch">
            <SelectValue placeholder="Choose branch" />
          </SelectTrigger>
          <SelectContent>
            {targets.map((target) => (
              <SelectItem key={target.value} value={target.value}>
                {target.remote ? `Last fetched · ${target.label}` : target.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="transparent"
          size="small"
          iconOnly
          onClick={refresh}
          disabled={branches.isFetching || comparison.isFetching}
          aria-label="Refresh branch comparison"
          title="Refresh local branch references"
        >
          <RefreshCw className={cn((branches.isFetching || comparison.isFetching) && "animate-spin")} />
        </Button>
      </div>

      {comparison.data ? (
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-separator bg-well/50 px-3 text-small text-secondary">
          <span>Compared from merge base · no fetch</span>
          <span className="shrink-0 font-mono tabular-nums" aria-label={`${comparison.data.ahead} commits ahead, ${comparison.data.behind} commits behind`}>
            ↑{comparison.data.ahead} ↓{comparison.data.behind}
          </span>
        </div>
      ) : null}

      {branchesError && targets.length > 0 ? (
        <div className="shrink-0 border-b border-support-warning/25 bg-support-warning/[0.06] px-3 py-2 text-small text-support-warning">
          Branch refresh failed. Showing the last local branch list.
        </div>
      ) : null}

      {branches.isLoading && !branches.data ? (
        <ReviewSkeleton />
      ) : branchesError && (!branches.data || targets.length === 0) ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertCircle className="size-5 text-support-red" aria-hidden="true" />
          <div>
            <Text variant="strong" as="p">Branch list unavailable</Text>
            <Text variant="small" color="secondary" as="p" className="mt-1 max-w-sm">{branchesError}</Text>
          </div>
          <Button size="small" onClick={() => void branches.refetch()}>Try again</Button>
        </div>
      ) : branches.data && !branches.data.isRepo ? (
        <EmptyState className="h-full" title="Not a Git workspace" description="Branch comparison is available for Git workspaces. Files remains usable." />
      ) : targets.length === 0 ? (
        <EmptyState className="h-full" title="No branch to compare" description="Create another local branch or fetch one outside Aiden, then refresh. Aiden never fetches implicitly." />
      ) : comparison.isLoading && !comparison.data ? (
        <ReviewSkeleton />
      ) : comparisonError && !comparison.data ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertCircle className="size-5 text-support-red" aria-hidden="true" />
          <div>
            <Text variant="strong" as="p">Comparison unavailable</Text>
            <Text variant="small" color="secondary" as="p" className="mt-1 max-w-sm">{comparisonError}</Text>
          </div>
          <Button size="small" onClick={() => void comparison.refetch()}>Try again</Button>
        </div>
      ) : comparison.data && comparison.data.files.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <span className="grid size-9 place-items-center rounded-full bg-support-green/10 text-support-green">
            <Check className="size-4.5" aria-hidden="true" />
          </span>
          <Text variant="strong" as="p">
            {comparison.data.ahead === 0 && comparison.data.behind === 0 ? "Branches are identical" : "No file differences"}
          </Text>
          <Text variant="small" color="secondary" as="p" className="max-w-sm">
            {comparison.data.ahead === 0 && comparison.data.behind === 0
              ? "Both references point to the same history."
              : "The histories differ, but the current branch has the same tree as their merge base."}
          </Text>
        </div>
      ) : comparison.data ? (
        <>
          {comparisonError ? (
            <div className="shrink-0 border-b border-support-warning/25 bg-support-warning/[0.06] px-3 py-2 text-small text-support-warning">
              Refresh failed. Showing the last comparison snapshot.
            </div>
          ) : null}
          <ReviewFileContent
            workspaceId={workspace.id}
            active={active}
            files={comparison.data.files}
            snapshotKey={comparison.data.snapshot}
            comparison={comparison.data}
            onOpenFile={onOpenFile}
          />
        </>
      ) : null}
    </div>
  );
}

export function ReviewPanel({
  workspace,
  active,
  mode,
  onModeChange,
  onOpenFile,
}: {
  workspace: Workspace | undefined;
  active: boolean;
  mode: EnvironmentReviewMode;
  onModeChange: (mode: EnvironmentReviewMode) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-separator px-3">
        <div className="flex items-center rounded-control bg-well p-0.5" role="tablist" aria-label="Review source">
          {(["changes", "compare"] as const).map((nextMode, index, modes) => (
            <button
              key={nextMode}
              id={`environment-review-${nextMode}-tab`}
              type="button"
              role="tab"
              aria-selected={mode === nextMode}
              aria-controls="environment-review-mode-panel"
              tabIndex={mode === nextMode ? 0 : -1}
              onClick={() => onModeChange(nextMode)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const nextIndex = event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? modes.length - 1
                    : (index + (event.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length;
                onModeChange(modes[nextIndex]);
                requestAnimationFrame(() => document.querySelector<HTMLElement>(`#environment-review-${modes[nextIndex]}-tab`)?.focus());
              }}
              className={cn(
                "h-7 rounded-[9px] px-2.5 text-small-strong outline-none transition-colors focus-visible:outline-none",
                mode === nextMode
                  ? "bg-popover text-primary shadow-control focus-visible:bg-popover"
                  : "text-secondary hover:text-primary focus-visible:bg-list-selection",
              )}
            >
              {nextMode === "changes" ? "Changes" : "Compare"}
            </button>
          ))}
        </div>
      </div>
      <div
        id="environment-review-mode-panel"
        className="min-h-0 flex-1"
        role="tabpanel"
        aria-labelledby={`environment-review-${mode}-tab`}
      >
        {mode === "changes" ? (
          <WorkingChangesPanel workspace={workspace} active={active} onOpenFile={onOpenFile} />
        ) : (
          <CompareBranchPanel workspace={workspace} active={active} onOpenFile={onOpenFile} />
        )}
      </div>
    </div>
  );
}
