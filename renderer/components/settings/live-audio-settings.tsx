import * as React from "react";
import { playLiveConnectionCue } from "../../lib/dictation-sounds";
import { readLiveAudioDevices, saveLiveAudioDevices, type LiveAudioDevices } from "../../lib/live-audio-devices";
import { Button, Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text } from "../ui";

// Extend the existing quiet settings rows; routing is local to Live and session-scoped.
export function LiveAudioDeviceFields({ value, devices, onChange, outputSupported = true }: {
  value: LiveAudioDevices;
  devices: MediaDeviceInfo[];
  onChange: (next: LiveAudioDevices) => void;
  outputSupported?: boolean;
}): React.ReactElement {
  return <>{(["input", "output"] as const).map((direction) => {
    const available = devices.filter((device) => device.kind === `audio${direction}` && device.deviceId && !["default", "communications"].includes(device.deviceId));
    const missing = value[direction] !== "default" && !available.some((device) => device.deviceId === value[direction]);
    const selectedIndex = available.findIndex((device) => device.deviceId === value[direction]);
    const selectedLabel = value[direction] === "default" ? "System default" : missing ? "Selected device unavailable" : available[selectedIndex].label || `${direction === "input" ? "Microphone" : "Speaker"} ${selectedIndex + 1}`;
    return <Field key={direction} label={direction === "input" ? "Input device" : "Output device"}
      description={direction === "input" ? "Microphone used for your voice." : "Speaker used for replies and start/stop sounds."}>
      <Select value={value[direction]} onValueChange={(id) => onChange({ ...value, [direction]: id })}>
        <SelectTrigger size="small" className="live-audio-device-select w-56 max-w-full" title={selectedLabel} aria-label={direction === "input" ? "Live input device" : "Live output device"}><SelectValue>{selectedLabel}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">System default</SelectItem>
          {missing && <SelectItem value={value[direction]} disabled>Selected device unavailable</SelectItem>}
          {available.map((device, index) => <SelectItem key={device.deviceId} value={device.deviceId} disabled={direction === "output" && !outputSupported}>
            {device.label || `${direction === "input" ? "Microphone" : "Speaker"} ${index + 1}`}
          </SelectItem>)}
        </SelectContent>
      </Select>
    </Field>;
  })}</>;
}

export function LiveAudioSettings(): React.ReactElement {
  const [value, setValue] = React.useState(readLiveAudioDevices);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const mounted = React.useRef(false);
  const refreshGeneration = React.useRef(0);
  const outputSupported = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
  const refresh = React.useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const next = await navigator.mediaDevices.enumerateDevices();
      if (mounted.current && generation === refreshGeneration.current) {
        setDevices(next);
        setError(null);
      }
    } catch {
      if (mounted.current && generation === refreshGeneration.current) setError("Could not list audio devices. Check microphone permission, then refresh.");
    }
  }, []);
  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, [refresh]);
  const change = (next: LiveAudioDevices) => {
    try {
      saveLiveAudioDevices(next);
      setValue(next);
      setError(null);
    } catch {
      setError("Could not save the audio device selection. Try again.");
    }
  };
  const testOutput = async () => {
    setTesting(true);
    setError(null);
    try {
      await playLiveConnectionCue("connected", value.output);
    } catch {
      if (mounted.current) setError("Could not play the test sound. Reconnect your speaker or choose System default.");
    } finally {
      if (mounted.current) setTesting(false);
    }
  };
  return <FieldSet title="Audio devices">
    <LiveAudioDeviceFields value={value} devices={devices} onChange={change} outputSupported={outputSupported} />
    <Field label="Check audio" description="Saved on this Mac. Changes apply the next time you start Live. Allow microphone access to see available device names.">
      <div className="flex flex-wrap gap-2">
        <Button size="small" variant="filled" onClick={() => void refresh()}>Refresh devices</Button>
        <Button size="small" variant="filled" disabled={testing} onClick={() => void testOutput()}>{testing ? "Playing…" : "Test speaker"}</Button>
      </div>
    </Field>
    {!outputSupported && <Text as="p" variant="small" color="secondary">This runtime supports system-default output only.</Text>}
    {error && <p role="alert" className="text-sm text-support-red">{error}</p>}
  </FieldSet>;
}
