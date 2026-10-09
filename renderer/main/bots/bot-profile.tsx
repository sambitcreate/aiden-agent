import * as React from "react";
import { Camera, ChevronRight, Ellipsis, MessageCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BotAvatar } from "../../components/bot-avatar";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldSet,
  Input,
  Text,
  toast,
} from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { invalidateBotCanonicalPhotos } from "../../lib/bot-canonical-photo-cache";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { BOT_LIMITS, type BotDefinition } from "../../shared/bots";
import type { BotMemoryView } from "../../shared/bot-memory";
import { BotCharacterCard } from "./bot-character-card";
import { updateBotIdentity, type BotIdentityPatch } from "./bot-identity";
import { BotPageShell } from "./bot-page-shell";
import { BotRoutines } from "./bot-routines";
import { botMemoryCount, botMemoryCountLabel, useBotMemory } from "./use-bot-memory";

/** The file's bytes as base64 (no data: prefix). */
function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The photo could not be read."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma === -1 ? "" : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Saves an inline field when it loses focus or on Return, if it changed. */
function InlineField({
  label,
  value,
  maxLength,
  placeholder,
  required = false,
  onSave,
}: {
  label: string;
  value: string;
  maxLength: number;
  placeholder: string;
  required?: boolean;
  onSave(next: string): Promise<void>;
}) {
  const [draft, setDraft] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  // Escape blurs to leave the field; the blur must not save the abandoned edit.
  const discarding = React.useRef(false);
  React.useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    if (discarding.current) {
      discarding.current = false;
      setDraft(value);
      return;
    }
    const next = draft.trim();
    if (next === value.trim() || (required && !next)) {
      setDraft(value);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      setDraft(value);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Input
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={saving}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          discarding.current = true;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

const PROFILE_ROW_CLASS =
  "settings-field relative flex w-full min-w-0 items-center gap-3 p-4 text-left outline-none transition-colors duration-150 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none";

function memorySummary(view: BotMemoryView | undefined): string | null {
  if (!view) return null;
  if (!view.readable) return "Couldn’t be read";
  const count = botMemoryCount(view);
  return count === 0 ? "Nothing yet" : botMemoryCountLabel(count);
}

/** "Memory" with the SD-card icon and a quiet count; opens Profile → Memory. */
function MemoryRow({ botId, onOpen }: { botId: string; onOpen(): void }) {
  const memory = useBotMemory(botId);
  const countId = React.useId();
  const summary = memorySummary(memory.data);
  return (
    <button
      type="button"
      aria-label="Memory"
      aria-describedby={summary ? countId : undefined}
      className={PROFILE_ROW_CLASS}
      onClick={onOpen}
    >
      <MemoryCardIcon aria-hidden="true" className="size-4 shrink-0 text-secondary" />
      <span className="min-w-0 flex-1 text-strong text-primary">Memory</span>
      {summary ? (
        <span id={countId} className="shrink-0 text-small text-secondary">
          {summary}
        </span>
      ) : null}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
    </button>
  );
}

/** The first line of the instructions, as a one-line preview. */
function instructionsPreview(instructions: string): string {
  return instructions.trim().split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
}

/**
 * A Bot's Profile: its photo, name, subtitle, instructions, look, and
 * routines. Every field saves on its own as it changes. Advanced and Delete Bot
 * live behind •••.
 */
export function BotProfile({
  bot,
  onBack,
  onOpenChat,
  onOpenInstructions,
  onOpenAdvanced,
  onOpenMemory,
  onDelete,
}: {
  bot: BotDefinition;
  onBack(): void;
  onOpenChat(): void;
  onOpenInstructions(): void;
  onOpenAdvanced(): void;
  onOpenMemory(): void;
  onDelete(): void;
}) {
  const qc = useQueryClient();
  const photoInput = React.useRef<HTMLInputElement | null>(null);
  const previewId = React.useId();
  const [photoBusy, setPhotoBusy] = React.useState(false);
  const choosePhoto = async (file: File) => {
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      toast.error("Choose a PNG or JPEG photo.");
      return;
    }
    setPhotoBusy(true);
    try {
      const data = await readFileAsBase64(file);
      await botsApi.setPhoto(bot.id, { mimeType: file.type, data });
      invalidateBotCanonicalPhotos();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t change ${bot.name}’s photo.`));
    } finally {
      setPhotoBusy(false);
    }
  };
  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      await botsApi.removePhoto(bot.id);
      invalidateBotCanonicalPhotos();
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t remove ${bot.name}’s photo.`));
    } finally {
      setPhotoBusy(false);
    }
  };
  const save = async (patch: BotIdentityPatch) => {
    try {
      await updateBotIdentity(qc, bot.id, patch);
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t update ${bot.name}.`));
      throw error;
    }
  };
  const preview = instructionsPreview(bot.instructions);
  return (
    <BotPageShell
      scrollId={`bot-profile:${bot.id}`}
      title={bot.name}
      backLabel="All Bots"
      onBack={onBack}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button iconOnly variant="toolbar" size="large" aria-label={`More for ${bot.name}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpenAdvanced}>Advanced</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem color="status-red" onSelect={onDelete}>
              Delete Bot
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <div className="mb-8 flex flex-col items-center gap-4 pt-2">
        <div className="relative">
          <BotAvatar botId={bot.id} avatar={bot.avatar} name={bot.name} photoLoading="immediate" size="preview" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                iconOnly
                variant="filled"
                size="small"
                aria-label={`Photo options for ${bot.name}`}
                className="absolute -bottom-1 -right-1"
                disabled={photoBusy}
              >
                <Camera />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              <DropdownMenuItem onSelect={() => photoInput.current?.click()}>Choose photo</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void removePhoto()}>Remove photo</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={photoInput}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void choosePhoto(file);
            }}
          />
        </div>
        <Button variant="accent" size="large" onClick={onOpenChat}>
          <MessageCircle /> Chat with {bot.name}
        </Button>
      </div>
      <FieldSet title="About">
        <Field label="Name">
          <InlineField
            label="Name"
            value={bot.name}
            required
            maxLength={BOT_LIMITS.nameChars}
            placeholder="Name"
            onSave={(name) => save({ name })}
          />
        </Field>
        <Field label="Subtitle" description="A few words under its name.">
          <InlineField
            label="Subtitle"
            value={bot.description ?? ""}
            maxLength={BOT_LIMITS.descriptionChars}
            placeholder="What it helps with"
            onSave={(description) => save({ description })}
          />
        </Field>
        <button
          type="button"
          aria-label="Instructions"
          aria-describedby={preview ? previewId : undefined}
          className={PROFILE_ROW_CLASS}
          onClick={onOpenInstructions}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-strong text-primary">Instructions</span>
            {preview ? (
              <span id={previewId} className="mt-0.5 block truncate text-small text-secondary">
                {preview}
              </span>
            ) : null}
          </span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
        </button>
        <MemoryRow botId={bot.id} onOpen={onOpenMemory} />
      </FieldSet>
      <BotCharacterCard avatar={bot.avatar} onChange={(avatar) => void save({ avatar }).catch(() => undefined)} />
      <BotRoutines bot={bot} />
      <Text as="p" variant="small" color="tertiary" className="px-1 text-center">
        Changes save as you make them and apply from the next message.
      </Text>
    </BotPageShell>
  );
}
