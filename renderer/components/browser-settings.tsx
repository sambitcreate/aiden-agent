import * as React from "react";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import type { BrowserCommand, BrowserCommandResult, BrowserDefaults, BrowserImportSource, BrowserState } from "../shared/browser";
import { BROWSER_DEVICE_PRESETS, validBrowserViewport } from "../lib/browser-ui-state";
import { Button, Dialog, Input, Text } from "./ui";

export function BrowserSettings({ state, open, onOpenChange, run }: {
  state: BrowserState; open: boolean; onOpenChange: (open: boolean) => void;
  run: (command: BrowserCommand) => Promise<BrowserCommandResult | null>;
}) {
  const [profileId, setProfileId] = React.useState(state.defaults.profileId);
  const [name, setName] = React.useState("");
  const [newName, setNewName] = React.useState("");
  const [sources, setSources] = React.useState<BrowserImportSource[] | null>(null);
  const [sourceId, setSourceId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [importMessage, setImportMessage] = React.useState("");
  const [defaultWidth, setDefaultWidth] = React.useState(String(state.defaults.viewport.width));
  const [defaultHeight, setDefaultHeight] = React.useState(String(state.defaults.viewport.height));
  const profile = state.profiles.find((candidate) => candidate.id === profileId) ?? state.profiles[0];
  React.useEffect(() => { setName(profile?.name ?? ""); }, [profile?.id, profile?.name]);
  React.useEffect(() => { setDefaultWidth(String(state.defaults.viewport.width)); setDefaultHeight(String(state.defaults.viewport.height)); }, [state.defaults.viewport.width, state.defaults.viewport.height]);
  const updateDefaults = (defaults: Partial<BrowserDefaults>) => void run({ action: "defaults", defaults });
  const defaultSizeValid = validBrowserViewport(Number(defaultWidth), Number(defaultHeight));
  const saveDefaultSize = () => { if (defaultSizeValid) updateDefaults({ viewport: { mode: "responsive", width: Number(defaultWidth), height: Number(defaultHeight) } }); };
  const operate = async (command: BrowserCommand) => {
    setBusy(true);
    try { return await run(command); } finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange} title="Browser settings" description="Browser preferences apply to new tabs opened by you or Aiden." onConfirm={() => onOpenChange(false)}>
    <div className="browser-settings">
      <section aria-labelledby="browser-defaults-heading">
        <Text id="browser-defaults-heading" variant="strong">New tabs</Text>
        <label className="browser-setting-row">Profile
          <select className="browser-select" value={state.defaults.profileId} onChange={(event) => updateDefaults({ profileId: event.target.value })}>
            {state.profiles.filter((item) => item.kind !== "incognito").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="browser-setting-row">Viewport
          <select className="browser-select" value={state.defaults.viewport.mode === "fill" ? "fill" : state.defaults.viewport.deviceName ?? "responsive"} onChange={(event) => {
            const preset = BROWSER_DEVICE_PRESETS.find(([label]) => label === event.target.value);
            updateDefaults({ viewport: preset ? { mode: "responsive", deviceName: preset[0], width: preset[1], height: preset[2] } : { mode: event.target.value === "fill" ? "fill" : "responsive", width: 1280, height: 720 } });
          }}>
            <option value="fill">Fit panel</option><option value="responsive">Responsive</option>
            {BROWSER_DEVICE_PRESETS.map(([label]) => <option key={label} value={label}>{label}</option>)}
          </select>
        </label>
        {state.defaults.viewport.mode === "responsive" ? <form className="browser-setting-row" onSubmit={(event) => { event.preventDefault(); saveDefaultSize(); }}><span>Dimensions</span><div className="browser-default-dimensions"><Input type="number" min={240} max={3840} aria-label="Default viewport width" aria-invalid={!defaultSizeValid} value={defaultWidth} onChange={(event) => setDefaultWidth(event.target.value)} onBlur={saveDefaultSize} /><span>×</span><Input type="number" min={240} max={3840} aria-label="Default viewport height" aria-invalid={!defaultSizeValid} value={defaultHeight} onChange={(event) => setDefaultHeight(event.target.value)} onBlur={saveDefaultSize} /><Button size="small" variant="transparent" iconOnly aria-label="Rotate default viewport" onClick={() => updateDefaults({ viewport: { ...state.defaults.viewport, width: state.defaults.viewport.height, height: state.defaults.viewport.width } })}><RotateCw /></Button></div></form> : null}
        <label className="browser-setting-row">Appearance
          <select className="browser-select" value={state.defaults.appearance} onChange={(event) => updateDefaults({ appearance: event.target.value as BrowserDefaults["appearance"] })}>
            <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
        <label className="browser-setting-row">Zoom
          <select className="browser-select" value={state.defaults.zoom} onChange={(event) => updateDefaults({ zoom: Number(event.target.value) })}>
            {[0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5].map((zoom) => <option key={zoom} value={zoom}>{Math.round(zoom * 100)}%</option>)}
          </select>
        </label>
        <label className="browser-setting-row">Recording frame rate
          <select className="browser-select" value={state.defaults.recordingFps} onChange={(event) => updateDefaults({ recordingFps: Number(event.target.value) })}>
            {[30, 60].map((fps) => <option key={fps} value={fps}>{fps} fps</option>)}
          </select>
        </label>
        <label className="browser-setting-row">Open links in
          <select className="browser-select" value={state.defaults.linkTarget} onChange={(event) => updateDefaults({ linkTarget: event.target.value as BrowserDefaults["linkTarget"] })}>
            <option value="browser">Aiden browser</option><option value="external">System browser</option>
          </select>
        </label>
        <label className="browser-setting-row"><span>Allow Aiden to use browsers by default</span><input type="checkbox" checked={state.defaults.agentAccess === "allow"} onChange={(event) => updateDefaults({ agentAccess: event.target.checked ? "allow" : "off" })} /></label>
        <label className="browser-setting-row">Access in this workspace
          <select className="browser-select" value={state.agentAccessOverride} onChange={(event) => void run({ action: "agent_access", access: event.target.value as BrowserState["agentAccessOverride"] })}>
            <option value="inherit">Use global default</option><option value="allow">Allow</option><option value="off">Off</option>
          </select>
        </label>
        <Text variant="small" color="secondary">Aiden browser access is {state.agentAccessAllowed ? "allowed" : "off"} in this workspace.</Text>
        <label className="browser-setting-row"><span>Show the browser when Aiden uses it</span><input type="checkbox" checked={state.defaults.autoShow} onChange={(event) => updateDefaults({ autoShow: event.target.checked })} /></label>
      </section>
      <section aria-labelledby="browser-profiles-heading">
        <Text id="browser-profiles-heading" variant="strong">Profiles</Text>
        <Text variant="small" color="secondary">Each profile keeps its own cookies and website data. Incognito data is discarded when its tabs close.</Text>
        <label className="browser-setting-row">Manage profile
          <select className="browser-select" value={profile?.id ?? ""} onChange={(event) => { setProfileId(event.target.value); setSources(null); setImportMessage(""); }}>
            {state.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {profile && !["default", "incognito"].includes(profile.id) ? <form className="browser-profile-edit" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void operate({ action: "profile_rename", profileId: profile.id, name: name.trim() }); }}>
          <Input aria-label="Profile name" value={name} maxLength={48} onChange={(event) => setName(event.target.value)} />
          <Button size="small" type="submit" disabled={busy || !name.trim() || name.trim() === profile.name}>Rename</Button>
          <Button size="small" iconOnly aria-label={`Delete ${profile.name} profile`} disabled={busy} onClick={() => void operate({ action: "profile_delete", profileId: profile.id }).then((result) => { if (result) setProfileId("default"); })}><Trash2 /></Button>
        </form> : null}
        <form className="browser-profile-edit" onSubmit={(event) => { event.preventDefault(); if (newName.trim()) void operate({ action: "profile_create", name: newName.trim() }).then((result) => { if (result) setNewName(""); }); }}>
          <Input aria-label="New profile name" placeholder="New profile name" value={newName} maxLength={48} onChange={(event) => setNewName(event.target.value)} />
          <Button size="small" type="submit" disabled={busy || !newName.trim()}><Plus />Add profile</Button>
        </form>
        {profile?.kind === "persistent" ? <div className="browser-import">
          <Button size="small" disabled={busy} onClick={() => void operate({ action: "import_sources" }).then((result) => { if (result) { setSources(result.importSources ?? []); setSourceId(result.importSources?.[0]?.id ?? ""); } })}>Import browser cookies…</Button>
          {sources ? sources.length ? <>
            <label className="browser-setting-row">Import from<select aria-label="Source browser profile" className="browser-select" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>{sources.map((source) => <option key={source.id} value={source.id}>{source.browser} — {source.profile}{source.running ? " (quit browser first)" : ""}</option>)}</select></label>
            <Text variant="small" color="secondary">Copy cookies into {profile.name}. Your source browser stays unchanged. macOS may ask for Keychain access.</Text>
            {sources.find((source) => source.id === sourceId)?.running ? <Text variant="small" color="secondary">Quit the source browser, then click Import browser cookies again to refresh its status.</Text> : null}
            <Button size="small" disabled={busy || !sourceId || sources.find((source) => source.id === sourceId)?.running} onClick={() => void operate({ action: "import_cookies", sourceId, profileId: profile.id }).then((result) => { if (result?.importResult) setImportMessage(`Imported ${result.importResult.imported} cookies. ${result.importResult.skipped} skipped.${result.importResult.warnings.length ? ` ${result.importResult.warnings.join(" ")}` : ""}`); })}>{busy ? "Importing…" : `Import into ${profile.name}`}</Button>
          </> : <Text variant="small" color="secondary">No supported browser profiles found.</Text> : null}
          {importMessage ? <p role="status" className="text-small text-secondary">{importMessage}</p> : null}
        </div> : null}
      </section>
    </div>
  </Dialog>;
}
