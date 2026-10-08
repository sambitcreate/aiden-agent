/**
 * Adapted from t3code apps/web/src/components/device/DeviceToolsPanel.tsx @ a6ec88f7 (MIT)
 *
 * The event log in the Device tools drawer: serve-sim's iOS events, or an
 * Android emulator's logcat. It subscribes only while the section is
 * expanded (closing it, or the viewer going away, ends the stream and with it
 * serve-emu's logcat child), keeps a bounded buffer, and can be filtered,
 * paused, cleared, and copied. Pausing freezes the view while new events keep
 * buffering, so resuming shows what happened meanwhile. On Android the log
 * can follow only the frontmost app's processes.
 */
import * as React from "react";
import { ChevronDown, Copy, Pause, Play, Trash2 } from "lucide-react";
import { Button, Input, Switch, Text, toast } from "./ui";
import {
  createEventLogBuffer,
  eventLogTime,
  filterEventLog,
  formatEventLog,
  subscribeAndroidLogcat,
  subscribeDeviceEventLog,
  type DeviceEventLogEntry,
} from "../lib/device-event-log";
import type { DeviceGrantSource } from "../lib/device-grant";
import { Row } from "./device-tools-panel";
import type { DevicePlatform } from "../shared/devices";

export function DeviceEventLogSection(props: {
  hostId: string;
  deviceId: string;
  platform: DevicePlatform;
  grants: DeviceGrantSource;
  /** Android: the frontmost app, which the log can be narrowed to. */
  foregroundApp?: string;
  /** Starts expanded (and subscribed); tests and restored drawers use it. */
  defaultOpen?: boolean;
}) {
  const { hostId, deviceId, platform, grants, foregroundApp } = props;
  const android = platform === "android";
  const listId = React.useId();
  const [open, setOpen] = React.useState(props.defaultOpen ?? false);
  const [entries, setEntries] = React.useState<DeviceEventLogEntry[]>([]);
  const [frozen, setFrozen] = React.useState<DeviceEventLogEntry[] | null>(null);
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  /** Android: follow only this app's processes. Pinned when turned on, so switching apps does not move it. */
  const [onlyApp, setOnlyApp] = React.useState<string | null>(null);
  const bufferRef = React.useRef(createEventLogBuffer());
  const listRef = React.useRef<HTMLOListElement | null>(null);
  const stickRef = React.useRef(true);

  React.useEffect(() => {
    if (!open) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    setError(null);
    void grants
      .get()
      .then((grant) => {
        if (cancelled) return;
        const onEvents = (incoming: DeviceEventLogEntry[], reset: boolean) =>
          setEntries(bufferRef.current.apply(incoming, reset));
        const onEnd = (message: string | null) => {
          if (message) setError(message);
        };
        stop = android
          ? subscribeAndroidLogcat({ hostId, deviceId, grant, ...(onlyApp ? { packageName: onlyApp } : {}) }, onEvents, onEnd)
          : subscribeDeviceEventLog({ hostId, deviceId, grant }, onEvents, onEnd);
      })
      .catch(() => {
        if (!cancelled) setError("The event log is unavailable right now.");
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [open, hostId, deviceId, android, onlyApp, grants]);

  // A different device starts from an empty log.
  React.useEffect(() => {
    bufferRef.current = createEventLogBuffer();
    setEntries([]);
    setFrozen(null);
    setOnlyApp(null);
  }, [hostId, deviceId]);

  const paused = frozen !== null;
  const shown = filterEventLog(frozen ?? entries, query);
  const lastFrozenId = frozen && frozen.length > 0 ? frozen[frozen.length - 1]!.id : -Infinity;
  const waiting = paused ? entries.filter((entry) => entry.id > lastFrozenId).length : 0;

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [shown.length]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatEventLog(shown));
      toast.success(shown.length === 1 ? "Copied 1 event." : `Copied ${shown.length} events.`);
    } catch {
      toast.error("The events could not be copied.");
    }
  };

  return (
    <section className="device-tools-section" aria-label="Event log">
      <Button
        variant="transparent"
        size="small"
        className="device-event-log-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span>Event log</span>
        <ChevronDown aria-hidden data-open={open || undefined} className="device-event-log-chevron" />
      </Button>
      {open ? (
        <>
          <div className="device-tools-actions">
            <Input
              aria-label="Filter events"
              className="device-tools-input"
              placeholder="Filter"
              value={query}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              size="small"
              variant={paused ? "muted" : "transparent"}
              iconOnly
              aria-label={paused ? "Resume event log" : "Pause event log"}
              title={paused ? "Resume" : "Pause"}
              aria-pressed={paused}
              onClick={() => setFrozen(paused ? null : entries)}
            >
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            </Button>
            <Button
              size="small"
              variant="transparent"
              iconOnly
              aria-label="Clear event log"
              title="Clear"
              disabled={entries.length === 0}
              onClick={() => {
                bufferRef.current.clear();
                setEntries([]);
                if (paused) setFrozen([]);
              }}
            >
              <Trash2 aria-hidden />
            </Button>
            <Button
              size="small"
              variant="transparent"
              iconOnly
              aria-label="Copy events"
              title="Copy"
              disabled={shown.length === 0}
              onClick={() => void copy()}
            >
              <Copy aria-hidden />
            </Button>
          </div>
          {android && (foregroundApp || onlyApp) ? (
            <Row label={`Only ${onlyApp ?? foregroundApp}`}>
              <Switch
                aria-label="Only the frontmost app"
                checked={onlyApp !== null}
                onCheckedChange={(checked) => setOnlyApp(checked ? (foregroundApp ?? null) : null)}
              />
            </Row>
          ) : null}
          {error ? (
            <Text variant="small" color="secondary" role="status">
              {error}
            </Text>
          ) : null}
          <ol
            id={listId}
            ref={listRef}
            className="device-event-log-list"
            role="log"
            aria-label={android ? "Emulator logcat" : "Simulator events"}
            aria-live="off"
            tabIndex={0}
            onScroll={(event) => {
              const list = event.currentTarget;
              stickRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
            }}
          >
            {shown.length === 0 ? (
              <li className="device-event-log-empty">{query.trim() ? "No matching events." : "No events yet."}</li>
            ) : (
              shown.map((entry) => (
                <li key={entry.id} className="device-event-log-entry">
                  <time className="device-event-log-time" dateTime={entry.timestamp}>
                    {eventLogTime(entry.timestamp)}
                  </time>
                  <span className="device-event-log-summary">{entry.summary || entry.kind}</span>
                </li>
              ))
            )}
          </ol>
          <Text variant="small" color="secondary" role="status" className="device-event-log-count">
            {paused
              ? `Paused. ${waiting === 1 ? "1 new event" : `${waiting} new events`} waiting.`
              : `${shown.length} of ${entries.length} events`}
          </Text>
        </>
      ) : null}
    </section>
  );
}
