import * as React from "react";

export function useSubagentSelectionRestoreRunRepair(
  restoreRunIdRef: React.MutableRefObject<string | null>,
  selectedRunId: string | null,
  runs: readonly { runId: string }[],
): void {
  React.useLayoutEffect(() => {
    const restoreRunId = restoreRunIdRef.current;
    if (
      !selectedRunId ||
      !restoreRunId ||
      restoreRunId === selectedRunId ||
      runs.some((run) => run.runId === restoreRunId)
    )
      return;
    restoreRunIdRef.current = selectedRunId;
  }, [restoreRunIdRef, runs, selectedRunId]);
}

export interface SubagentOwnerFocusBoundaryProps
  extends React.HTMLAttributes<HTMLDivElement> {
  ownerKey: string;
  replacementKey: string;
  active: boolean;
  fallbackFocusTarget?: () => HTMLElement | null;
}

const OWNER_REPLACEMENT_FOCUS_SELECTORS = [
  "[data-subagent-empty-heading]",
  "[data-subagent-detail-heading]",
  '[data-subagent-run-id][aria-selected="true"]',
  "[data-subagent-run-id]",
] as const;

export function focusSubagentOwnerReplacement(
  boundary: HTMLElement | null,
  fallbackFocusTarget?: () => HTMLElement | null,
): boolean {
  if (!boundary) return false;
  const activeElement = document.activeElement;
  if (
    activeElement instanceof Node &&
    activeElement.isConnected &&
    boundary.contains(activeElement)
  ) {
    return false;
  }
  const target =
    OWNER_REPLACEMENT_FOCUS_SELECTORS.map((selector) =>
      boundary.querySelector<HTMLElement>(selector),
    ).find((candidate) => candidate?.isConnected) ??
    fallbackFocusTarget?.() ??
    null;
  if (!target?.isConnected) return false;
  target.focus({ preventScroll: true });
  return true;
}

/**
 * The keyed owner subtree is intentionally replaced before paint. Capture
 * whether it owned focus in React's pre-mutation snapshot, then recover to the
 * next owner's semantic destination during the same commit's layout phase.
 */
export class SubagentOwnerFocusBoundary extends React.Component<
  SubagentOwnerFocusBoundaryProps,
  Record<string, never>
> {
  private readonly boundaryRef = React.createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(
    previousProps: Readonly<SubagentOwnerFocusBoundaryProps>,
  ): boolean {
    if (
      previousProps.replacementKey === this.props.replacementKey ||
      !previousProps.active ||
      !this.props.active
    ) {
      return false;
    }
    const activeElement = document.activeElement;
    return (
      activeElement instanceof Node &&
      this.boundaryRef.current?.contains(activeElement) === true
    );
  }

  componentDidUpdate(
    _previousProps: Readonly<SubagentOwnerFocusBoundaryProps>,
    _previousState: Readonly<Record<string, never>>,
    restoreFocus: boolean,
  ): void {
    if (!restoreFocus || !this.props.active) return;
    focusSubagentOwnerReplacement(
      this.boundaryRef.current,
      this.props.fallbackFocusTarget,
    );
  }

  render() {
    const {
      ownerKey,
      replacementKey: _replacementKey,
      active: _active,
      fallbackFocusTarget: _fallbackFocusTarget,
      children,
      ...props
    } = this.props;
    return (
      <div
        ref={this.boundaryRef}
        data-subagent-owner-focus-boundary={ownerKey}
        {...props}
      >
        {children}
      </div>
    );
  }
}
