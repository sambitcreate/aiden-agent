import * as React from "react";
import { ChevronLeft, ChevronRight, Ellipsis, FileText, MessageCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BotAvatar } from "../../components/bot-avatar";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Text,
  toast,
} from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { invalidateBotCanonicalPhotos } from "../../lib/bot-canonical-photo-cache";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { BOT_LIMITS, type BotDefinition } from "../../shared/bots";
import { BotCharacterCard } from "./bot-character-card";
import { updateBotIdentity, type BotIdentityPatch } from "./bot-identity";
import { BotRoutines } from "./bot-routines";

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
  className,
  onSave,
}: {
  label: string;
  value: string;
  maxLength: number;
  placeholder: string;
  required?: boolean;
  className?: string;
  onSave(next: string): Promise<void>;
}) {
  const [draft, setDraft] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => setDraft(value), [value]);
  const commit = async () => {
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
      className={className}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      disabled={saving}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * A Bot's Profile: its look, name, subtitle, and instructions. Advanced and
 * Delete Bot live behind •••.
 */
export function BotProfile({
  bot,
  onBack,
  onOpenChat,
  onOpenInstructions,
  onOpenAdvanced,
  onDelete,
}: {
  bot: BotDefinition;
  onBack(): void;
  onOpenChat(): void;
  onOpenInstructions(): void;
  onOpenAdvanced(): void;
  onDelete(): void;
}) {
  const qc = useQueryClient();
  const photoInput = React.useRef<HTMLInputElement | null>(null);
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
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <Button iconOnly variant="filled" size="large" aria-label="All Bots" onClick={onBack}>
          <ChevronLeft />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button iconOnly variant="filled" size="large" aria-label={`More for ${bot.name}`}>
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
      </header>
      <div className="grid place-items-center">
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
              <Ellipsis />
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
      </div>
      <div className="rounded-card bg-well p-3">
        <InlineField
          label="Name"
          value={bot.name}
          required
          maxLength={BOT_LIMITS.nameChars}
          placeholder="Name"
          className="text-center text-heading2 font-semibold"
          onSave={(name) => save({ name })}
        />
        <div className="h-2" aria-hidden="true" />
        <InlineField
          label="Subtitle"
          value={bot.description ?? ""}
          maxLength={BOT_LIMITS.descriptionChars}
          placeholder="What it helps with"
          className="text-center"
          onSave={(description) => save({ description })}
        />
      </div>
      <BotCharacterCard avatar={bot.avatar} onChange={(avatar) => void save({ avatar }).catch(() => undefined)} />
      <div className="overflow-hidden rounded-card bg-well">
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
          onClick={onOpenInstructions}
        >
          <FileText aria-hidden="true" className="size-4 text-secondary" />
          <span className="flex-1 text-regular text-primary">Instructions</span>
          <ChevronRight aria-hidden="true" className="size-4 text-tertiary" />
        </button>
      </div>
      <BotRoutines bot={bot} />
      <Button variant="accent" size="large" onClick={onOpenChat}>
        <MessageCircle /> Chat with {bot.name}
      </Button>
      <Text as="p" variant="small" color="tertiary" className="text-center">
        Changes apply from the next message.
      </Text>
    </div>
  );
}
