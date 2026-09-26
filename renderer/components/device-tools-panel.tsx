/**
 * Adapted from t3code apps/web/src/components/device/DeviceToolsPanel.tsx @ 1c127066 (MIT)
 *
 * The Device tools drawer for one open iOS simulator: the settings the
 * simulator reports, one control per typed action, and the frontmost app. The
 * accessibility overlay, event log, and host diagnostics are deferred (see the
 * Phase 3.5 plan).
 */
import * as React from "react";
import { X } from "lucide-react";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Text } from "./ui";
import type { DeviceControls } from "../lib/device-controls";
import type {
  DeviceColorFilter,
  DevicePermission,
  DevicePermissionDecision,
  DeviceTextSize,
  DeviceToggle,
} from "../shared/devices";

export const DEVICE_TEXT_SIZE_OPTIONS: ReadonlyArray<{ value: DeviceTextSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Extra large" },
];

const COLOR_FILTERS: ReadonlyArray<{ value: DeviceColorFilter; label: string }> = [
  { value: "none", label: "None" },
  { value: "grayscale", label: "Grayscale" },
  { value: "red-green", label: "Red / green (protanopia)" },
  { value: "green-red", label: "Green / red (deuteranopia)" },
  { value: "blue-yellow", label: "Blue / yellow (tritanopia)" },
];

const TOGGLES: ReadonlyArray<{ setting: DeviceToggle; label: string }> = [
  { setting: "reduceMotion", label: "Reduce Motion" },
  { setting: "increaseContrast", label: "Increase Contrast" },
  { setting: "reduceTransparency", label: "Reduce Transparency" },
  { setting: "showBorders", label: "Show Borders" },
  { setting: "voiceOver", label: "VoiceOver" },
];

const PERMISSIONS: ReadonlyArray<{ value: DevicePermission; label: string }> = [
  { value: "camera", label: "Camera" },
  { value: "microphone", label: "Microphone" },
  { value: "photos", label: "Photos" },
  { value: "contacts", label: "Contacts" },
  { value: "calendar", label: "Calendar" },
  { value: "reminders", label: "Reminders" },
  { value: "location", label: "Location" },
  { value: "notifications", label: "Notifications" },
  { value: "motion", label: "Motion" },
  { value: "media-library", label: "Media library" },
  { value: "faceid", label: "Face ID" },
];

export const DEVICE_LOCATION_PRESETS = [
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5074, longitude: -0.1278 },
  { label: "Stockholm", latitude: 59.3293, longitude: 18.0686 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
] as const;

export function DeviceToolsPanel({ controls, onClose }: { controls: DeviceControls; onClose(): void }) {
  const { settings, pending, error, foregroundApp, disabled, act } = controls;
  return (
    <section className="device-tools" aria-labelledby="device-tools-title" aria-busy={pending}>
      <header className="device-tools-header">
        <Text id="device-tools-title" variant="small-strong">
          Device tools
        </Text>
        <Button variant="transparent" size="small" iconOnly aria-label="Close device tools" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </header>
      <div className="device-tools-body">
        {error ? (
          <p className="device-tools-error" role="alert">
            {error}
          </p>
        ) : null}
        {settings === null && !error ? (
          <Text variant="small" color="secondary" className="device-tools-note" role="status">
            Reading simulator settings…
          </Text>
        ) : null}

        <ToolsSection title="App">
          <Row label="Foreground">
            <span className="device-tools-mono truncate">{foregroundApp?.id ?? "—"}</span>
          </Row>
          {foregroundApp ? (
            <div className="device-tools-actions">
              <Button
                size="small"
                variant="muted"
                disabled={disabled}
                onClick={() => void act({ type: "terminateApp", appId: foregroundApp.id })}
              >
                Quit
              </Button>
              <Button
                size="small"
                variant="muted"
                disabled={disabled}
                onClick={() => void act({ type: "launchApp", appId: foregroundApp.id })}
              >
                Relaunch
              </Button>
            </div>
          ) : null}
          <SubmitRow
            label="URL to open"
            placeholder="https://… or myapp://"
            action="Open"
            disabled={disabled}
            onSubmit={(url) => act({ type: "openUrl", url })}
          />
          <SubmitRow
            label="Bundle ID to launch"
            placeholder="Bundle ID to launch"
            action="Launch"
            disabled={disabled}
            onSubmit={(appId) => act({ type: "launchApp", appId })}
          />
        </ToolsSection>

        <ToolsSection title="Simulator">
          <Row label="Appearance">
            <Segmented
              label="Appearance"
              value={settings?.appearance}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              disabled={disabled}
              onChange={(value) => void act({ type: "setAppearance", value })}
            />
          </Row>
          <Row label="Text size">
            <ChoiceSelect
              label="Text size"
              value={settings?.textSize}
              options={DEVICE_TEXT_SIZE_OPTIONS}
              disabled={disabled}
              onChange={(value) => void act({ type: "setTextSize", value })}
            />
          </Row>
          <Row label="Liquid Glass">
            <Segmented
              label="Liquid Glass"
              value={settings?.liquidGlass}
              options={[
                { value: "clear", label: "Clear" },
                { value: "tinted", label: "Tinted" },
              ]}
              disabled={disabled || settings?.liquidGlass === undefined}
              onChange={(value) => void act({ type: "setLiquidGlass", value })}
            />
          </Row>
          <Row label="Color filter">
            <ChoiceSelect
              label="Color filter"
              value={settings?.colorFilter}
              options={COLOR_FILTERS}
              disabled={disabled || settings?.colorFilter === undefined}
              onChange={(value) => void act({ type: "setColorFilter", value })}
            />
          </Row>
          {TOGGLES.map((toggle) => {
            const checked = settings?.[toggle.setting];
            return (
              <Row key={toggle.setting} label={toggle.label}>
                <Switch
                  aria-label={toggle.label}
                  checked={checked ?? false}
                  disabled={disabled || checked === undefined}
                  onCheckedChange={(value) => void act({ type: "setToggle", setting: toggle.setting, value })}
                />
              </Row>
            );
          })}
        </ToolsSection>

        <LocationSection
          disabled={disabled}
          onSet={(latitude, longitude) => act({ type: "setLocation", latitude, longitude })}
          onClear={() => act({ type: "clearLocation" })}
        />

        <PermissionsSection
          defaultAppId={foregroundApp?.id ?? ""}
          disabled={disabled}
          onDecide={(appId, permission, decision) => act({ type: "setPermission", appId, permission, decision })}
        />

        <ToolsSection title="Push notification">
          <SubmitRow
            label="Notification text"
            placeholder="Alert text"
            action="Send"
            disabled={disabled || !foregroundApp}
            onSubmit={(payload) =>
              foregroundApp ? act({ type: "sendPush", appId: foregroundApp.id, payload }) : Promise.resolve(false)
            }
          />
          {!foregroundApp ? (
            <Text variant="small" color="secondary">
              Open an app first. The notification goes to the frontmost app.
            </Text>
          ) : null}
        </ToolsSection>
      </div>
    </section>
  );
}

function ToolsSection({ title, children }: React.PropsWithChildren<{ title: string }>) {
  const id = React.useId();
  return (
    <section className="device-tools-section" aria-labelledby={id}>
      <h3 id={id} className="device-tools-section-title">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="device-tools-row">
      <Text variant="small" color="secondary" className="shrink-0">
        {label}
      </Text>
      <div className="device-tools-row-control">{children}</div>
    </div>
  );
}

function Segmented<V extends string>(props: {
  label: string;
  value: V | undefined;
  options: ReadonlyArray<{ value: V; label: string }>;
  disabled: boolean;
  onChange(value: V): void;
}) {
  return (
    <div role="group" aria-label={props.label} className="device-tools-segmented">
      {props.options.map((option) => (
        <Button
          key={option.value}
          size="small"
          variant={props.value === option.value ? "muted" : "transparent"}
          aria-pressed={props.value === option.value}
          disabled={props.disabled}
          onClick={() => {
            if (props.value !== option.value) props.onChange(option.value);
          }}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function ChoiceSelect<V extends string>(props: {
  label: string;
  value: V | undefined;
  options: ReadonlyArray<{ value: V; label: string }>;
  disabled: boolean;
  placeholder?: string;
  onChange(value: V): void;
}) {
  return (
    <Select
      value={props.value ?? ""}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value && value !== props.value) props.onChange(value as V);
      }}
    >
      <SelectTrigger size="small" className="device-tools-select" aria-label={props.label}>
        <SelectValue placeholder={props.placeholder ?? "Unknown"} />
      </SelectTrigger>
      <SelectContent align="end">
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SubmitRow(props: {
  label: string;
  placeholder: string;
  action: string;
  disabled: boolean;
  onSubmit(value: string): Promise<boolean>;
}) {
  const [value, setValue] = React.useState("");
  return (
    <form
      className="device-tools-actions"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) return;
        void props.onSubmit(trimmed).then((ok) => {
          if (ok) setValue("");
        });
      }}
    >
      <Input
        aria-label={props.label}
        className="device-tools-input"
        placeholder={props.placeholder}
        value={value}
        disabled={props.disabled}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(event) => setValue(event.target.value)}
      />
      <Button type="submit" size="small" variant="muted" disabled={props.disabled || value.trim().length === 0}>
        {props.action}
      </Button>
    </form>
  );
}

export function parseCoordinates(latitude: string, longitude: string): { latitude: number; longitude: number } | null {
  if (latitude.trim() === "" || longitude.trim() === "") return null;
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!Number.isFinite(parsed.latitude) || !Number.isFinite(parsed.longitude)) return null;
  if (Math.abs(parsed.latitude) > 90 || Math.abs(parsed.longitude) > 180) return null;
  return parsed;
}

function LocationSection(props: {
  disabled: boolean;
  onSet(latitude: number, longitude: number): Promise<boolean>;
  onClear(): Promise<boolean>;
}) {
  const [latitude, setLatitude] = React.useState("");
  const [longitude, setLongitude] = React.useState("");
  const coordinates = parseCoordinates(latitude, longitude);
  return (
    <ToolsSection title="Location">
      <div className="device-tools-actions">
        <Input
          aria-label="Latitude"
          className="device-tools-input"
          placeholder="Latitude"
          inputMode="decimal"
          value={latitude}
          disabled={props.disabled}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <Input
          aria-label="Longitude"
          className="device-tools-input"
          placeholder="Longitude"
          inputMode="decimal"
          value={longitude}
          disabled={props.disabled}
          onChange={(event) => setLongitude(event.target.value)}
        />
      </div>
      <div className="device-tools-actions">
        <Select
          value=""
          disabled={props.disabled}
          onValueChange={(label) => {
            const preset = DEVICE_LOCATION_PRESETS.find((candidate) => candidate.label === label);
            if (!preset) return;
            setLatitude(String(preset.latitude));
            setLongitude(String(preset.longitude));
            void props.onSet(preset.latitude, preset.longitude);
          }}
        >
          <SelectTrigger size="small" className="device-tools-select" aria-label="Location preset">
            <SelectValue placeholder="Preset…" />
          </SelectTrigger>
          <SelectContent align="start">
            {DEVICE_LOCATION_PRESETS.map((preset) => (
              <SelectItem key={preset.label} value={preset.label}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="small"
          variant="muted"
          disabled={props.disabled || !coordinates}
          onClick={() => coordinates && void props.onSet(coordinates.latitude, coordinates.longitude)}
        >
          Set
        </Button>
        <Button
          size="small"
          variant="transparent"
          disabled={props.disabled}
          onClick={() => {
            setLatitude("");
            setLongitude("");
            void props.onClear();
          }}
        >
          Clear
        </Button>
      </div>
    </ToolsSection>
  );
}

function PermissionsSection(props: {
  defaultAppId: string;
  disabled: boolean;
  onDecide(appId: string, permission: DevicePermission, decision: DevicePermissionDecision): Promise<boolean>;
}) {
  const [appId, setAppId] = React.useState("");
  const [permission, setPermission] = React.useState<DevicePermission>("camera");
  const resolvedAppId = appId.trim() || props.defaultAppId;
  const decide = (decision: DevicePermissionDecision) => void props.onDecide(resolvedAppId, permission, decision);
  const unavailable = props.disabled || !resolvedAppId;
  return (
    <ToolsSection title="Permissions">
      <Input
        aria-label="Bundle ID for permissions"
        className="device-tools-input"
        placeholder={props.defaultAppId || "Bundle ID"}
        value={appId}
        disabled={props.disabled}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(event) => setAppId(event.target.value)}
      />
      <div className="device-tools-actions">
        <ChoiceSelect<DevicePermission>
          label="Permission"
          value={permission}
          options={PERMISSIONS}
          disabled={props.disabled}
          onChange={(value) => setPermission(value)}
        />
        <Button size="small" variant="muted" disabled={unavailable} onClick={() => decide("grant")}>
          Grant
        </Button>
        <Button size="small" variant="muted" disabled={unavailable} onClick={() => decide("revoke")}>
          Revoke
        </Button>
        <Button size="small" variant="transparent" disabled={unavailable} onClick={() => decide("reset")}>
          Reset
        </Button>
      </div>
    </ToolsSection>
  );
}
