import { Brain, KeyRound, Mic2, ShieldCheck } from "lucide-react";

import { Button, Dialog, Text, type DialogLayer } from "../ui";
import type { GeminiUsageScope } from "../../lib/types";
import { useAppCapabilities } from "../../lib/app-capabilities";

interface GeminiVoiceSetupDialogProps {
  open: boolean;
  scope: GeminiUsageScope;
  hasKey: boolean;
  activatesVoice?: boolean;
  busy?: boolean;
  error?: string | null;
  layer?: DialogLayer;
  onScopeChange: (scope: GeminiUsageScope) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  onManageCredential?: () => void;
}

const choices: Array<{
  scope: GeminiUsageScope;
  title: string;
  description: string;
  recommended?: boolean;
  icon: typeof Mic2;
}> = [
  {
    scope: "transcription_only",
    title: "Transcription only",
    description:
      "Use Gemini for Voice and Dictation. Google models stay out of new model pickers; existing chats keep their pinned model.",
    recommended: true,
    icon: Mic2,
  },
  {
    scope: "models_and_transcription",
    title: "Models + transcription",
    description: "Use Gemini for voice and add Google chat models throughout Aiden.",
    icon: Brain,
  },
];

export function GeminiVoiceSetupDialog({
  open,
  scope,
  hasKey,
  activatesVoice = true,
  busy = false,
  error,
  layer,
  onScopeChange,
  onOpenChange,
  onConfirm,
  onManageCredential,
}: GeminiVoiceSetupDialogProps) {
  const capabilities = useAppCapabilities();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      layer={layer}
      title={activatesVoice ? "Use Google Gemini for voice?" : "Set up Google Gemini access?"}
      description="Choose exactly where Gemini appears, then review what leaves this device. You can change this later."
      confirmLabel={
        hasKey ? (activatesVoice ? "Use Gemini" : "Save Gemini access") : "Continue to API key"
      }
      dismissDisabled={busy}
      busy={busy}
      onConfirm={onConfirm}
    >
      <div className="grid gap-4">
        <div className="grid gap-2" role="radiogroup" aria-label="Gemini access">
          {choices.map((choice) => {
            const selected = choice.scope === scope;
            const Icon = choice.icon;
            return (
              <label
                key={choice.scope}
                className={`relative flex min-h-16 cursor-default items-start gap-3 rounded-card border px-3 py-3 text-left outline-none transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/30 ${
                  selected
                    ? "border-accent/35 bg-list-selection"
                    : "border-separator bg-well hover:bg-control"
                } ${busy ? "opacity-50" : ""}`}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name="gemini-usage-scope"
                  value={choice.scope}
                  checked={selected}
                  disabled={busy}
                  onChange={() => onScopeChange(choice.scope)}
                />
                <span className="grid size-8 shrink-0 place-items-center rounded-control bg-popover text-secondary shadow-control">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Text as="span" variant="small-strong">
                      {choice.title}
                    </Text>
                    {choice.recommended ? (
                      <span className="rounded-full bg-control px-2 py-0.5 text-[10px] font-medium text-secondary">
                        Recommended
                      </span>
                    ) : null}
                  </span>
                  <Text
                    as="span"
                    variant="small"
                    color="secondary"
                    className="mt-1 block leading-relaxed"
                  >
                    {!activatesVoice
                      ? choice.scope === "transcription_only"
                        ? "Allow Gemini transcription without changing your current Voice provider. Google models stay out of new model pickers."
                        : "Allow Gemini transcription and add Google chat models without changing your current Voice provider."
                      : choice.description}
                  </Text>
                </span>
              </label>
            );
          })}
        </div>

        <section className="rounded-card bg-well p-3" aria-labelledby="gemini-privacy-title">
          <Text id="gemini-privacy-title" as="h3" variant="small-strong">
            Privacy & device access
          </Text>
          <ul className="mt-2 grid gap-2 text-small text-secondary">
            <li className="flex items-start gap-2">
              <Mic2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <strong className="font-medium text-primary">Cloud audio.</strong> Aiden streams
                your recording to Google. If Live transcription fails, Aiden uploads the saved
                recording only after you approve a retry that may incur another Gemini charge.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <strong className="font-medium text-primary">API key.</strong> Stored encrypted on
                this device and used for Gemini voice plus any existing chat already pinned to Google.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <strong className="font-medium text-primary">System permissions.</strong> Microphone is
                required to record. {capabilities.accessibilityPaste
                  ? "Accessibility is optional and used only to paste into another app; without it Aiden copies the transcript. Gemini does not need Screen Recording."
                  : "Aiden copies the transcript to the clipboard so you can paste it into another app."}
              </span>
            </li>
          </ul>
        </section>

        <div className="flex items-center justify-between gap-3">
          <Text variant="small" color={hasKey ? "secondary" : "tertiary"} aria-live="polite">
            {hasKey ? "A Google API key is configured." : "A Google API key is required next."}
          </Text>
          {hasKey && onManageCredential ? (
            <Button variant="transparent" size="small" disabled={busy} onClick={onManageCredential}>
              Update API key
            </Button>
          ) : null}
        </div>
        {error ? (
          <Text role="alert" variant="small" color="red">
            {error}
          </Text>
        ) : null}
      </div>
    </Dialog>
  );
}
