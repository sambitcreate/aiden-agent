import * as React from "react";
import { Button } from "../ui";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { RemoteAccessSettings } from "./remote-access-settings";
import { PeerHostsSettings } from "./peer-hosts-settings";

export type ConnectionsSegment = "this" | "others";

export const CONNECTIONS_SEGMENTS: readonly { id: ConnectionsSegment; label: string }[] = [
  { id: "this", label: "Control this device" },
  { id: "others", label: "Control other devices" },
];

/** The segment arrow, Home and End keys move to from `index`, or null for other keys. */
export function connectionsSegmentForKey(key: string, index: number): number | null {
  const count = CONNECTIONS_SEGMENTS.length;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  return null;
}

/** The two-segment switch at the top of Connections. */
export function ConnectionsSegments({
  selected,
  onSelect,
  idPrefix,
}: {
  selected: ConnectionsSegment;
  onSelect: (segment: ConnectionsSegment) => void;
  idPrefix: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Connections"
      className="mb-7 flex w-fit max-w-full rounded-control bg-control p-0.5"
    >
      {CONNECTIONS_SEGMENTS.map((segment, index) => (
        <Button
          key={segment.id}
          role="tab"
          id={`${idPrefix}-tab-${segment.id}`}
          aria-selected={selected === segment.id}
          aria-controls={selected === segment.id ? `${idPrefix}-panel-${segment.id}` : undefined}
          tabIndex={selected === segment.id ? 0 : -1}
          size="small"
          variant={selected === segment.id ? "filled" : "transparent"}
          onClick={() => onSelect(segment.id)}
          onKeyDown={(event) => {
            const next = connectionsSegmentForKey(event.key, index);
            if (next === null) return;
            event.preventDefault();
            onSelect(CONNECTIONS_SEGMENTS[next]!.id);
            const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
            tabs?.[next]?.focus();
          }}
        >
          {segment.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * Settings → Connections. "Control this device" is phone and desktop access
 * to this computer; "Control other devices" pairs and manages the computers
 * this one controls.
 */
export function ConnectionsSettings() {
  const capabilities = useAppCapabilities();
  const hostLabel = capabilities.platform === "darwin" ? "Mac" : "computer";
  const [segment, setSegment] = React.useState<ConnectionsSegment>("this");
  const idPrefix = React.useId();
  return (
    <>
      <ConnectionsSegments selected={segment} onSelect={setSegment} idPrefix={idPrefix} />
      <div
        role="tabpanel"
        id={`${idPrefix}-panel-${segment}`}
        aria-labelledby={`${idPrefix}-tab-${segment}`}
      >
        {segment === "this" ? <RemoteAccessSettings /> : <PeerHostsSettings hostLabel={hostLabel} />}
      </div>
    </>
  );
}
