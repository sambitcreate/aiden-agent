import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Camera, Check, ExternalLink, Globe, History, Link2, Loader2, MessageCirclePlus, Minus, MoreVertical, PictureInPicture2, Plus, RadioTower, RotateCw, Settings2, Square, Unlink2, Volume2, VolumeX, X } from "lucide-react";
import type { BrowserAnnotation, BrowserCommand, BrowserCommandResult, BrowserImage, BrowserSnapshot, BrowserState, BrowserStylePreview, BrowserTab, BrowserViewport } from "../shared/browser";
import { browserApi } from "../lib/ipc";
import { acceptBrowserState, BROWSER_DEVICE_PRESETS, browserBoundsFromRect, enqueueBrowserPresentation, resizeBrowserViewport, savedBrowserScreenshotPath, validBrowserViewport } from "../lib/browser-ui-state";
import { Button, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, Text, toast } from "./ui";
import { BrowserSettings } from "./browser-settings";
import { BrowserFloatingFrame } from "./browser-floating-frame";
import { BrowserAnnotationEditor } from "./browser-annotation-editor";
import { captureBrowserAnnotation } from "../lib/browser-annotation-capture";
import { BROWSER_ANNOTATION_UNAVAILABLE, browserAnnotationDelivery } from "../lib/browser-annotation-delivery";
import { BrowserAnnotationPreviewQueue } from "../lib/browser-annotation-preview-queue";

/* Browser is an extension of the Environment work surface. Compact tab and
 * navigation rows follow the supplied reference; page content owns the area.
 * Existing Aiden tokens supply color, focus, motion and control feedback. */

const ZOOM_STEPS = [.25, .33, .5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
type RunCommand = (command: BrowserCommand) => Promise<BrowserCommandResult | null>;

export function BrowserPanel({ workspaceId, active, onDock }: { workspaceId: string; active: boolean; onDock?: () => void }) {
  const [state, setState] = React.useState<BrowserState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = React.useState(false);
  const [pickerActive, setPickerActive] = React.useState(false);
  const [annotation, setAnnotation] = React.useState<{ tabId: string; snapshot: BrowserSnapshot; initial?: BrowserAnnotation } | null>(null);
  const [annotationPending, setAnnotationPending] = React.useState(false);
  const annotationSubmissionRef = React.useRef({ revision: 0, pending: false });
  const annotationTargetRef = React.useRef<{ workspaceId: string; tabId: string } | null>(null);
  const annotationPreviewQueueRef = React.useRef(new BrowserAnnotationPreviewQueue());
  const ownerRef = React.useRef(workspaceId);
  const activeRef = React.useRef(active);
  const tabIdRef = React.useRef<string | null>(null);
  const mountedRef = React.useRef(true);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const addressRef = React.useRef<HTMLInputElement>(null);
  const presentationRef = React.useRef<(() => void) | null>(null);
  const floatingSourceRef = React.useRef<{ tabId: string; width: number; height: number } | null>(null);
  const [address, setAddress] = React.useState("");
  const [addressFocused, setAddressFocused] = React.useState(false);
  ownerRef.current = workspaceId;
  const visibleState = state?.workspaceId === workspaceId ? state : null;
  const tab = visibleState?.tabs.find((item) => item.id === visibleState.activeTabId) ?? null;
  const surfaceActive = active || Boolean(tab?.floating);
  activeRef.current = surfaceActive;
  if (tab?.floating && floatingSourceRef.current?.tabId !== tab.id) floatingSourceRef.current = { tabId: tab.id, width: tab.viewport.width, height: tab.viewport.height };
  if (!tab?.floating) floatingSourceRef.current = null;
  const floatingLayout = React.useCallback(() => { presentationRef.current?.(); }, []);
  tabIdRef.current = tab?.id ?? null;
  const ready = Boolean(tab?.url && tab.url !== "about:blank" && !tab.error && !tab.crashed);
  const cancelAnnotation = React.useCallback(() => {
    const target = annotationTargetRef.current;
    annotationTargetRef.current = null;
    void annotationPreviewQueueRef.current.reset(() => target ? browserApi.command(target.workspaceId, { action: "annotation_reset", tabId: target.tabId }) : Promise.resolve()).catch(() => undefined);
    annotationSubmissionRef.current = { revision: annotationSubmissionRef.current.revision + 1, pending: false };
    setAnnotationPending(false);
    setAnnotation(null);
  }, []);

  const commit = React.useCallback((next: BrowserState) => {
    if (!mountedRef.current) return;
    setState((current) => acceptBrowserState(current, next, ownerRef.current));
  }, []);
  const run = React.useCallback<RunCommand>(async (command) => {
    const owner = workspaceId;
    try {
      const result = await browserApi.command(owner, command);
      if (!mountedRef.current || ownerRef.current !== owner) return null;
      commit(result.state);
      setError(null);
      return result;
    } catch (cause) {
      if (mountedRef.current && ownerRef.current === owner) setError(cause instanceof Error ? cause.message : "The browser action could not be completed. Try again.");
      return null;
    }
  }, [workspaceId, commit]);

  const previewAnnotation = React.useCallback((changes: BrowserStylePreview[]) => {
    const target = annotationTargetRef.current;
    if (!target) return Promise.resolve(null);
    return annotationPreviewQueueRef.current.run(() => run({ action: "annotation_preview", tabId: target.tabId, changes })).then((result) => {
      if (!result || annotationTargetRef.current !== target) return null;
      if (result.snapshot) setAnnotation((current) => current?.tabId === target.tabId ? { ...current, snapshot: result.snapshot! } : current);
      return result;
    });
  }, [run]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const target = annotationTargetRef.current;
      annotationTargetRef.current = null;
      void annotationPreviewQueueRef.current.reset(() => target ? browserApi.command(target.workspaceId, { action: "annotation_reset", tabId: target.tabId }) : Promise.resolve()).catch(() => undefined);
    };
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    setState(null); setError(null); cancelAnnotation(); setPickerActive(false); setAddressFocused(false);
    const unsubscribe = browserApi.onEvent((event) => { if (event.type === "state") commit(event.state); });
    void browserApi.getState(workspaceId).then((next) => { if (!cancelled) commit(next); }, (cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not open the browser."); });
    return () => { cancelled = true; unsubscribe(); };
  }, [workspaceId, commit, cancelAnnotation]);

  React.useEffect(() => {
    cancelAnnotation(); setAddressFocused(false); setPickerActive(false);
    return () => { if (tab?.id) void browserApi.command(workspaceId, { action: "annotate", tabId: tab.id, enabled: false }).catch(() => undefined); };
  }, [workspaceId, tab?.id, cancelAnnotation]);

  React.useEffect(() => {
    if (surfaceActive || !tab?.id) return;
    setPickerActive(false);
    void browserApi.command(workspaceId, { action: "annotate", tabId: tab.id, enabled: false }).catch(() => undefined);
  }, [surfaceActive, workspaceId, tab?.id]);

  // Main-owned page views stay alive while hidden. They must be removed from the
  // native stacking order whenever a renderer menu, dialog or annotation covers them.
  React.useLayoutEffect(() => {
    if (!tab || !hostRef.current) return;
    const host = hostRef.current;
    const tabId = tab.id;
    let frame = 0;
    let disposed = false;
    let previous = "";
    const presentationKey = `${workspaceId}:${tabId}`;
    const present = () => {
      frame = 0;
      if (disposed) return;
      const bounds = browserBoundsFromRect(host.getBoundingClientRect());
      const overlay = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [data-slot="popover-content"]'))
        .some((element) => element.getBoundingClientRect().width > 0 && element.getAttribute("data-state") !== "closed");
      const visible = surfaceActive && ready && !annotation && !settingsOpen && !menuOpen && !profileMenuOpen && !overlay && Boolean(bounds);
      const command: BrowserCommand = { action: "present", tabId, visible, ...(bounds ? { bounds } : {}) };
      const key = JSON.stringify(command);
      if (previous === key) return;
      previous = key;
      void enqueueBrowserPresentation(presentationKey, async () => { if (!disposed) await browserApi.command(workspaceId, command); }).catch(() => undefined);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(present); };
    presentationRef.current = schedule;
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    const overlays = new MutationObserver(schedule);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "aria-hidden", "inert"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    present();
    return () => {
      disposed = true; window.cancelAnimationFrame(frame); resize.disconnect(); overlays.disconnect();
      if (presentationRef.current === schedule) presentationRef.current = null;
      window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); document.removeEventListener("transitionend", schedule, true);
      void enqueueBrowserPresentation(presentationKey, () => browserApi.command(workspaceId, { action: "present", tabId, visible: false })).catch(() => undefined);
    };
  }, [workspaceId, tab?.id, tab?.floating, surfaceActive, ready, annotation, settingsOpen, menuOpen, profileMenuOpen]);

  const submitAddress = React.useCallback((url: string) => {
    if (!url.trim()) return;
    void run(tab ? { action: "navigate", tabId: tab.id, url: url.trim() } : { action: "create", url: url.trim() }).then((result) => {
      if (result?.state.activeTabId && activeRef.current && document.activeElement === document.body) void run({ action: "focus", tabId: result.state.activeTabId });
    });
    setAddressFocused(false); addressRef.current?.blur();
  }, [run, tab]);
  const capture = React.useCallback(async (record: boolean) => {
    if (!tab) return;
    if (tab.recording) {
      const result = await run({ action: "record_stop", tabId: tab.id });
      if (result?.recording) {
        const recording = result.recording;
        toast.success("Recording saved", { description: recording.path, action: { label: "Show in Finder", onClick: () => void run({ action: "reveal_recording", recordingId: recording.id }) } });
      }
    } else if (record) await run({ action: "record_start", tabId: tab.id });
    else {
      const result = await run({ action: "screenshot", tabId: tab.id });
      if (result?.image) {
        const image = result.image;
        const saved = await run({ action: "save_image", image });
        const path = savedBrowserScreenshotPath(saved);
        if (path) toast.success("Screenshot saved", { description: path, action: { label: "Copy image", onClick: () => void copyBrowserImage(image).catch(() => toast.error("Could not copy the screenshot.")) } });
      }
    }
  }, [run, tab]);
  const annotate = React.useCallback(async () => {
    if (!tab || !ready) return;
    if (annotation) { cancelAnnotation(); return; }
    if (pickerActive) { await run({ action: "annotate", tabId: tab.id, enabled: false }); setPickerActive(false); return; }
    const tabId = tab.id;
    setPickerActive(true);
    const result = await run({ action: "annotate", tabId, enabled: true });
    if (!mountedRef.current || ownerRef.current !== workspaceId || tabIdRef.current !== tabId || !activeRef.current) return;
    setPickerActive(false);
    if (!result?.annotation) return;
    const snapshot = await run({ action: "snapshot", tabId, includeImage: true, includeAllElements: true });
    if (tabIdRef.current !== tabId || !activeRef.current) return;
    const capturedSnapshot = snapshot?.snapshot ?? { tab, text: result.annotation.selectedText ?? "", elements: result.annotation.elements, diagnostics: [], image: result.annotation.image };
    if (!capturedSnapshot.image) toast.error("Screenshot unavailable. Your selected text and elements were kept.");
    annotationTargetRef.current = { workspaceId, tabId };
    setAnnotation({ tabId, initial: result.annotation, snapshot: capturedSnapshot });
  }, [run, tab, ready, annotation, pickerActive, workspaceId, cancelAnnotation]);

  const submitAnnotation = React.useCallback(async (value: BrowserAnnotation) => {
    if (!annotation || annotationSubmissionRef.current.pending) return;
    const recipient = browserAnnotationDelivery.capture(workspaceId);
    if (!recipient) { setError(BROWSER_ANNOTATION_UNAVAILABLE); return; }
    const submission = { revision: annotationSubmissionRef.current.revision + 1, pending: true };
    annotationSubmissionRef.current = submission;
    setAnnotationPending(true);
    try {
      const prepared = await captureBrowserAnnotation(value, annotation.snapshot).catch(() => {
        toast.error("Could not capture the selection. Your annotation was kept without an image.");
        return { ...value, image: undefined, imageBounds: undefined };
      });
      if (annotationSubmissionRef.current !== submission || !mountedRef.current) return;
      const result = await run({ action: "annotation_submit", tabId: annotation.tabId, annotation: prepared, delivery: "renderer" });
      if (!result || annotationSubmissionRef.current !== submission || !mountedRef.current) return;
      if (result.annotation && recipient.deliver(result.annotation)) cancelAnnotation();
      else setError(BROWSER_ANNOTATION_UNAVAILABLE);
    } finally {
      if (annotationSubmissionRef.current === submission) {
        submission.pending = false;
        if (mountedRef.current) setAnnotationPending(false);
      }
    }
  }, [annotation, workspaceId, run, cancelAnnotation]);

  React.useEffect(() => {
    if (!surfaceActive) return;
    return browserApi.onEvent((event) => {
      if (event.type !== "shortcut" || event.workspaceId !== workspaceId || event.tabId !== tab?.id) return;
      if (event.shortcut === "annotate") void annotate();
      else if (event.shortcut === "focus_address") { addressRef.current?.focus(); addressRef.current?.select(); }
      else void run({ action: "reload", tabId: event.tabId, ignoreCache: event.shortcut === "hard_reload" });
    });
  }, [surfaceActive, workspaceId, tab?.id, annotate, run]);

  React.useEffect(() => {
    if (!surfaceActive) return;
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === ".") { event.preventDefault(); event.stopPropagation(); void annotate(); }
      else if (key === "l" && panelRef.current?.contains(document.activeElement)) { event.preventDefault(); addressRef.current?.focus(); }
      else if (key === "r" && panelRef.current?.contains(document.activeElement) && tab) { event.preventDefault(); void run({ action: "reload", tabId: tab.id, ignoreCache: event.shiftKey }); }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [surfaceActive, annotate, tab, run]);

  const content = <div ref={panelRef} className="browser-panel" data-browser-workspace={workspaceId}>
    <div className="browser-tab-strip">
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {visibleState?.tabs.map((item, index) => <div key={item.id} className="browser-tab" data-selected={item.id === tab?.id}>
          <button type="button" className="browser-tab-select" role="tab" aria-label={item.title || "New tab"} aria-selected={item.id === tab?.id} tabIndex={item.id === tab?.id ? 0 : -1} onClick={() => void run({ action: "select", tabId: item.id })} onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const tabs = visibleState.tabs;
            const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
            void run({ action: "select", tabId: next.id }).then(() => panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
          }}>{item.loading ? <Loader2 className="animate-spin" /> : <BrowserFavicon src={item.favicon} />}<span>{item.title || "New tab"}</span></button>
          {item.audible || item.muted ? <button type="button" className="browser-tab-close" aria-label={item.muted ? "Unmute tab" : "Mute tab"} onClick={() => void run({ action: "mute", tabId: item.id, muted: !item.muted })}>{item.muted ? <VolumeX /> : <Volume2 />}</button> : null}
          <button type="button" className="browser-tab-close" aria-label={`Close ${item.title || "new tab"}`} onClick={() => void run({ action: "close", tabId: item.id })}><X /></button>
        </div>)}
      </div>
      <Button variant="transparent" size="small" iconOnly aria-label="New browser tab" title="New browser tab" onClick={() => void run({ action: "create" }).then(() => addressRef.current?.focus())}><Plus /></Button>
      <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
        <DropdownMenuTrigger asChild><Button variant="transparent" size="small" className="browser-profile-button" title="Browser profile" aria-label="Choose browser profile">{visibleState?.profiles.find((profile) => profile.id === tab?.profileId)?.name ?? "Default"}</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuLabel>Open a new tab in</DropdownMenuLabel>{visibleState?.profiles.map((profile) => <DropdownMenuItem key={profile.id} onSelect={() => void run({ action: "create", profileId: profile.id })}>{profile.name}{profile.id === tab?.profileId ? <Check className="ml-auto size-3.5" /> : null}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setSettingsOpen(true)}>Browser settings…</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div className="browser-chrome" data-loading={tab?.loading ?? false}>
      <div className="browser-control-group" role="group" aria-label="Browser navigation">
        <Button variant="transparent" size="small" iconOnly aria-label="Back" disabled={!tab?.canGoBack} onClick={() => tab && void run({ action: "back", tabId: tab.id })}><ArrowLeft /></Button>
        <Button variant="transparent" size="small" iconOnly aria-label="Forward" disabled={!tab?.canGoForward} onClick={() => tab && void run({ action: "forward", tabId: tab.id })}><ArrowRight /></Button>
        <Button variant="transparent" size="small" iconOnly aria-label={tab?.loading ? "Stop loading" : "Reload"} disabled={!tab?.url} onClick={() => tab && void run({ action: tab.loading ? "stop" : "reload", tabId: tab.id })}>{tab?.loading ? <Square /> : <RotateCw />}</Button>
      </div>
      <form className="browser-address-form" onSubmit={(event) => { event.preventDefault(); submitAddress(address); }}>
        <Input ref={addressRef} aria-label="Search or enter URL" placeholder="Search or enter URL" spellCheck={false} autoComplete="off" value={addressFocused ? address : tab?.url === "about:blank" ? "" : tab?.url ?? ""} onChange={(event) => setAddress(event.target.value)} onFocus={() => { setAddress(tab?.url === "about:blank" ? "" : tab?.url ?? ""); setAddressFocused(true); queueMicrotask(() => addressRef.current?.select()); }} onBlur={() => setAddressFocused(false)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setAddressFocused(false); event.currentTarget.blur(); } }} />
      </form>
      <Button variant={pickerActive || annotation ? "muted" : "transparent"} size="small" iconOnly aria-label={pickerActive || annotation ? "Cancel annotation" : "Annotate"} aria-pressed={pickerActive || Boolean(annotation)} aria-keyshortcuts="Meta+." title="Annotate ⌘." disabled={!ready} onClick={() => void annotate()}><MessageCirclePlus /></Button>
      <BrowserMoreMenu tab={tab} state={visibleState} open={menuOpen} onOpenChange={setMenuOpen} run={run} onCapture={capture} onSettings={() => setSettingsOpen(true)} onDock={onDock} />
    </div>
    {tab?.viewport.mode === "responsive" ? <BrowserDeviceToolbar tab={tab} run={run} /> : null}
    {pickerActive ? <div className="browser-picker-status" role="status">Select an element or highlighted text. Press Esc to cancel.</div> : null}
    {tab?.agentControlling ? <div className="browser-agent-status" role="status">Aiden is using this browser</div> : null}
    {error ? <div className="browser-action-error" role="alert"><span>{error}</span><Button size="small" variant="transparent" iconOnly aria-label="Dismiss browser error" onClick={() => setError(null)}><X /></Button></div> : null}
    <div className="browser-content" data-responsive={tab?.viewport.mode === "responsive"}>
      <div className="browser-native-slot" ref={hostRef} data-browser-viewport />
      {ready && tab && !annotation ? <button type="button" className="browser-page-focus" onFocus={() => void run({ action: "focus", tabId: tab.id })} onClick={() => void run({ action: "focus", tabId: tab.id })}>Focus browser page</button> : null}
      {tab?.viewport.mode === "responsive" && ready && !annotation && !tab.floating ? <BrowserViewportResizeHandles tab={tab} run={run} /> : null}
      {annotation ? <BrowserAnnotationEditor snapshot={annotation.snapshot} initial={annotation.initial} pending={annotationPending} onCancel={cancelAnnotation} onPreview={previewAnnotation} onSubmit={(value) => void submitAnnotation(value)} />
        : tab?.error || tab?.crashed ? <div className="browser-empty"><Globe /><Text variant="strong">{tab.crashed ? "This page stopped responding" : "This page could not be loaded"}</Text><p>{tab.error || "Reload the page to continue."}</p><Button size="small" onClick={() => void run({ action: "reload", tabId: tab.id })}>Reload page</Button></div>
        : !ready ? <BrowserEmptyState state={visibleState} onOpen={submitAddress} run={run} /> : null}
    </div>
    {visibleState ? <BrowserSettings state={visibleState} open={settingsOpen} onOpenChange={setSettingsOpen} run={run} /> : null}
  </div>;
  if (!tab?.floating) return content;
  const dock = () => { void run({ action: "float", tabId: tab.id, floating: false }).then((result) => { if (result) onDock?.(); }); };
  return <>
    <div className="browser-empty"><PictureInPicture2 /><Text variant="strong">Browser is floating over chat</Text><Button size="small" onClick={dock}>Return to Environment</Button></div>
    {createPortal(<BrowserFloatingFrame key={workspaceId} frameKey={workspaceId} source={floatingSourceRef.current ?? tab.viewport} chromeHeight={114 + (tab.viewport.mode === "responsive" ? 54 : 0)} pictureInPicture={tab.pictureInPicture} onDock={dock} onClose={() => void run({ action: "float", tabId: tab.id, floating: false })} onPictureInPicture={() => void run({ action: "picture_in_picture", tabId: tab.id, enabled: !tab.pictureInPicture })} onLayout={floatingLayout}>{content}</BrowserFloatingFrame>, document.body)}
  </>;
}

function BrowserFavicon({ src }: { src?: string }) {
  const [failedSource, setFailedSource] = React.useState<string | null>(null);
  return src && failedSource !== src
    ? <img src={src} alt="" onError={() => setFailedSource(src)} />
    : <Globe aria-hidden="true" />;
}

function BrowserEmptyState({ state, onOpen, run }: { state: BrowserState | null; onOpen: (url: string) => void; run: RunCommand }) {
  if (!state) return <div className="browser-empty"><Loader2 className="animate-spin" /><Text color="secondary">Opening browser…</Text></div>;
  const history = state.history.slice(0, 10);
  if (!history.length && !state.servers.length) return <div className="browser-empty"><Globe /><Text variant="strong">No page open</Text><p>Enter a URL above, or run a dev server in your workspace. Local servers appear here automatically.</p></div>;
  return <div className="browser-start-page">
    {history.length ? <section><h3><History />Recently used</h3><div className="browser-recent-list">{history.map((entry) => <div key={entry.url} className="browser-recent-row"><button type="button" onClick={() => onOpen(entry.url)}><span>{entry.title || entry.url}</span><small>{entry.url}</small></button><Button size="small" variant="transparent" iconOnly aria-label={`Remove ${entry.title || entry.url} from history`} onClick={() => void run({ action: "history_remove", url: entry.url })}><X /></Button></div>)}</div></section> : null}
    {state.servers.length ? <section><h3><RadioTower />Local servers</h3><div className="browser-recent-list">{state.servers.map((server) => <div key={server.url} className="browser-recent-row"><button type="button" onClick={() => onOpen(server.url)}><span>{server.label}</span><small>{server.url}</small></button><ExternalLink className="size-4 text-tertiary" /></div>)}</div></section> : null}
  </div>;
}

function BrowserMoreMenu({ tab, state, open, onOpenChange, run, onCapture, onSettings, onDock }: { tab: BrowserTab | null; state: BrowserState | null; open: boolean; onOpenChange: (open: boolean) => void; run: RunCommand; onCapture: (record: boolean) => Promise<void>; onSettings: () => void; onDock?: () => void }) {
  const captureShiftRef = React.useRef(false);
  const disabled = !tab?.url;
  const profileId = tab?.profileId ?? state?.defaults.profileId ?? "default";
  return <DropdownMenu open={open} onOpenChange={onOpenChange}>
    <DropdownMenuTrigger asChild><Button variant="transparent" size="small" iconOnly aria-label="Browser menu" title="Browser menu"><MoreVertical /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="browser-more-menu">
      <DropdownMenuItem disabled={disabled} onSelect={() => tab && void run({ action: "open_external", tabId: tab.id })}><ExternalLink />Open in system browser</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => tab && void run({ action: "reload", tabId: tab.id, ignoreCache: true })}>Hard reload</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => tab && void run({ action: "devtools", tabId: tab.id })}>Open DevTools</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={disabled || Boolean(tab?.error)} onPointerDown={(event) => { captureShiftRef.current = event.shiftKey; }} onKeyDown={(event) => { captureShiftRef.current = event.shiftKey; }} onSelect={() => { void onCapture(captureShiftRef.current); captureShiftRef.current = false; }}><Camera />{tab?.recording ? "Stop recording" : "Capture screenshot"}<span className="ml-auto text-mini opacity-70">⇧ record</span></DropdownMenuItem>
      <DropdownMenuItem disabled={disabled || Boolean(tab?.error)} onSelect={() => void onCapture(true)}>{tab?.recording ? "Stop recording" : "Record browser"}</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => tab && void run({ action: "float", tabId: tab.id, floating: !tab.floating }).then((result) => { if (result && tab.floating) onDock?.(); })}><PictureInPicture2 />{tab?.floating ? "Return to Environment" : "Float browser over chat"}</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => tab && void run({ action: "picture_in_picture", tabId: tab.id, enabled: !tab.pictureInPicture })}>{tab?.pictureInPicture ? "Close separate preview window" : "Open separate preview window"}</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => tab && void run({ action: "viewport", tabId: tab.id, viewport: { ...tab.viewport, mode: tab.viewport.mode === "fill" ? "responsive" : "fill" } })}>{tab?.viewport.mode === "responsive" ? "Hide device toolbar" : "Show device toolbar"}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Appearance</DropdownMenuLabel>
      {(["system", "light", "dark"] as const).map((appearance) => <DropdownMenuCheckboxItem key={appearance} checked={tab?.appearance === appearance} disabled={disabled} onCheckedChange={() => tab && void run({ action: "appearance", tabId: tab.id, appearance })}>{appearance[0].toUpperCase() + appearance.slice(1)}</DropdownMenuCheckboxItem>)}
      <DropdownMenuSeparator />
      <div className="browser-zoom-row"><span>Zoom</span><Button variant="transparent" size="small" iconOnly disabled={disabled || (tab?.zoom ?? 1) <= .25} aria-label="Zoom out" onClick={() => tab && void run({ action: "zoom", tabId: tab.id, zoom: [...ZOOM_STEPS].reverse().find((value) => value < tab.zoom - .001) ?? .25 })}><Minus /></Button><button type="button" className="browser-zoom-reset" disabled={disabled} aria-label="Reset zoom" onClick={() => tab && void run({ action: "zoom", tabId: tab.id, zoom: 1 })}>{Math.round((tab?.zoom ?? 1) * 100)}%</button><Button variant="transparent" size="small" iconOnly disabled={disabled || (tab?.zoom ?? 1) >= 5} aria-label="Zoom in" onClick={() => tab && void run({ action: "zoom", tabId: tab.id, zoom: ZOOM_STEPS.find((value) => value > tab.zoom + .001) ?? 5 })}><Plus /></Button></div>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Profile: {state?.profiles.find((profile) => profile.id === profileId)?.name ?? "Default"}</DropdownMenuLabel>
      <DropdownMenuItem onSelect={() => void run({ action: "clear_cookies", profileId })}>Clear cookies</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void run({ action: "clear_cache", profileId })}>Clear cache</DropdownMenuItem>
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={onSettings}><Settings2 />Browser settings…</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function BrowserDeviceToolbar({ tab, run }: { tab: BrowserTab; run: RunCommand }) {
  const [width, setWidth] = React.useState(String(tab.viewport.width));
  const [height, setHeight] = React.useState(String(tab.viewport.height));
  React.useEffect(() => { setWidth(String(tab.viewport.width)); setHeight(String(tab.viewport.height)); }, [tab.id, tab.viewport.width, tab.viewport.height]);
  const valid = validBrowserViewport(Number(width), Number(height));
  const apply = (viewport: BrowserViewport) => void run({ action: "viewport", tabId: tab.id, viewport });
  const commitSize = (dimension: "width" | "height") => {
    const viewport = resizeBrowserViewport(tab.viewport, Number(width), Number(height), dimension);
    if (viewport) apply(viewport);
  };
  return <div className="browser-device-toolbar" role="group" aria-label="Browser device toolbar">
    <select className="browser-select" aria-label="Browser device preset" value={tab.viewport.deviceName ?? "responsive"} onChange={(event) => {
      const preset = BROWSER_DEVICE_PRESETS.find(([label]) => label === event.target.value);
      apply(preset ? { mode: "responsive", deviceName: preset[0], width: preset[1], height: preset[2], ratioLocked: tab.viewport.ratioLocked } : { ...tab.viewport, deviceName: undefined });
    }}><option value="responsive">Responsive</option>{BROWSER_DEVICE_PRESETS.map(([label, presetWidth, presetHeight]) => <option key={label} value={label}>{label} ({presetWidth} × {presetHeight})</option>)}</select>
    <input aria-label="Viewport width" type="number" min={240} max={3840} value={width} aria-invalid={!valid} onChange={(event) => setWidth(event.target.value)} onBlur={() => commitSize("width")} onKeyDown={(event) => { if (event.key === "Enter") commitSize("width"); }} /><span>×</span>
    <input aria-label="Viewport height" type="number" min={240} max={3840} value={height} aria-invalid={!valid} onChange={(event) => setHeight(event.target.value)} onBlur={() => commitSize("height")} onKeyDown={(event) => { if (event.key === "Enter") commitSize("height"); }} />
    <Button variant="transparent" size="small" iconOnly aria-label={tab.viewport.ratioLocked ? "Unlock viewport aspect ratio" : "Lock viewport aspect ratio"} aria-pressed={tab.viewport.ratioLocked ?? false} onClick={() => apply({ ...tab.viewport, ratioLocked: !tab.viewport.ratioLocked })}>{tab.viewport.ratioLocked ? <Link2 /> : <Unlink2 />}</Button>
    <Button variant="transparent" size="small" iconOnly aria-label="Rotate viewport" onClick={() => apply({ ...tab.viewport, width: tab.viewport.height, height: tab.viewport.width })}><RotateCw /></Button>
    <Button variant="transparent" size="small" iconOnly aria-label="Close device toolbar" onClick={() => apply({ ...tab.viewport, mode: "fill" })}><X /></Button>
  </div>;
}

function BrowserViewportResizeHandles({ tab, run }: { tab: BrowserTab; run: RunCommand }) {
  const [dragging, setDragging] = React.useState(false);
  const dragRef = React.useRef<{ x: number; y: number; width: number; height: number; dimension: "width" | "height" | "both" } | null>(null);
  const latestRef = React.useRef(tab.viewport);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const commit = () => { if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = null; void run({ action: "viewport", tabId: tab.id, viewport: latestRef.current }); };
  return <>
    {(["width", "height", "both"] as const).map((dimension) => <div key={dimension} className={`browser-viewport-resize browser-viewport-resize-${dimension}`} role="separator" tabIndex={0} aria-label={`Resize browser viewport ${dimension === "both" ? "diagonally" : dimension}`} aria-orientation={dimension === "height" ? "horizontal" : "vertical"} aria-valuemin={240} aria-valuemax={3840} aria-valuenow={dimension === "height" ? tab.viewport.height : tab.viewport.width} onKeyDown={(event) => {
      const amount = event.shiftKey ? 40 : 10;
      const delta = ["ArrowRight", "ArrowDown"].includes(event.key) ? amount : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -amount : 0;
      if (!delta) return;
      event.preventDefault();
      const viewport = resizeBrowserViewport(tab.viewport, tab.viewport.width + (dimension !== "height" ? delta : 0), tab.viewport.height + (dimension !== "width" ? delta : 0), dimension === "height" ? "height" : "width");
      if (viewport) void run({ action: "viewport", tabId: tab.id, viewport });
    }} onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      latestRef.current = tab.viewport;
      dragRef.current = { x: event.clientX, y: event.clientY, width: tab.viewport.width, height: tab.viewport.height, dimension };
    }} onPointerMove={(event) => {
      const drag = dragRef.current;
      if (!drag) return;
      const viewport = resizeBrowserViewport(tab.viewport, drag.width + (drag.dimension !== "height" ? (event.clientX - drag.x) * 2 : 0), drag.height + (drag.dimension !== "width" ? event.clientY - drag.y : 0), drag.dimension === "height" ? "height" : "width");
      if (!viewport) return;
      latestRef.current = viewport;
      if (!timerRef.current) timerRef.current = setTimeout(commit, 60);
    }} onPointerUp={() => { if (dragRef.current) commit(); dragRef.current = null; setDragging(false); }} onPointerCancel={() => { if (dragRef.current) commit(); dragRef.current = null; setDragging(false); }} />)}
    {dragging ? <div className="browser-viewport-drag-shield" aria-hidden="true" /> : null}
  </>;
}

async function copyBrowserImage(image: BrowserImage) {
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  await navigator.clipboard.write([new ClipboardItem({ [image.mimeType]: new Blob([bytes], { type: image.mimeType }) })]);
}
