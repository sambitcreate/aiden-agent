import * as React from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cloud,
  Coins,
  HardDrive,
  Loader2,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, Text } from "../components/ui";
import { ProviderIcon } from "../components/provider-icon";
import type {
  CreateImagesExecutionMode,
  CreateImagesProviderStatus,
} from "../shared/create-images/providers";
import { createImagesProviderStatusViewModel } from "./provider-connection-core";

const TONE_BADGE: Readonly<
  Record<ReturnType<typeof createImagesProviderStatusViewModel>["tone"], string>
> = {
  neutral: "",
  progress: "blue",
  success: "green",
  danger: "red",
  warning: "",
};

const STATUS_ICON = {
  disconnected: AlertTriangle,
  connecting: Loader2,
  connected: Check,
  invalid: AlertTriangle,
  unavailable: AlertTriangle,
} satisfies Record<
  CreateImagesProviderStatus["connectionState"],
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>
>;

function ExecutionChoice({
  checked,
  disabled,
  description,
  icon: Icon,
  label,
  onSelect,
}: {
  checked: boolean;
  disabled?: boolean;
  description: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className="create-images-provider-choice"
      onClick={onSelect}
    >
      <span className="create-images-provider-choice-icon" aria-hidden="true">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-small-strong font-medium text-primary">{label}</span>
        <span className="mt-0.5 block text-mini leading-relaxed text-tertiary">{description}</span>
      </span>
      <span className="create-images-provider-choice-check" aria-hidden="true">
        {checked ? <Check className="size-3.5" /> : null}
      </span>
    </button>
  );
}

export function CreateImagesProviderConnectionContent({
  status,
  executionMode,
  onExecutionModeChange,
  onOpenProviderSettings,
}: {
  status: CreateImagesProviderStatus;
  executionMode: CreateImagesExecutionMode;
  onExecutionModeChange?(mode: CreateImagesExecutionMode): void;
  onOpenProviderSettings(): void;
}) {
  const view = createImagesProviderStatusViewModel(status);
  const StatusIcon = STATUS_ICON[status.connectionState];
  const geminiSelectable = view.canUseGemini && Boolean(onExecutionModeChange);
  return (
    <div className="create-images-provider-content" data-provider-state={status.connectionState}>
      <div className="flex items-start gap-3">
        <div className="create-images-provider-mark" aria-hidden="true">
          <ProviderIcon providerId="gemini" providerLabel="Google Gemini" className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Text variant="strong">Google Gemini</Text>
            <Badge color={TONE_BADGE[view.tone]} className="gap-1.5">
              <StatusIcon
                className={`size-3.5 ${status.connectionState === "connecting" ? "create-images-provider-spinner" : ""}`}
                aria-hidden="true"
              />
              {view.label}
            </Badge>
          </div>
          <Text variant="small" color="secondary" className="mt-1 block leading-relaxed">
            {view.title}. {view.detail}
          </Text>
        </div>
      </div>

      <div className="my-3 h-px bg-separator" />

      <fieldset>
        <legend className="mb-2 text-mini font-medium text-tertiary">Execution provider</legend>
        <div className="grid gap-1.5" role="radiogroup" aria-label="Image execution provider">
          <ExecutionChoice
            checked={executionMode === "local-mock"}
            description="Private, deterministic, $0, and fully on this Mac. It remains available when cloud setup is incomplete."
            icon={HardDrive}
            label="Aiden local mock"
            onSelect={() => onExecutionModeChange?.("local-mock")}
          />
          <ExecutionChoice
            checked={executionMode === "gemini"}
            disabled={!geminiSelectable}
            description={
              view.canUseGemini
                ? "Uses the verified curated catalog. Every paid plan still requires a separate confirmation."
                : "Available only after API-key compatibility and current image capabilities are verified."
            }
            icon={Cloud}
            label="Google Gemini"
            onSelect={() => onExecutionModeChange?.("gemini")}
          />
        </div>
      </fieldset>

      <Button
        className="mt-3 w-full justify-center"
        size="small"
        variant="filled"
        onClick={onOpenProviderSettings}
      >
        {view.manageActionLabel}
      </Button>

      <div
        className="create-images-provider-disclosure"
        aria-labelledby="provider-disclosure-title"
      >
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-secondary" aria-hidden="true" />
          <h3 id="provider-disclosure-title" className="text-small-strong font-medium">
            Before a cloud run
          </h3>
        </div>
        <ul className="mt-2 grid gap-2 text-mini leading-relaxed text-secondary">
          <li>
            <Cloud aria-hidden="true" />
            Prompts and selected reference images leave this Mac. Google's terms and retention
            policy apply, and you must have rights or consent to upload the material.
          </li>
          <li>
            <Sparkles aria-hidden="true" />
            Google applies SynthID to generated images. Aiden stores validated outputs locally.
          </li>
          <li>
            <Coins aria-hidden="true" />
            Each confirmed generation node may create a billed request. Cost estimates are
            best-effort and may be unavailable or change before billing.
          </li>
          <li>
            <RefreshCcw aria-hidden="true" />
            Cancellation is advisory and may not prevent completion or billing. Aiden never
            automatically retries a paid request; another attempt needs explicit review.
          </li>
        </ul>
      </div>
    </div>
  );
}

export function CreateImagesProviderConnectionControl({
  status,
  executionMode,
  onExecutionModeChange,
  onOpenProviderSettings,
}: {
  status: CreateImagesProviderStatus;
  executionMode: CreateImagesExecutionMode;
  onExecutionModeChange?(mode: CreateImagesExecutionMode): void;
  onOpenProviderSettings(): void;
}) {
  const [open, setOpen] = React.useState(false);
  const view = createImagesProviderStatusViewModel(status);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="small"
          variant="filled"
          className="create-images-provider-trigger no-drag"
          aria-label={`Image provider: ${executionMode === "local-mock" ? "Aiden local mock" : "Google Gemini"}. Gemini ${view.label.toLocaleLowerCase()}.`}
        >
          {executionMode === "local-mock" ? (
            <HardDrive className="size-4" aria-hidden="true" />
          ) : (
            <ProviderIcon providerId="gemini" providerLabel="Google Gemini" className="size-4" />
          )}
          <span className="create-images-provider-trigger-label">
            {executionMode === "local-mock" ? "Local mock" : "Gemini"}
          </span>
          <span
            className="create-images-provider-trigger-state"
            data-state={status.connectionState}
          >
            {executionMode === "local-mock" ? `$0 · ${view.label}` : view.label}
          </span>
          <ChevronDown className="size-3.5 text-tertiary" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="create-images-provider-popover w-[min(24rem,calc(100vw-1.5rem))] p-3"
        aria-label="Image provider connection and privacy"
      >
        <CreateImagesProviderConnectionContent
          status={status}
          executionMode={executionMode}
          onExecutionModeChange={onExecutionModeChange}
          onOpenProviderSettings={() => {
            setOpen(false);
            onOpenProviderSettings();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
