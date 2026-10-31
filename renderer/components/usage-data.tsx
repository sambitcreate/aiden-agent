import { X } from "lucide-react";
import * as React from "react";

import { analyticsApi } from "../lib/ipc";
import { cn } from "../lib/ui-utils";
import type {
  AnalyticsNoticeChoice,
  AnalyticsPropertyView,
  AnalyticsRegistryView,
  AnalyticsStatusView,
} from "../shared/analytics";
import { Button, Dialog, type DialogLayer, Field, FieldSet, Switch, Text, toast } from "./ui";

// Usage-data consent shared by Settings → Diagnostics, the onboarding tour step
// and the one-time notice for people who installed Aiden before analytics.

export const USAGE_DATA_LABEL = "Share anonymous usage and crash data";
export const USAGE_DATA_SUMMARY = "Helps improve Aiden. Never includes your chats, files or keys.";
const NOTICE_ANSWERED_EVENT = "aiden:usage-notice-answered";
export const USAGE_DATA_ENV_DISABLED = "Turned off by your environment (DO_NOT_TRACK or AIDEN_ANALYTICS)";
const SAVE_FAILED = "Aiden could not save the usage data setting.";

export interface UsageDataSetting {
  /** Null until the first read finishes, or when it failed. */
  readonly status: AnalyticsStatusView | null;
  readonly setEnabled: (enabled: boolean) => void;
}

/**
 * Reads the setting once and changes it optimistically: the switch moves at
 * once and rolls back, with one toast, only if main could not save it.
 */
export function useUsageDataSetting(): UsageDataSetting {
  const [status, setStatus] = React.useState<AnalyticsStatusView | null>(null);
  const confirmed = React.useRef<AnalyticsStatusView | null>(null);
  const latestRequest = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    analyticsApi
      .status()
      .then((next) => {
        if (cancelled || latestRequest.current !== 0) return;
        confirmed.current = next;
        setStatus(next);
      })
      .catch(() => {
        // The switch stays unavailable; nothing else depends on it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = React.useCallback((enabled: boolean) => {
    const request = ++latestRequest.current;
    setStatus((current) => (current ? { ...current, enabled } : current));
    analyticsApi.setEnabled(enabled).then(
      (next) => {
        confirmed.current = next;
        if (request === latestRequest.current) setStatus(next);
        // Switching it on in Settings answers the notice, so an open notice closes.
        if (!next.noticePending) window.dispatchEvent(new Event(NOTICE_ANSWERED_EVENT));
      },
      () => {
        if (request !== latestRequest.current) return;
        setStatus(confirmed.current);
        toast.error(SAVE_FAILED);
      },
    );
  }, []);

  return { status, setEnabled };
}

function describeProperty(property: AnalyticsPropertyView): string {
  const value =
    property.kind === "enum" && property.values?.length
      ? `one of ${property.values.join(", ")}`
      : property.kind === "boolean"
        ? "yes or no"
        : property.kind === "integer"
          ? "a number"
          : property.kind === "version"
            ? "a version number"
            : "an id from Aiden’s built-in lists, or “custom” for anything you added";
  return property.optional ? `${value}, when it applies` : value;
}

function PropertyList({ properties }: { properties: readonly AnalyticsPropertyView[] }) {
  if (properties.length === 0) {
    return <Text variant="small" color="tertiary">Only the fields sent with every event.</Text>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {properties.map((property) => (
        <li key={property.name} className="text-small text-secondary">
          <code className="font-mono text-primary">{property.name}</code>: {describeProperty(property)}
        </li>
      ))}
    </ul>
  );
}

function SheetSection({ title, children }: React.PropsWithChildren<{ title: string }>) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-strong text-primary">
        {title}
      </h3>
      <div className="rounded-card bg-well">{children}</div>
    </section>
  );
}

function SheetRow({ children }: React.PropsWithChildren) {
  return (
    <div className="relative px-4 py-3 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden">
      {children}
    </div>
  );
}

/** The "What's sent" list, rendered from the same registry main checks events against. */
export function UsageDataSheet({
  open,
  onOpenChange,
  layer,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layer?: DialogLayer;
  returnFocus?: () => HTMLElement | null;
}) {
  const [registry, setRegistry] = React.useState<AnalyticsRegistryView | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open || registry) return;
    let cancelled = false;
    setFailed(false);
    analyticsApi.registry().then(
      (next) => {
        if (!cancelled) setRegistry(next);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, registry]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="What’s sent"
      description="Aiden can send only these events and fields, with a random install ID that isn’t tied to you. This release sends the app lifecycle events; feature use and crash reports arrive later. Your IP address is discarded."
      confirmHidden
      size="large"
      layer={layer}
      returnFocus={returnFocus}
    >
      {registry ? (
        <div className="flex flex-col gap-5">
          <SheetSection title="With every event">
            <SheetRow>
              <PropertyList properties={registry.superProperties} />
            </SheetRow>
          </SheetSection>
          <SheetSection title="Events">
            {registry.events
              .filter((event) => event.name !== "app_crashed")
              .map((event) => (
                <SheetRow key={event.name}>
                  <div className="mb-1 font-mono text-small-strong font-medium text-primary">{event.name}</div>
                  <PropertyList properties={event.properties} />
                </SheetRow>
              ))}
          </SheetSection>
          <SheetSection title="Crash and error reports">
            <SheetRow>
              <Text as="p" variant="small" color="secondary" className="mb-1">
                The error type and its stack trace inside Aiden, with messages cleaned of personal details and paths
                outside Aiden removed.
              </Text>
              <PropertyList properties={registry.exceptionProperties} />
            </SheetRow>
            {registry.events
              .filter((event) => event.name === "app_crashed")
              .map((event) => (
                <SheetRow key={event.name}>
                  <div className="mb-1 font-mono text-small-strong font-medium text-primary">{event.name}</div>
                  <PropertyList properties={event.properties} />
                </SheetRow>
              ))}
          </SheetSection>
          <Text as="p" variant="small" color="secondary">
            Never sent: chats, prompts, replies, file names or contents, paths, API keys, or the names and URLs of
            custom providers.
          </Text>
        </div>
      ) : (
        <Text as="p" variant="small" color="secondary" role={failed ? "alert" : "status"}>
          {failed ? "Aiden could not load the list." : "Loading…"}
        </Text>
      )}
    </Dialog>
  );
}

/**
 * A link-styled trigger for the sheet. It keeps the shared focus-visible ring.
 */
export function UsageDataSheetLink({
  layer,
  className,
}: {
  layer?: DialogLayer;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn("rounded-sm text-small-strong font-medium text-accent-text hover:underline", className)}
        onClick={() => setOpen(true)}
      >
        What’s sent
      </button>
      <UsageDataSheet open={open} onOpenChange={setOpen} layer={layer} returnFocus={() => triggerRef.current} />
    </>
  );
}

/**
 * The one-time notice for people who already used Aiden before usage data
 * existed. Nothing is sent until they answer it; closing it counts as OK.
 */
export function UsageDataNotice() {
  const [status, setStatus] = React.useState<AnalyticsStatusView | null>(null);
  const [answered, setAnswered] = React.useState(false);
  const titleId = React.useId();

  React.useEffect(() => {
    let cancelled = false;
    analyticsApi.status().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      () => {},
    );
    const close = () => setAnswered(true);
    window.addEventListener(NOTICE_ANSWERED_EVENT, close);
    return () => {
      cancelled = true;
      window.removeEventListener(NOTICE_ANSWERED_EVENT, close);
    };
  }, []);

  if (answered || !status?.noticePending) return null;

  const answer = (choice: AnalyticsNoticeChoice) => {
    setAnswered(true);
    analyticsApi.markNoticeShown(choice).catch(() => {
      if (choice === "turn-off") toast.error(SAVE_FAILED);
    });
  };

  return (
    <div
      role="region"
      aria-labelledby={titleId}
      data-state="open"
      className="usage-data-notice fixed bottom-4 right-4 z-[45] w-[min(360px,calc(100vw-32px))] rounded-card bg-popover p-4 shadow-modal"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-strong text-primary">
            Aiden now shares anonymous usage data
          </h2>
          <p className="mt-1 text-small text-secondary">
            {USAGE_DATA_SUMMARY} You can turn it off anytime in Settings → About.
          </p>
          <UsageDataSheetLink className="mt-2" />
        </div>
        <Button variant="transparent" size="small" iconOnly aria-label="Dismiss" onClick={() => answer("ok")}>
          <X />
        </Button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="filled" size="small" onClick={() => answer("turn-off")}>
          Turn off
        </Button>
        <Button variant="accent" size="small" onClick={() => answer("ok")}>
          OK
        </Button>
      </div>
    </div>
  );
}

/** The "Usage data" group at the top of Settings → About's diagnostics. */
export function UsageDataSettings() {
  const { status, setEnabled } = useUsageDataSetting();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const viewRef = React.useRef<HTMLButtonElement>(null);
  const caption = status?.envDisabled
    ? USAGE_DATA_ENV_DISABLED
    : status && !status.hasKey
      ? "This build of Aiden doesn’t send usage data."
      : null;

  return (
    <FieldSet title="Usage data">
      <Field
        label={USAGE_DATA_LABEL}
        description={
          <>
            App launches, daily use, setup and updates, with a random install ID. Feature use and crash reports arrive
            in later releases. Never your chats, files, keys or paths.
            {caption ? <span className="mt-1 block text-tertiary">{caption}</span> : null}
          </>
        }
      >
        <Switch
          aria-label={USAGE_DATA_LABEL}
          checked={Boolean(status?.enabled && !status.envDisabled)}
          disabled={!status || status.envDisabled}
          onCheckedChange={setEnabled}
        />
      </Field>
      <Field label="What’s sent" description="Every event and field Aiden can send, straight from the app’s own list.">
        <div className="flex justify-end max-[540px]:justify-start">
          <Button ref={viewRef} size="small" variant="filled" onClick={() => setSheetOpen(true)}>
            View
          </Button>
        </div>
      </Field>
      <UsageDataSheet open={sheetOpen} onOpenChange={setSheetOpen} returnFocus={() => viewRef.current} />
    </FieldSet>
  );
}

/** The usage-data row on onboarding's last step; finishing onboarding counts as seeing it. */
export function UsageDataOnboardingRow() {
  const { status, setEnabled } = useUsageDataSetting();
  const titleId = React.useId();
  const summaryId = React.useId();
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      className="mt-5 flex items-center gap-4 rounded-card bg-well px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <Text id={titleId} variant="small-strong" className="block">
          {USAGE_DATA_LABEL}
        </Text>
        <Text id={summaryId} as="p" variant="small" color="secondary" className="mt-0.5 block">
          {status?.envDisabled ? USAGE_DATA_ENV_DISABLED : USAGE_DATA_SUMMARY}
        </Text>
        <UsageDataSheetLink layer="onboarding" className="mt-1" />
      </div>
      <Switch
        aria-label={USAGE_DATA_LABEL}
        checked={Boolean(status?.enabled && !status.envDisabled)}
        disabled={!status || status.envDisabled}
        onCheckedChange={setEnabled}
      />
    </div>
  );
}
