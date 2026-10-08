/**
 * Adapted from t3code apps/web/src/components/device/DeviceToolsPanel.tsx @ 1c127066 (MIT)
 *
 * The Device tools drawer for one open iOS simulator or Android emulator: the
 * settings the device reports, one control per typed action the platform
 * supports, and the frontmost app. Callers mount the power-feature sections
 * (accessibility overlay, event log, clipboard, erase) as children, and host
 * diagnostics close the drawer.
 */
import * as React from "react";
import { X } from "lucide-react";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Text } from "./ui";
import type { DeviceControls } from "../lib/device-controls";
import { DeviceHostDiagnostics } from "./device-host-diagnostics";
import {
  ANDROID_DEVICE_PERMISSIONS,
  DEVICE_PLATFORM_TOGGLES,
  type DeviceColorFilter,
  type DeviceOrientationValue,
  type DevicePermission,
  type DevicePermissionDecision,
  type DevicePlatform,
  type DeviceTextSize,
  type DeviceToggle,
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

const TOGGLE_LABELS: Record<DeviceToggle, string> = {
  reduceMotion: "Reduce Motion",
  increaseContrast: "Increase Contrast",
  reduceTransparency: "Reduce Transparency",
  showBorders: "Show Borders",
  voiceOver: "VoiceOver",
  networkEnabled: "Network (Wi-Fi and data)",
};

export const DEVICE_ORIENTATION_OPTIONS: ReadonlyArray<{ value: DeviceOrientationValue; label: string }> = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape_left", label: "Landscape" },
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

export function DeviceToolsPanel({
  controls,
  onClose,
  children,
  platform = "ios",
}: React.PropsWithChildren<{
  controls: DeviceControls;
  onClose(): void;
  /** Hides what the platform cannot do. Defaults to iOS. */
  platform?: DevicePlatform;
}>) {
  const { settings, pending, error, foregroundApp, disabled, act } = controls;
  const android = platform === "android";
  const appIdLabel = android ? "Package name" : "Bundle ID";
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
            {android ? "Reading emulator settings…" : "Reading simulator settings…"}
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
            label={`${appIdLabel} to launch`}
            placeholder={`${appIdLabel} to launch`}
            action="Launch"
            disabled={disabled}
            onSubmit={(appId) => act({ type: "launchApp", appId })}
          />
        </ToolsSection>

        <ToolsSection title={android ? "Emulator" : "Simulator"}>
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
          {android ? (
            <Row label="Orientation">
              <Segmented
                label="Orientation"
                value={undefined}
                options={DEVICE_ORIENTATION_OPTIONS}
                disabled={disabled}
                onChange={(value) => void act({ type: "setOrientation", value })}
              />
            </Row>
          ) : (
            <>
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
            </>
          )}
          {DEVICE_PLATFORM_TOGGLES[platform].map((setting) => {
            const checked = settings?.[setting];
            const label = TOGGLE_LABELS[setting];
            return (
              <Row key={setting} label={label}>
                <Switch
                  aria-label={label}
                  checked={checked ?? false}
                  disabled={disabled || checked === undefined}
                  onCheckedChange={(value) => void act({ type: "setToggle", setting, value })}
                />
              </Row>
            );
          })}
        </ToolsSection>

        <LocationSection
          disabled={disabled}
          // The emulator keeps its last fix; there is nothing to clear.
          clearable={!android}
          onSet={(latitude, longitude) => act({ type: "setLocation", latitude, longitude })}
          onClear={() => act({ type: "clearLocation" })}
        />

        <PermissionsSection
          defaultAppId={foregroundApp?.id ?? ""}
          appIdLabel={appIdLabel}
          permissions={android ? PERMISSIONS.filter((option) => isAndroidPermission(option.value)) : PERMISSIONS}
          // Android has no reset; a revoke returns a runtime permission to "ask".
          decisions={android ? ["grant", "revoke"] : ["grant", "revoke", "reset"]}
          disabled={disabled}
          onDecide={(appId, permission, decision) => act({ type: "setPermission", appId, permission, decision })}
        />

        {android ? null : (
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
        )}
        {children}
        <DeviceHostDiagnostics />
      </div>
    </section>
  );
}

export function ToolsSection({ title, children }: React.PropsWithChildren<{ title: string }>) {
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

export function Row({ label, children }: React.PropsWithChildren<{ label: string }>) {
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

const DECISION_LABELS: Record<DevicePermissionDecision, string> = { grant: "Grant", revoke: "Revoke", reset: "Reset" };

export function parseCoordinates(latitude: string, longitude: string): { latitude: number; longitude: number } | null {
  if (latitude.trim() === "" || longitude.trim() === "") return null;
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!Number.isFinite(parsed.latitude) || !Number.isFinite(parsed.longitude)) return null;
  if (Math.abs(parsed.latitude) > 90 || Math.abs(parsed.longitude) > 180) return null;
  return parsed;
}

const isAndroidPermission = (permission: DevicePermission) =>
  (ANDROID_DEVICE_PERMISSIONS as readonly DevicePermission[]).includes(permission);

function LocationSection(props: {
  disabled: boolean;
  clearable: boolean;
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
        {props.clearable ? (
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
        ) : null}
      </div>
    </ToolsSection>
  );
}

function PermissionsSection(props: {
  defaultAppId: string;
  appIdLabel: string;
  permissions: ReadonlyArray<{ value: DevicePermission; label: string }>;
  decisions: readonly DevicePermissionDecision[];
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
        aria-label={`${props.appIdLabel} for permissions`}
        className="device-tools-input"
        placeholder={props.defaultAppId || props.appIdLabel}
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
          options={props.permissions}
          disabled={props.disabled}
          onChange={(value) => setPermission(value)}
        />
        {props.decisions.map((decision) => (
          <Button
            key={decision}
            size="small"
            variant={decision === "reset" ? "transparent" : "muted"}
            disabled={unavailable}
            onClick={() => decide(decision)}
          >
            {DECISION_LABELS[decision]}
          </Button>
        ))}
      </div>
    </ToolsSection>
  );
}
