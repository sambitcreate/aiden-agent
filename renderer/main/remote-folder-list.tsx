import * as React from "react";
import { ChevronRight, Folder, Loader2 } from "lucide-react";
import { Button, Text } from "../components/ui";
import { useAppCapabilities } from "../lib/app-capabilities";
import type { HostBrowserPage, HostBrowserRoot } from "../lib/hosts/host-resources";
import { hostFolderPlaces, type HostFolderPlace } from "../lib/hosts/remote-new-chat";
import { localComputerNoun } from "../shared/computer-noun";

interface FolderBrowserProps {
  hostLabel: string;
  roots: HostBrowserRoot[] | undefined;
  rootsError: string | null;
  /** The open folder, or null while the host's shared roots are listed. */
  place: HostFolderPlace | null;
  pages: HostBrowserPage[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  busy: boolean;
  onOpen(place: HostFolderPlace | null): void;
  onLoadMore(): void;
}

/** The folders a host lets this Mac browse: its approved roots, then their subfolders. */
export function RemoteFolderList({
  hostLabel,
  roots,
  rootsError,
  place,
  pages,
  loading,
  error,
  hasMore,
  busy,
  onOpen,
  onLoadMore,
}: FolderBrowserProps) {
  const breadcrumbs = pages[0]?.breadcrumbs ?? [];
  const location = place?.location ?? null;
  const entries = pages.flatMap((page) => page.entries);
  const rows: HostFolderPlace[] = place
    ? entries.map((entry) => hostFolderPlaces.entry(place, entry))
    : (roots ?? []).map((root) => hostFolderPlaces.root(root));
  const failure = location ? error : rootsError;
  const { platform } = useAppCapabilities();
  return (
    <div className="flex min-h-64 flex-col gap-2" aria-busy={loading || busy || undefined}>
      <nav aria-label={`Folders on ${hostLabel}`} className="flex min-w-0 flex-wrap items-center gap-0.5 text-small text-secondary">
        <Button variant="transparent" size="small" disabled={busy || !location} onClick={() => onOpen(null)}>
          {hostLabel}
        </Button>
        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={crumb.location}>
            <ChevronRight className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
            <Button
              variant="transparent"
              size="small"
              // The last breadcrumb is the open folder; its handle is freshly minted, so match by position.
              disabled={busy || index === breadcrumbs.length - 1}
              onClick={() => place && onOpen(hostFolderPlaces.ancestor(place, crumb, index))}
            >
              {crumb.label}
            </Button>
          </React.Fragment>
        ))}
      </nav>
      <div className="min-h-0 overflow-hidden rounded-card bg-well">
        {failure ? (
          <Text as="p" variant="small" color="secondary" className="p-4">
            {failure}
          </Text>
        ) : loading && rows.length === 0 ? (
          <Text as="p" variant="small" color="secondary" className="p-4">
            Loading folders…
          </Text>
        ) : rows.length === 0 ? (
          <Text as="p" variant="small" color="secondary" className="p-4">
            {location ? "No folders inside this one." : `${hostLabel} hasn't shared any folders with this ${localComputerNoun(platform)}.`}
          </Text>
        ) : (
          <ul aria-label={location ? `Folders in ${location.label}` : `Shared folders on ${hostLabel}`}>
            {rows.map((row, index) => (
              <li key={row.location.location} className={index ? "border-t border-separator" : undefined}>
                <button
                  type="button"
                  disabled={busy}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-regular text-primary outline-none transition-colors duration-150 hover:bg-control-hover focus-visible:bg-list-selection disabled:opacity-60"
                  onClick={() => onOpen(row)}
                >
                  <Folder className="size-4 shrink-0 text-secondary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{row.location.label}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {location && hasMore ? (
        <Button variant="filled" size="small" className="self-start" disabled={loading || busy} onClick={onLoadMore}>
          {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          Show more
        </Button>
      ) : null}
    </div>
  );
}
