import * as React from "react";

export function ChatLineageLine({
  icon,
  label,
  onClick,
  forkLineage,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  forkLineage?: boolean;
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-small font-normal text-secondary"
      data-chat-fork-lineage={forkLineage || undefined}
    >
      {icon}
      {onClick ? (
        <button
          type="button"
          className="min-w-0 truncate rounded-control text-left outline-none hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          onClick={onClick}
        >
          {label}
        </button>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
    </span>
  );
}
