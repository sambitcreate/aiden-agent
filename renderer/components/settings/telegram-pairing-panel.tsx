import { Button, Field, Input, Text, toast } from "../ui";

export function TelegramPairingPanel(props: {
  pending?: { code: string; expiresAt: number };
  busy: boolean;
  disabled: boolean;
  onBegin(): void;
  onCancel(): void;
}) {
  return <Field label="Pair your account" description="Start pairing here, then send the one-time command to your bot from your own Telegram account. It expires after five minutes. Keep it private.">
    <div className="flex flex-col gap-3">
      {props.pending ? <>
        <Input aria-label="Telegram pairing command" readOnly value={`/start ${props.pending.code}`} />
        <Text as="p" variant="small" color="secondary">Send this command before {new Date(props.pending.expiresAt).toLocaleTimeString()}. Your next message can start a task.</Text>
        <div className="flex flex-wrap gap-2">
          <Button size="small" variant="filled" onClick={() => { void navigator.clipboard.writeText(`/start ${props.pending!.code}`).catch(() => toast.error("Could not copy. Select the command and copy it manually.")); }}>Copy command</Button>
          <Button size="small" variant="muted" onClick={props.onCancel}>Cancel pairing</Button>
        </div>
      </> : <Button size="small" variant="filled" onClick={props.onBegin} disabled={props.disabled || props.busy}>{props.busy ? "Starting pairing…" : "Start pairing"}</Button>}
    </div>
  </Field>;
}
