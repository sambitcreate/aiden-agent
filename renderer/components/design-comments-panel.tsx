import * as React from "react";
import {
  Check,
  CornerUpLeft,
  MessageSquareText,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import {
  designCommentDisplayOrder,
  designCommentIsCurrent,
  designCommentTargetLabel,
  parseDesignCommentDraft,
  type DesignCommentProjectViewV1,
  type DesignCommentTargetV1,
  type DesignCommentV1,
} from "../shared/design-comments";
import "../design-comments.css";

export interface DesignCommentsPanelProps {
  view?: DesignCommentProjectViewV1;
  currentTarget?: DesignCommentTargetV1;
  loading?: boolean;
  error?: string;
  layout?: "rail" | "drawer";
  onCreate: (
    body: string,
    target: DesignCommentTargetV1,
  ) => void | Promise<void>;
  onResolve: (comment: DesignCommentV1) => void;
  onReopen: (comment: DesignCommentV1) => void;
  onSelectTarget: (target: DesignCommentTargetV1) => void;
  onRetry?: () => void;
  onClose?: () => void;
  formatTimestamp?: (timestamp: number) => string;
}

function defaultFormatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function DesignCommentsPanel({
  view,
  currentTarget,
  loading = false,
  error,
  layout = "rail",
  onCreate,
  onResolve,
  onReopen,
  onSelectTarget,
  onRetry,
  onClose,
  formatTimestamp = defaultFormatTimestamp,
}: DesignCommentsPanelProps) {
  const titleId = React.useId();
  const composerHintId = React.useId();
  const [draft, setDraft] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string>();
  const comments = React.useMemo(
    () => designCommentDisplayOrder(view?.comments ?? []),
    [view?.comments],
  );
  const parsedDraft = parseDesignCommentDraft(draft);
  const canCreate = Boolean(
    currentTarget && parsedDraft && !loading && !submitting,
  );

  const submit = React.useCallback(async () => {
    const body = parseDesignCommentDraft(draft);
    if (!body || !currentTarget || submitting) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await onCreate(body, currentTarget);
      setDraft("");
    } catch (reason) {
      setSubmitError(
        reason instanceof Error
          ? reason.message
          : "The comment could not be saved.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [currentTarget, draft, onCreate, submitting]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && layout === "drawer" && onClose) {
        event.preventDefault();
        onClose();
      }
    },
    [layout, onClose],
  );

  return (
    <aside
      className="design-comments-panel"
      data-layout={layout}
      aria-labelledby={titleId}
      aria-busy={loading}
      aria-modal={layout === "drawer" ? false : undefined}
      role={layout === "drawer" ? "dialog" : undefined}
      onKeyDown={onKeyDown}
    >
      <header className="design-comments-header">
        <div>
          <h2 id={titleId}>Comments</h2>
          <p>
            {comments.length === 1
              ? "1 saved comment"
              : `${comments.length} saved comments`}
          </p>
        </div>
        {layout === "drawer" && onClose ? (
          <button
            type="button"
            className="design-comments-icon-button"
            onClick={onClose}
          >
            <X aria-hidden="true" />
            <span className="sr-only">Close comments</span>
          </button>
        ) : null}
      </header>

      <form
        className="design-comments-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={`${composerHintId}-input`} className="sr-only">
          Add a comment to the selected element
        </label>
        <textarea
          id={`${composerHintId}-input`}
          value={draft}
          maxLength={4_000}
          rows={3}
          disabled={!currentTarget || loading || submitting}
          aria-describedby={composerHintId}
          placeholder={
            currentTarget
              ? "Leave a comment…"
              : "Select an exact element to comment"
          }
          onChange={(event) => {
            setDraft(event.target.value);
            setSubmitError(undefined);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="design-comments-composer-footer">
          <p id={composerHintId}>
            {currentTarget
              ? `Anchored to ${designCommentTargetLabel(currentTarget)}`
              : "Comments require a saved revision and exact element binding."}
          </p>
          <button
            type="submit"
            className="design-comments-primary-button"
            disabled={!canCreate}
          >
            <Send aria-hidden="true" />
            {submitting ? "Saving…" : "Comment"}
          </button>
        </div>
        {submitError ? (
          <p className="design-comments-inline-error" role="alert">
            {submitError}
          </p>
        ) : null}
      </form>

      <div className="design-comments-scroll">
        {error ? (
          <div className="design-comments-state" role="alert">
            <p>{error}</p>
            {onRetry ? (
              <button
                type="button"
                className="design-comments-secondary-button"
                onClick={onRetry}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : loading && !view ? (
          <div className="design-comments-state" role="status">
            <p>Loading comments…</p>
          </div>
        ) : comments.length === 0 ? (
          <div className="design-comments-state">
            <MessageSquareText aria-hidden="true" />
            <p>No saved comments yet.</p>
            <span>Select an exact element to start a review thread.</span>
          </div>
        ) : (
          <ol className="design-comments-list" aria-label="Saved comments">
            {comments.map((comment) => {
              const isCurrent = designCommentIsCurrent(comment, currentTarget);
              return (
                <li
                  key={comment.id}
                  className="design-comments-card"
                  data-status={comment.status}
                  data-stale={comment.stale}
                >
                  <div className="design-comments-card-meta">
                    <span>
                      {comment.status === "resolved" ? "Resolved" : "Open"}
                    </span>
                    {comment.stale ? (
                      <span className="design-comments-stale">
                        Stale target
                      </span>
                    ) : null}
                    {isCurrent ? <span>Current selection</span> : null}
                    <time dateTime={new Date(comment.updatedAt).toISOString()}>
                      {formatTimestamp(comment.updatedAt)}
                    </time>
                  </div>
                  <p className="design-comments-body">{comment.body}</p>
                  <p className="design-comments-target">
                    {designCommentTargetLabel(comment.target)}
                  </p>
                  <div className="design-comments-card-actions">
                    {!isCurrent ? (
                      <button
                        type="button"
                        className="design-comments-secondary-button"
                        onClick={() => onSelectTarget(comment.target)}
                      >
                        <CornerUpLeft aria-hidden="true" />
                        {comment.stale ? "View saved target" : "Show target"}
                      </button>
                    ) : null}
                    {comment.status === "open" ? (
                      <button
                        type="button"
                        className="design-comments-secondary-button"
                        onClick={() => onResolve(comment)}
                      >
                        <Check aria-hidden="true" /> Resolve
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="design-comments-secondary-button"
                        onClick={() => onReopen(comment)}
                      >
                        <RotateCcw aria-hidden="true" /> Reopen
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
