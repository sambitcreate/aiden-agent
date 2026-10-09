// The shared frame for a Bot's Profile, Instructions and Advanced pages: the
// app's ScrollArea toolbar (drag region, sidebar-collapsed inset, scroll-edge
// fade) with a back button, and the Settings page column, groups and rows.

import * as React from "react";
import { ChevronLeft } from "lucide-react";
import { AlertDialog, Button, ScrollArea } from "../../components/ui";
import { SettingsPage } from "../../components/settings/settings-page";

export function BotPageShell({
  scrollId,
  title,
  backLabel,
  onBack,
  actions,
  heading,
  description,
  children,
}: React.PropsWithChildren<{
  /** A stable name for this page's scrollport, such as `bot-profile:<id>`. */
  scrollId: string;
  /** The toolbar title: the Bot's name, so every page keeps its context. */
  title: React.ReactNode;
  backLabel: string;
  onBack(): void;
  actions?: React.ReactNode;
  /** The page heading in the content column; omitted on Profile. */
  heading?: string;
  description?: string;
}>) {
  return (
    <ScrollArea
      scrollRestorationId={scrollId}
      title={title}
      leading={
        <Button iconOnly variant="toolbar" size="large" aria-label={backLabel} onClick={onBack}>
          <ChevronLeft />
        </Button>
      }
      actions={actions}
    >
      <div className="settings-responsive mx-auto w-full max-w-2xl px-5 pb-10 pt-4">
        <SettingsPage title={heading ?? ""} description={description ?? ""} heading={Boolean(heading)}>
          {children}
        </SettingsPage>
      </div>
    </ScrollArea>
  );
}

/** Group-card placeholders shaped like the page that is loading. */
export function BotPageSkeleton({ label, groups = [2, 3] }: { label: string; groups?: readonly number[] }) {
  return (
    <div role="status" aria-label={label} className="space-y-7">
      {groups.map((rows, group) => (
        <div key={group} className="space-y-3">
          <div className="mx-1 h-3.5 w-28 rounded-full bg-control motion-safe:animate-pulse" />
          <div className="settings-group-card overflow-hidden rounded-card bg-well">
            {Array.from({ length: rows }, (_, row) => (
              <div
                key={row}
                className="relative flex min-h-16 items-center gap-4 px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden"
              >
                <span className="grid min-w-0 flex-1 gap-2">
                  <span className="h-3 w-32 rounded-full bg-control motion-safe:animate-pulse" />
                  <span className="h-2.5 w-56 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
                </span>
                <span className="h-7 w-24 shrink-0 rounded-control bg-control motion-safe:animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/**
 * Leaving an editor with unsaved changes asks first. `requestLeave` leaves at
 * once when nothing changed; otherwise it opens a Discard confirmation.
 */
export function useDiscardChangesGuard({
  dirty,
  onLeave,
  description,
}: {
  dirty: boolean;
  onLeave(): void;
  description: string;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const requestLeave = React.useCallback(() => {
    if (dirty) setConfirming(true);
    else onLeave();
  }, [dirty, onLeave]);
  const dialog = (
    <AlertDialog
      open={confirming}
      onOpenChange={setConfirming}
      title="Discard changes?"
      description={description}
      confirmLabel="Discard"
      confirmVariant="destructive"
      onConfirm={() => {
        setConfirming(false);
        onLeave();
      }}
    />
  );
  return { requestLeave, dialog };
}
