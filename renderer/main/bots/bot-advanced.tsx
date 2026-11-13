// A Bot's settings, in the side panel's Advanced tab (plan §4.4). The header
// holds the Bot's look (colour, shape and photo, in a popover) and its name,
// read first and edited on click. The groups follow in one order:
// Notifications, Open work, Memory, Model, Computer, Permissions, Replies,
// Instructions, How other Bots see it, Tools, Spending, then Clear.
//
// Switches and actions save at once. The name, the subtitle and the model and
// tool choices batch behind a Save that sticks to the bottom of the tab and
// shows only while something changed. Nothing asks "Discard changes?": an
// unsaved edit is kept for this window, per Bot, and comes back when the tab
// opens again, saying so.

import * as React from "react";
import { ChevronRight, Link2, RotateCcw, Unlink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BotAvatar } from "../../components/bot-avatar";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import {
  Button,
  Callout,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  EmptyState,
  Field,
  FieldSet,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../../components/ui";
import { invalidateBotCanonicalPhotos } from "../../lib/bot-canonical-photo-cache";
import { botsApi, type BotAccessState } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import {
  queryKeys,
  useBotAccess,
  useBotCapabilityCatalog,
  useBotTelegramBinding,
  useBotTelegramTargets,
  useSettings,
} from "../../lib/queries";
import { settingsLocation } from "../../lib/settings-section";
import { rebaseBotEditorAccessDraft } from "../../shared/bot-editor-save";
import {
  BOT_FULL_ACCESS_NOTICE_VERSION,
  nextBotFileScopeIds,
  type BotCapabilityCatalog,
  type BotCapabilityOption,
} from "../../shared/bot-capabilities";
import { botMessagingEnabled } from "../../shared/bot-messages";
import type { BotMemoryView } from "../../shared/bot-memory";
import {
  BOT_INTERRUPTIONS_MAX_DAILY_LIMIT,
  BOT_LIMITS,
  DEFAULT_BOT_AVATAR,
  DEFAULT_BOT_INTERRUPTIONS,
  resolveBotAvatar,
  resolveBotInterruptions,
  type BotDefinition,
  type BotInterruptions,
} from "../../shared/bots";
import {
  accessDraftFromState,
  botAccessDiffers,
  botFullAccessAccepted,
  botToolsOf,
  buildBotAccessUpdate,
  disableBotTool,
  enableBotTool,
  firstAvailableModel,
  type BotAccessDraft,
  type BotTool,
} from "./bot-access-draft";
import { BotLookPicker } from "./bot-character-card";
import { BotComputerSection } from "./bot-computer-section";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotHealthSection } from "./bot-health-section";
import { updateBotIdentity } from "./bot-identity";
import { BotInstructionsDialog } from "./bot-instructions-editor";
import { BotInterruptionsFields, clockLabel } from "./bot-interruptions-page";
import { botMessagingPatch, botMessagingSwitchOn } from "./bot-messaging-fields";
import {
  chooseBotModel,
  chooseBotVisionModel,
  findBotModel,
  recommendedBotModelChoice,
  sameBotModelChoice,
} from "./bot-model-choice";
import { BotModelPicker, botModelCapabilityLabel } from "./bot-model-picker";
import { BotOpenWorkRow } from "./bot-open-work-page";
import { BotPageSkeleton } from "./bot-page-shell";
import { useBotPanelActions, type BotPanelSectionRequest } from "./bot-panel-context";
import { BotPeerManagerDialog } from "./bot-peers";
import { botRoutinesKey } from "./bot-routines";
import { BotSpendingSection } from "./bot-spending-section";
import { botMemoryCount, botMemoryCountLabel, useBotMemory } from "./use-bot-memory";

function ModelSection({
  catalog,
  draft,
  disabled,
  onChange,
  onSetUpModel,
}: {
  catalog: BotCapabilityCatalog;
  draft: BotAccessDraft;
  disabled: boolean;
  onChange(next: BotAccessDraft): void;
  onSetUpModel(): void;
}) {
  const recommended = recommendedBotModelChoice(catalog);
  const usingRecommended = sameBotModelChoice(recommended, draft);
  const primary = findBotModel(catalog, draft.providerId, draft.modelId);
  const visionAvailable = catalog.providers.some(
    (candidate) => candidate.available && candidate.models.some((item) => item.available && item.supportsImages),
  );
  if (!firstAvailableModel(catalog)) {
    return (
      <FieldSet title="Model">
        <Field label="No AI model yet" description="Add one in Settings → Providers so this Bot can reply.">
          <Button size="small" variant="filled" onClick={onSetUpModel}>
            Set up
          </Button>
        </Field>
      </FieldSet>
    );
  }
  return (
    <FieldSet title="Model">
      <Field label="Model" description={primary ? botModelCapabilityLabel(primary.model.supportsImages) : undefined}>
        <BotModelPicker
          catalog={catalog}
          label="AI model"
          providerId={draft.providerId}
          modelId={draft.modelId}
          recommended={recommended.providerId && recommended.modelId
            ? { providerId: recommended.providerId, modelId: recommended.modelId }
            : undefined}
          disabled={disabled}
          onSelect={(providerId, modelId) => onChange({ ...draft, ...chooseBotModel(catalog, draft, providerId, modelId) })}
        />
      </Field>
      {primary && !primary.model.supportsImages ? (
        visionAvailable ? (
          <Field
            label="Model for photos"
            description={`${primary.model.label} reads text only. Photos and screenshots go to this model.`}
          >
            <BotModelPicker
              catalog={catalog}
              label="Model for photos"
              imagesOnly
              providerId={draft.visionProviderId}
              modelId={draft.visionModelId}
              disabled={disabled}
              onSelect={(providerId, modelId) =>
                onChange({ ...draft, ...chooseBotVisionModel(catalog, draft, providerId, modelId) })}
            />
          </Field>
        ) : (
          <Field
            label="Model for photos"
            description={`${primary.model.label} reads text only, and no model that reads images is set up. Add one in Settings → Providers.`}
          />
        )
      ) : null}
      <Field label="Recommended" description="The first model you set up, plus an image model when it reads text only.">
        <Button
          size="small"
          variant="filled"
          disabled={disabled || usingRecommended}
          onClick={() => onChange({ ...draft, ...recommended })}
        >
          <RotateCcw /> Use recommended
        </Button>
      </Field>
    </FieldSet>
  );
}

/** One horizontal row per option, each with its own switch. */
function ToggleFields({
  options,
  selected,
  disabled,
  onToggle,
}: {
  options: readonly BotCapabilityOption[];
  selected: readonly string[];
  disabled: boolean;
  onToggle(id: string, checked: boolean): void;
}) {
  // Hide unusable, unselected entries instead of rows that can never be enabled.
  const visible = options.filter((option) => option.available || selected.includes(option.id));
  if (visible.length === 0) return <Field description="None available yet." />;
  return (
    <>
      {visible.map((option) => {
        const checked = selected.includes(option.id);
        return (
          <Field key={option.id} label={option.label} description={option.description}>
            <Switch
              checked={checked}
              disabled={disabled || (!option.available && !checked)}
              onCheckedChange={(next) => onToggle(option.id, next)}
              aria-label={`Allow ${option.label}`}
            />
          </Field>
        );
      })}
    </>
  );
}

/** Advanced → Tools' picker: one tool this Bot will no longer use. */
function DisableToolDialog({ open, onOpenChange, tools, onPick }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tools: readonly BotTool[];
  onPick(tool: BotTool): void;
}) {
  const groups = new Map<string, BotTool[]>();
  for (const tool of tools) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Disable a tool" description="This Bot won’t use it until you turn it back on." confirmHidden cancelLabel="Cancel">
      <Command label="Tools" className="rounded-card bg-well">
        <CommandInput placeholder="Search tools" aria-label="Search tools" />
        <CommandList className="h-[min(260px,calc(100vh-16rem))]">
          <CommandEmpty>No tool matches.</CommandEmpty>
          {[...groups].map(([group, items]) => (
            <CommandGroup key={group} heading={group}>
              {items.map((tool) => (
                <CommandItem key={`${tool.key}:${tool.id}`} value={`${tool.label} ${tool.group} ${tool.key}:${tool.id}`} onSelect={() => onPick(tool)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{tool.label}</span>
                    {tool.description ? <span className="truncate text-small text-secondary">{tool.description}</span> : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </Dialog>
  );
}

/**
 * Advanced → Tools (plan §3.5): every tool is on until the person disables
 * one. An Everything Bot is Full access; a Bot with a tool off is Custom
 * access with the rest on, so its reach is exactly what it was before this
 * page, and turning a tool off only narrows it.
 */
function AccessSection({
  catalog,
  draft,
  disabled,
  onChange,
}: {
  catalog: BotCapabilityCatalog;
  draft: BotAccessDraft;
  disabled: boolean;
  onChange(next: BotAccessDraft): void;
}) {
  const [picking, setPicking] = React.useState(false);
  const { on, off } = botToolsOf(catalog, draft);
  const full = draft.usesFullAccess;
  return (
    <>
      <FieldSet
        title="Tools"
        action={
          <Button size="small" variant="transparent" disabled={disabled || on.length === 0} onClick={() => setPicking(true)}>
            Disable a tool
          </Button>
        }
      >
        <Field
          description={full
            ? "Everything Aiden can use on this Mac, including apps you connect later. Approvals and rules still apply."
            : "Everything except the tools below. Apps you connect later start off for this Bot."}
        />
        {off.map((tool) => (
          <Field key={`${tool.key}:${tool.id}`} label={tool.label} description={`${tool.group} · Off for this Bot`}>
            <div className="flex justify-end">
              <Button size="small" variant="transparent" disabled={disabled} aria-label={`Turn on ${tool.label}`} onClick={() => onChange(enableBotTool(draft, tool))}>
                Turn on
              </Button>
            </div>
          </Field>
        ))}
        {!full ? (
          <Field label="Use everything" description="Turn every tool back on, including apps you connect later.">
            <div className="flex justify-end">
              <Button size="small" variant="filled" disabled={disabled} onClick={() => onChange({ ...draft, usesFullAccess: true })}>
                Use everything
              </Button>
            </div>
          </Field>
        ) : null}
      </FieldSet>
      {!full ? (
        <FieldSet title="Files">
          <ToggleFields
            options={catalog.fileScopes}
            selected={draft.fileScopeIds}
            disabled={disabled}
            onToggle={(id, checked) => onChange({ ...draft, fileScopeIds: nextBotFileScopeIds(draft.fileScopeIds, catalog.fileScopes, id, checked) })}
          />
        </FieldSet>
      ) : null}
      <DisableToolDialog
        open={picking}
        onOpenChange={setPicking}
        tools={on}
        onPick={(tool) => {
          onChange(disableBotTool(catalog, draft, tool));
          setPicking(false);
        }}
      />
    </>
  );
}

/**
 * Telegram is an account link, not a setting: Connect opens a chooser and
 * Disconnect acts at once, as the provider and connection rows in Settings do.
 */
function TelegramSection({ bot }: { bot: Pick<BotDefinition, "id"> }) {
  const qc = useQueryClient();
  const binding = useBotTelegramBinding(bot.id);
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const targets = useBotTelegramTargets(open);
  const bind = async () => {
    const chosen = targets.data?.[Number(target)];
    if (!chosen) return;
    setSaving(true);
    try {
      const next = await botsApi.bindTelegram({
        botId: bot.id,
        profile: chosen.profile,
        ...(chosen.threadId === undefined ? {} : { threadId: chosen.threadId }),
      });
      qc.setQueryData(queryKeys.botTelegramBinding(bot.id), next);
      setOpen(false);
      toast.success("Telegram connected");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t connect this Telegram chat."));
    } finally {
      setSaving(false);
    }
  };
  const unbind = async () => {
    setSaving(true);
    try {
      await botsApi.unbindTelegram(bot.id);
      qc.setQueryData(queryKeys.botTelegramBinding(bot.id), null);
      toast.success("Telegram disconnected");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t disconnect this Telegram chat."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <FieldSet title="Replies">
      <Field
        label="Telegram chat"
        description={
          binding.isLoading
            ? "Checking…"
            : binding.isError
              ? "Aiden couldn’t check the Telegram connection."
              : binding.data
                ? `Connected to ${binding.data.profile}${binding.data.threadId ? ` · topic ${binding.data.threadId}` : ""}.`
                : "Talk to this Bot from one of your paired Telegram chats."
        }
      >
        {binding.isError ? (
          <Button size="small" variant="filled" onClick={() => void binding.refetch()}>
            <RotateCcw /> Try again
          </Button>
        ) : binding.data ? (
          <Button size="small" variant="filled" disabled={saving} onClick={() => void unbind()}>
            <Unlink /> Disconnect
          </Button>
        ) : (
          <Button
            size="small"
            variant="filled"
            disabled={binding.isLoading}
            onClick={() => {
              setTarget("");
              setOpen(true);
            }}
          >
            <Link2 /> Connect Telegram
          </Button>
        )}
      </Field>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Connect a Telegram chat"
        description="Messages in this chat go to this Bot. A chat can belong to only one Bot."
        confirmLabel="Connect"
        confirmDisabled={!target || targets.isLoading || targets.isError}
        busy={saving}
        onConfirm={bind}
      >
        {targets.isLoading ? (
          <div role="status" aria-label="Loading Telegram chats" className="h-8 w-full rounded-control bg-control motion-safe:animate-pulse" />
        ) : targets.isError ? (
          <Callout color="red" role="alert" className="flex-row items-center justify-between gap-3">
            <Text variant="small" color="red">
              Aiden couldn’t load your Telegram chats.
            </Text>
            <Button size="small" variant="filled" onClick={() => void targets.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </Callout>
        ) : (targets.data?.length ?? 0) === 0 ? (
          <EmptyState
            placement="inline"
            title="No Telegram chats yet"
            description="Set up Telegram in Settings → Connections → Telegram first."
          />
        ) : (
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-full" aria-label="Telegram chat">
              <SelectValue placeholder="Choose a chat" />
            </SelectTrigger>
            <SelectContent>
              {targets.data?.map((candidate, index) => (
                <SelectItem
                  key={`${candidate.profile}:${candidate.threadId ?? "dm"}`}
                  value={String(index)}
                  disabled={!candidate.enabled || !candidate.workspaceId}
                >
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Dialog>
    </FieldSet>
  );
}

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

/** What the sticky Save holds: `null` fields are unchanged. */
interface SettingsDraft {
  name: string | null;
  description: string | null;
  access: BotAccessDraft | null;
  accessBaseline: BotAccessDraft | null;
}

/**
 * Unsaved edits, per Bot, for this window. The tab writes its draft here as it
 * changes, so closing the panel or moving to another Bot never drops typed
 * text; Save and Revert clear it.
 */
const unsavedDrafts = new Map<string, SettingsDraft>();

/** Forgets every unsaved edit this window holds (a fresh window, in tests). */
export function forgetUnsavedBotSettings(): void {
  unsavedDrafts.clear();
}

const ROW_CLASS =
  "settings-field relative flex w-full min-w-0 items-center gap-3 p-4 text-left outline-none transition-colors duration-150 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none";

/** A row that opens something: a label, an optional quiet value, and a chevron. */
function ChevronRow({
  label,
  description,
  value,
  icon,
  onClick,
}: {
  label: string;
  description?: string;
  value?: string | null;
  icon?: React.ReactNode;
  onClick(): void;
}) {
  const describedId = React.useId();
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={description || value ? describedId : undefined}
      className={ROW_CLASS}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-strong text-primary">{label}</span>
        {description ? (
          <span id={value ? undefined : describedId} className="mt-0.5 block truncate text-small text-secondary">
            {description}
          </span>
        ) : null}
      </span>
      {value ? (
        <span id={describedId} className="shrink-0 text-small text-secondary">
          {value}
        </span>
      ) : null}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
    </button>
  );
}

function sameBotLook(left: BotDefinition["avatar"], right: BotDefinition["avatar"]): boolean {
  const a = resolveBotAvatar(left);
  const b = resolveBotAvatar(right);
  return a.color === b.color && a.shape === b.shape;
}

/** The header: the Bot's look in a popover, and its name, read first and edited on click. */
function IdentityHeader({
  bot,
  name,
  onNameChange,
  onNameRevert,
}: {
  bot: BotDefinition;
  name: string;
  onNameChange(next: string): void;
  onNameRevert(): void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [photoBusy, setPhotoBusy] = React.useState(false);
  const photoInput = React.useRef<HTMLInputElement | null>(null);
  const nameButton = React.useRef<HTMLButtonElement | null>(null);
  const finishEditing = () => {
    setEditing(false);
    requestAnimationFrame(() => nameButton.current?.focus());
  };
  const saveLook = (avatar: BotDefinition["avatar"]) =>
    void updateBotIdentity(qc, bot.id, { avatar }).catch((error: unknown) =>
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t change ${bot.name}’s look.`)),
    );
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
  const shownName = name.trim() || bot.name;
  return (
    <div className="mb-6 flex items-center gap-3 px-1" data-bot-settings-header>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Change ${bot.name}’s look`}
            className="shrink-0 rounded-card outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <BotAvatar botId={bot.id} avatar={bot.avatar} name={shownName} photoLoading="immediate" size="large" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label={`${bot.name}’s look`} className="flex w-72 flex-col gap-3 p-3">
          <BotLookPicker avatar={bot.avatar} onChange={saveLook} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              variant="transparent"
              disabled={sameBotLook(bot.avatar, DEFAULT_BOT_AVATAR)}
              onClick={() => saveLook({ ...DEFAULT_BOT_AVATAR })}
            >
              Default look
            </Button>
            <Button size="small" variant="filled" disabled={photoBusy} onClick={() => photoInput.current?.click()}>
              Choose photo
            </Button>
            <Button size="small" variant="transparent" disabled={photoBusy} onClick={() => void removePhoto()}>
              Remove photo
            </Button>
          </div>
        </PopoverContent>
      </Popover>
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
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            aria-label="Name"
            value={name}
            maxLength={BOT_LIMITS.nameChars}
            onChange={(event) => onNameChange(event.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                finishEditing();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                // Escape closes the edit only, never the panel.
                event.stopPropagation();
                onNameRevert();
                finishEditing();
              }
            }}
          />
        ) : (
          <button
            ref={nameButton}
            type="button"
            aria-label={`Rename ${shownName}`}
            title="Rename"
            className="block max-w-full truncate rounded-control px-1 text-left text-large-strong text-primary outline-none hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => setEditing(true)}
          >
            {shownName}
          </button>
        )}
      </div>
    </div>
  );
}

/** "Quiet 10:00 PM–7:00 AM", or "Off". */
function quietHoursValue(value: BotInterruptions): string {
  return value.quietHours.enabled ? `${clockLabel(value.quietHours.start)}–${clockLabel(value.quietHours.end)}` : "Off";
}

/** The daily limit "When it finishes or needs input" goes back to, per Bot, for this window. */
const lastDailyLimit = new Map<string, number>();

/**
 * Notifications: one switch and Quiet hours. Off sets the Bot's daily limit to
 * none: routine results, suggestions and replies from other Bots stay in the
 * chat. Something only the person can fix still notifies, after quiet hours.
 * On puts back the limit it had, else the default.
 */
function NotificationsSection({ bot, onOpenQuietHours }: { bot: BotDefinition; onOpenQuietHours(): void }) {
  const qc = useQueryClient();
  const value = resolveBotInterruptions(bot.interruptions);
  const on = value.dailyLimit > 0;
  const change = (next: boolean) => {
    if (!next) lastDailyLimit.set(bot.id, value.dailyLimit);
    const dailyLimit = next ? lastDailyLimit.get(bot.id) || DEFAULT_BOT_INTERRUPTIONS.dailyLimit : 0;
    void updateBotIdentity(qc, bot.id, {
      interruptions: { ...value, dailyLimit: Math.min(BOT_INTERRUPTIONS_MAX_DAILY_LIMIT, dailyLimit) },
    }).catch((error: unknown) => toast.error(userFacingErrorMessage(error, `Aiden couldn’t save ${bot.name}’s notifications.`)));
  };
  return (
    <FieldSet title="Notifications">
      <Field
        label="When it finishes or needs input"
        description={on ? `Up to ${value.dailyLimit} a day. Anything only you can fix always arrives.` : "Results stay in the chat. Anything only you can fix still arrives."}
      >
        <Switch aria-label="When it finishes or needs input" checked={on} onCheckedChange={change} />
      </Field>
      <ChevronRow label="Quiet hours" value={quietHoursValue(value)} onClick={onOpenQuietHours} />
    </FieldSet>
  );
}

/** Quiet hours and the daily limit, saved as they change. */
function QuietHoursDialog({ bot, open, onOpenChange }: { bot: BotDefinition; open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const change = (next: BotInterruptions) =>
    void updateBotIdentity(qc, bot.id, { interruptions: next }).catch((error: unknown) =>
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t save ${bot.name}’s quiet hours.`)),
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quiet hours"
      description={`When ${bot.name} may send you messages on its own. Changes save as you make them.`}
      confirmHidden
      cancelLabel="Done"
    >
      <BotInterruptionsFields value={resolveBotInterruptions(bot.interruptions)} onChange={change} />
    </Dialog>
  );
}

function memorySummary(view: BotMemoryView | undefined): string | null {
  if (!view) return null;
  if (!view.readable) return "Couldn’t be read";
  const count = botMemoryCount(view);
  return count === 0 ? "Nothing yet" : botMemoryCountLabel(count);
}

/**
 * Permissions: the Bot's own check-ins, Bot messaging, its approved pairs, and
 * a link to the rules every Bot follows.
 * Bot messaging shows on only when the Bot both sends and receives; turning
 * it on turns both on.
 */
function PermissionsSection({ bot }: { bot: BotDefinition }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useSettings();
  const [saving, setSaving] = React.useState<"wakeUps" | "messaging" | null>(null);
  const [pairsOpen, setPairsOpen] = React.useState(false);
  const messagingAllowed = botMessagingEnabled(settings.data);
  const save = async (key: "wakeUps" | "messaging", patch: Parameters<typeof updateBotIdentity>[2]) => {
    setSaving(key);
    try {
      await updateBotIdentity(qc, bot.id, patch);
      if (key === "wakeUps" && patch.selfWakeUps === false) void qc.invalidateQueries({ queryKey: botRoutinesKey(bot.id) });
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save this setting."));
    } finally {
      setSaving(null);
    }
  };
  return (
    <FieldSet title="Permissions">
      <Field
        label="Daily check-ins on unfinished work"
        description={`${bot.name} can set one-time check-ins in this chat, up to a day ahead. Off cancels any still waiting.`}
      >
        <Switch
          aria-label="Daily check-ins on unfinished work"
          checked={bot.selfWakeUps !== false}
          disabled={saving !== null}
          onCheckedChange={(next) => void save("wakeUps", { selfWakeUps: next })}
        />
      </Field>
      <Field
        label="Can message other Bots"
        description={
          messagingAllowed
            ? `${bot.name} and other Bots can ask each other for help.`
            : "Bot messaging is off for every Bot in Settings → Approvals → Advanced."
        }
      >
        <Switch
          aria-label="Can message other Bots"
          checked={botMessagingSwitchOn(bot)}
          disabled={!messagingAllowed || settings.isLoading || saving !== null}
          onCheckedChange={(next) => void save("messaging", botMessagingPatch(next))}
        />
      </Field>
      <ChevronRow
        label="Approved Bot pairs"
        description="Bots that may hand each other whole requests."
        onClick={() => setPairsOpen(true)}
      />
      <ChevronRow
        label="Approvals"
        description={`What ${bot.name} may do without asking, in Settings`}
        onClick={() => void navigate(settingsLocation("approvals"))}
      />
      {pairsOpen ? <BotPeerManagerDialog key={bot.id} botId={bot.id} botName={bot.name} onClose={() => setPairsOpen(false)} /> : null}
    </FieldSet>
  );
}

/** The first line of the instructions, as a one-line preview. */
function instructionsPreview(instructions: string): string {
  return instructions.trim().split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
}

/** Saves the access draft against the stored access, rebased over changes made elsewhere. */
async function saveAccessDraft(
  qc: ReturnType<typeof useQueryClient>,
  botId: string,
  current: BotAccessDraft,
  start: BotAccessDraft,
): Promise<BotAccessDraft> {
  const [state, readCatalog] = await Promise.all([botsApi.getBotAccess(botId), botsApi.getCapabilityCatalog(botId)]);
  if (!state) throw new Error("This Bot’s settings couldn’t be read.");
  let latestCatalog = readCatalog;
  const authoritative = accessDraftFromState(state, latestCatalog);
  const rebased = rebaseBotEditorAccessDraft(current, start, authoritative);
  if (rebased.usesFullAccess && !botFullAccessAccepted(latestCatalog)) {
    await botsApi.acknowledgeAccessNotice({
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      decision: "continue_full",
      confirmedForeground: true,
    });
    latestCatalog = await botsApi.getCapabilityCatalog(botId);
  }
  const update = buildBotAccessUpdate(rebased, latestCatalog);
  if (botAccessDiffers(update, state)) {
    // The answer is the saved access view alone: it takes the access query's
    // `access` now, and the model choices beside it reread in the background.
    const saved = await botsApi.updateBotAccess({ botId, expectedRevision: state.access.revision, access: update });
    qc.setQueryData<BotAccessState>(queryKeys.botAccess(botId), { ...state, access: saved });
    void qc.invalidateQueries({ queryKey: queryKeys.botAccess(botId) });
  } else {
    qc.setQueryData(queryKeys.botAccess(botId), state);
  }
  void qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
  return rebased;
}

/**
 * The Advanced tab. `sectionRequest` opens a spot in it from a link: the
 * instructions or quiet hours dialog, or the model section.
 */
export function BotAdvancedTab({ bot, sectionRequest = null }: { bot: BotDefinition; sectionRequest?: BotPanelSectionRequest | null }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const panel = useBotPanelActions();
  const catalogQuery = useBotCapabilityCatalog(true, bot.id);
  const accessQuery = useBotAccess(bot.id);
  const memory = useBotMemory(bot.id);
  const catalog = catalogQuery.data;
  const kept = React.useRef(unsavedDrafts.get(bot.id));
  const [restored, setRestored] = React.useState(kept.current !== undefined);
  const [nameEdit, setNameEdit] = React.useState<string | null>(kept.current?.name ?? null);
  const [descriptionEdit, setDescriptionEdit] = React.useState<string | null>(kept.current?.description ?? null);
  const [draft, setDraft] = React.useState<BotAccessDraft | null>(kept.current?.access ?? null);
  const [baseline, setBaseline] = React.useState<BotAccessDraft | null>(kept.current?.accessBaseline ?? null);
  const [saving, setSaving] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [instructionsOpen, setInstructionsOpen] = React.useState(false);
  const [quietOpen, setQuietOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const modelRef = React.useRef<HTMLDivElement | null>(null);
  const handledRequest = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!catalog || !accessQuery.isSuccess || draft) return;
    const initial = accessDraftFromState(accessQuery.data, catalog);
    setDraft(initial);
    setBaseline(initial);
  }, [accessQuery.data, accessQuery.isSuccess, catalog, draft]);

  const nameDirty = nameEdit !== null && nameEdit.trim() !== bot.name;
  const descriptionDirty = descriptionEdit !== null && descriptionEdit.trim() !== (bot.description ?? "").trim();
  const accessChanged = draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
  const dirty = nameDirty || descriptionDirty || accessChanged;

  // Every change is kept for this window until Save or Revert.
  React.useEffect(() => {
    if (dirty) {
      unsavedDrafts.set(bot.id, {
        name: nameDirty ? nameEdit : null,
        description: descriptionDirty ? descriptionEdit : null,
        access: accessChanged ? draft : null,
        accessBaseline: accessChanged ? baseline : null,
      });
    } else {
      unsavedDrafts.delete(bot.id);
    }
  }, [accessChanged, baseline, bot.id, descriptionDirty, descriptionEdit, dirty, draft, nameDirty, nameEdit]);

  React.useEffect(() => {
    if (!sectionRequest || sectionRequest.botId !== bot.id || handledRequest.current === sectionRequest.key) return;
    handledRequest.current = sectionRequest.key;
    if (sectionRequest.section === "instructions") setInstructionsOpen(true);
    else if (sectionRequest.section === "quiet-hours") setQuietOpen(true);
    else {
      const frame = requestAnimationFrame(() => {
        modelRef.current?.scrollIntoView({ block: "start" });
        modelRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [bot.id, sectionRequest]);

  const revert = () => {
    setNameEdit(null);
    setDescriptionEdit(null);
    setNameError(null);
    if (baseline) setDraft(baseline);
    setRestored(false);
  };

  const save = async () => {
    if (!dirty || saving) return;
    if (nameDirty && !nameEdit!.trim()) {
      setNameError("A Bot needs a name.");
      return;
    }
    setNameError(null);
    setSaving(true);
    try {
      const patch: { name?: string; description?: string } = {};
      if (nameDirty) patch.name = nameEdit!.trim();
      if (descriptionDirty) patch.description = descriptionEdit!.trim();
      if (patch.name !== undefined || patch.description !== undefined) await updateBotIdentity(qc, bot.id, patch);
      setNameEdit(null);
      setDescriptionEdit(null);
      if (accessChanged && draft && baseline) {
        const saved = await saveAccessDraft(qc, bot.id, draft, baseline);
        setDraft(saved);
        setBaseline(saved);
      }
      setRestored(false);
      toast.success("Saved");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save these settings."));
    } finally {
      setSaving(false);
    }
  };

  const openPage = (page: "open-work" | "learning") =>
    void navigate({ to: "/bots/$botId", params: { botId: bot.id }, search: { page } });
  const preview = instructionsPreview(bot.instructions);
  const failed = catalogQuery.isError || accessQuery.isError;
  return (
    <div className="flex min-h-full flex-col" data-bot-advanced={bot.id}>
      <IdentityHeader
        bot={bot}
        name={nameEdit ?? bot.name}
        onNameChange={(next) => {
          setNameEdit(next);
          setNameError(null);
        }}
        onNameRevert={() => setNameEdit(null)}
      />
      {nameError ? (
        <Text as="p" role="alert" variant="small" color="red" className="-mt-4 mb-4 px-1">
          {nameError}
        </Text>
      ) : null}
      {restored && dirty ? (
        <Callout color="gray" role="status" className="mb-5">
          <Text as="p" variant="small">
            Your unsaved changes are back.
          </Text>
        </Callout>
      ) : null}
      <NotificationsSection bot={bot} onOpenQuietHours={() => setQuietOpen(true)} />
      <FieldSet title="Open work">
        <BotOpenWorkRow botId={bot.id} onOpen={() => openPage("open-work")} />
      </FieldSet>
      <FieldSet title="Memory">
        <ChevronRow
          label="Memory"
          icon={<MemoryCardIcon aria-hidden="true" className="size-4 shrink-0 text-secondary" />}
          value={memorySummary(memory.data)}
          onClick={() => panel.show("memory")}
        />
        <ChevronRow
          label="What I’ve learned"
          description="Lessons, skills and follow-ups, with Undo"
          onClick={() => openPage("learning")}
        />
      </FieldSet>
      <div ref={modelRef} className="scroll-mt-4">
        {failed ? (
          <Callout color="red" role="alert" className="mb-7 flex-row items-center justify-between gap-4">
            <div>
              <Text variant="small-strong" color="red">
                The model and tools couldn’t be loaded
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5">
                Try again before changing them.
              </Text>
            </div>
            <Button
              size="small"
              variant="filled"
              onClick={() => {
                void catalogQuery.refetch();
                void accessQuery.refetch();
              }}
            >
              <RotateCcw /> Try again
            </Button>
          </Callout>
        ) : !catalog || !draft ? (
          <div className="mb-7">
            <BotPageSkeleton label="Loading the model" groups={[2]} />
          </div>
        ) : (
          <ModelSection
            catalog={catalog}
            draft={draft}
            disabled={saving}
            onChange={setDraft}
            onSetUpModel={() => void navigate({ to: "/settings", search: { section: "providers" } })}
          />
        )}
        <FieldSet>
          <ChevronRow
            label="Routine models"
            description="Each routine can use its own model. Choose it on the routine."
            onClick={() => panel.show("routines")}
          />
        </FieldSet>
        <BotHealthSection bot={bot} />
      </div>
      {/* Apple silicon only; renders nothing elsewhere. Its actions confirm and act at once. */}
      <BotComputerSection bot={bot} />
      <PermissionsSection bot={bot} />
      <TelegramSection bot={bot} />
      <FieldSet title="Instructions">
        <ChevronRow label="Instructions" description={preview || "No instructions yet"} onClick={() => setInstructionsOpen(true)} />
      </FieldSet>
      <FieldSet title="How other Bots see it">
        <Field label="Subtitle" description="A few words under its name. Other Bots read it to know what it helps with.">
          <Input
            aria-label="Subtitle"
            value={descriptionEdit ?? bot.description ?? ""}
            maxLength={BOT_LIMITS.descriptionChars}
            placeholder="What it helps with"
            disabled={saving}
            onChange={(event) => setDescriptionEdit(event.target.value)}
          />
        </Field>
      </FieldSet>
      {catalog && draft ? <AccessSection catalog={catalog} draft={draft} disabled={saving} onChange={setDraft} /> : null}
      <BotSpendingSection bot={bot} />
      <FieldSet title="Clear">
        <ChevronRow label="Erase memory" description={`Opens Memory, where you can erase what ${bot.name} remembers.`} onClick={() => panel.show("memory")} />
        <Field label="Delete Bot" description={`${bot.name}, its chat, memory and routines.`}>
          <Button size="small" variant="destructive" onClick={() => setDeleting(true)}>
            Delete Bot…
          </Button>
        </Field>
      </FieldSet>
      <Text as="p" variant="small" color="tertiary" className="px-1 pb-2 text-center">
        Switches save as you change them and apply from the next message.
      </Text>
      {dirty ? (
        <div
          role="region"
          aria-label="Unsaved changes"
          className="sticky bottom-0 z-10 -mx-3 mt-auto flex items-center justify-end gap-2 bg-popover px-3 py-3 shadow-[0_-1px_0_var(--color-separator)]"
          data-bot-settings-save
        >
          <Text as="p" variant="small" color="secondary" className="mr-auto">
            Unsaved changes
          </Text>
          <Button size="small" variant="transparent" disabled={saving} onClick={revert}>
            Revert
          </Button>
          <Button size="small" variant="accent" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
      <BotInstructionsDialog bot={bot} open={instructionsOpen} onOpenChange={setInstructionsOpen} />
      <QuietHoursDialog bot={bot} open={quietOpen} onOpenChange={setQuietOpen} />
      <BotDeleteDialog bot={bot} open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}
