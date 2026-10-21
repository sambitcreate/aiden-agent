import * as React from "react";
import { ChevronRight, Link2, RotateCcw, Unlink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Button,
  Callout,
  Dialog,
  EmptyState,
  Field,
  FieldSet,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import {
  queryKeys,
  useBotAccess,
  useBotCapabilityCatalog,
  useBotTelegramBinding,
  useBotTelegramTargets,
} from "../../lib/queries";
import { rebaseBotEditorAccessDraft } from "../../shared/bot-editor-save";
import {
  BOT_FULL_ACCESS_NOTICE_VERSION,
  nextBotFileScopeIds,
  type BotCapabilityCatalog,
  type BotCapabilityOption,
} from "../../shared/bot-capabilities";
import type { BotDefinition } from "../../shared/bots";
import {
  accessDraftFromState,
  botAccessDiffers,
  botFullAccessAccepted,
  buildBotAccessUpdate,
  firstAvailableModel,
  type BotAccessDraft,
} from "./bot-access-draft";
import {
  chooseBotModel,
  chooseBotVisionModel,
  findBotModel,
  recommendedBotModelChoice,
  sameBotModelChoice,
} from "./bot-model-choice";
import { botChatActivitySummary } from "./bot-chat-activity-page";
import { BotModelPicker, botModelCapabilityLabel } from "./bot-model-picker";
import { BotPageShell, BotPageSkeleton, useDiscardChangesGuard } from "./bot-page-shell";

type ToggleKey = "fileScopeIds" | "connectionIds" | "skillIds" | "otherCapabilityIds";

function sameDraft(left: BotAccessDraft | null, right: BotAccessDraft | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

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
      <FieldSet title="AI model">
        <Field label="No AI model yet" description="Add one in Settings → Providers so this Bot can reply.">
          <Button size="small" variant="filled" onClick={onSetUpModel}>
            Set up
          </Button>
        </Field>
      </FieldSet>
    );
  }
  return (
    <FieldSet title="AI model">
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

const ACCESS_CHOICES = [
  {
    value: "full",
    label: "Everything",
    description: "Anything Aiden can use on this Mac, including every app you connect. Approvals and safety rules still apply.",
  },
  {
    value: "custom",
    label: "Only what I choose",
    description: "Pick the files, commands, connections, and skills below.",
  },
] as const;

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
  const toggle = (key: ToggleKey, id: string, checked: boolean) => {
    if (key === "fileScopeIds") {
      onChange({ ...draft, fileScopeIds: nextBotFileScopeIds(draft.fileScopeIds, catalog.fileScopes, id, checked) });
      return;
    }
    const ids = new Set(draft[key]);
    if (checked) ids.add(id);
    else ids.delete(id);
    onChange({ ...draft, [key]: [...ids] });
  };
  const full = draft.usesFullAccess;
  return (
    <>
      <FieldSet title="What it can use">
        <Field orientation="vertical">
          <RadioGroup
            orientation="vertical"
            aria-label="What it can use"
            value={full ? "full" : "custom"}
            disabled={disabled}
            onValueChange={(value) => onChange({ ...draft, usesFullAccess: value === "full" })}
          >
            {ACCESS_CHOICES.map((choice) => (
              <Label
                key={choice.value}
                className="cursor-pointer items-start rounded-control bg-well px-3 py-2.5 hover:bg-list-hover has-[[data-state=checked]]:bg-list-selection"
              >
                <RadioGroupItem value={choice.value} aria-label={choice.label} className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-regular text-primary">{choice.label}</span>
                  <span className="mt-0.5 block text-small text-secondary">{choice.description}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </Field>
      </FieldSet>
      {full ? (
        <FieldSet title="More">
          <Field
            label="Web search"
            description="Let it look things up with Aiden’s Web Search."
          >
            <Switch
              checked={draft.webSearchEnabled}
              disabled={disabled}
              onCheckedChange={(webSearchEnabled) => onChange({ ...draft, webSearchEnabled })}
              aria-label="Allow web search"
            />
          </Field>
        </FieldSet>
      ) : (
        <>
          <FieldSet title="Files and commands">
            <ToggleFields
              options={catalog.fileScopes}
              selected={draft.fileScopeIds}
              disabled={disabled}
              onToggle={(id, checked) => toggle("fileScopeIds", id, checked)}
            />
            <Field label="Run commands" description="Let it run commands in Terminal on this Mac.">
              <Switch
                checked={draft.shellEnabled}
                disabled={disabled || (!catalog.shellAvailable && !draft.shellEnabled)}
                onCheckedChange={(shellEnabled) => onChange({ ...draft, shellEnabled })}
                aria-label="Allow running commands"
              />
            </Field>
          </FieldSet>
          <FieldSet title="Connections">
            <ToggleFields
              options={catalog.connections}
              selected={draft.connectionIds}
              disabled={disabled}
              onToggle={(id, checked) => toggle("connectionIds", id, checked)}
            />
          </FieldSet>
          <FieldSet title="Skills">
            {catalog.skillsEnabled === false ? (
              <Field description="Skills are off in Settings. Choices are kept for when they’re back on." />
            ) : null}
            <ToggleFields
              options={catalog.skills.map((option) => ({
                ...option,
                available: option.available || catalog.skillsEnabled === false,
              }))}
              selected={draft.skillIds}
              disabled={disabled}
              onToggle={(id, checked) => toggle("skillIds", id, checked)}
            />
          </FieldSet>
          {catalog.otherCapabilities.length ? (
            <FieldSet title="More">
              <ToggleFields
                options={catalog.otherCapabilities}
                selected={draft.otherCapabilityIds}
                disabled={disabled}
                onToggle={(id, checked) => toggle("otherCapabilityIds", id, checked)}
              />
            </FieldSet>
          ) : null}
        </>
      )}
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
    <FieldSet title="Telegram">
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
            description="Set up Telegram in Settings → Telegram first."
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

/**
 * Power settings for one Bot: model and what it can use are edited as one
 * draft and saved together by the toolbar's Save;
 * Back with unsaved edits asks before discarding them. Telegram is a
 * connection with its own Connect and Disconnect actions.
 */
export function BotAdvanced({
  bot,
  onClose,
  onOpenChatActivity,
}: {
  bot: BotDefinition;
  onClose(): void;
  onOpenChatActivity(): void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalogQuery = useBotCapabilityCatalog(true, bot.id);
  const accessQuery = useBotAccess(bot.id);
  const catalog = catalogQuery.data;
  const [draft, setDraft] = React.useState<BotAccessDraft | null>(null);
  const [baseline, setBaseline] = React.useState<BotAccessDraft | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!catalog || !accessQuery.isSuccess || draft) return;
    const initial = accessDraftFromState(accessQuery.data, catalog);
    setDraft(initial);
    setBaseline(initial);
  }, [accessQuery.data, accessQuery.isSuccess, catalog, draft]);

  const accessChanged = draft !== null && !sameDraft(draft, baseline);
  const dirty = accessChanged;
  const discardDescription = `Your changes to ${bot.name}’s Advanced settings won’t be saved.`;
  const guard = useDiscardChangesGuard({ dirty, onLeave: onClose, description: discardDescription });
  const chatActivityGuard = useDiscardChangesGuard({
    dirty,
    onLeave: onOpenChatActivity,
    description: discardDescription,
  });

  const saveAccess = async (current: BotAccessDraft, start: BotAccessDraft) => {
    const [state, readCatalog] = await Promise.all([
      botsApi.getBotAccess(bot.id),
      botsApi.getCapabilityCatalog(bot.id),
    ]);
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
      latestCatalog = await botsApi.getCapabilityCatalog(bot.id);
    }
    const update = buildBotAccessUpdate(rebased, latestCatalog);
    if (botAccessDiffers(update, state)) {
      // The answer is the saved view: it takes the access query now, and the
      // catalog (an inventory rebuild) rereads in the background.
      const saved = await botsApi.updateBotAccess({
        botId: bot.id,
        expectedRevision: state.access.revision,
        access: update,
      });
      qc.setQueryData(queryKeys.botAccess(bot.id), saved);
    } else {
      qc.setQueryData(queryKeys.botAccess(bot.id), state);
    }
    void qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
    setDraft(rebased);
    setBaseline(rebased);
  };

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      if (accessChanged && draft && baseline) await saveAccess(draft, baseline);
      toast.success("Saved");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save these settings."));
    } finally {
      setSaving(false);
    }
  };

  const failed = catalogQuery.isError || accessQuery.isError;
  return (
    <BotPageShell
      scrollId={`bot-advanced:${bot.id}`}
      title={bot.name}
      backLabel="Back"
      onBack={() => {
        if (!saving) guard.requestLeave();
      }}
      heading="Advanced"
      description={`Settings for ${bot.name}. Most people never need these.`}
      actions={
        <Button variant="accent" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      }
    >
      {failed ? (
        <Callout color="red" role="alert" className="mb-7 flex-row items-center justify-between gap-4">
          <div>
            <Text variant="small-strong" color="red">
              These settings couldn’t be loaded
            </Text>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              Try again before making changes.
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
          <BotPageSkeleton label="Loading settings" groups={[3, 1]} />
        </div>
      ) : (
        <>
          <ModelSection
            catalog={catalog}
            draft={draft}
            disabled={saving}
            onChange={setDraft}
            onSetUpModel={() => void navigate({ to: "/settings", search: { section: "providers" } })}
          />
          <AccessSection catalog={catalog} draft={draft} disabled={saving} onChange={setDraft} />
        </>
      )}
      <FieldSet title="Chat">
        <button
          type="button"
          aria-label="Chat activity"
          className="settings-field relative flex w-full min-w-0 items-center gap-3 p-4 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
          onClick={() => {
            if (!saving) chatActivityGuard.requestLeave();
          }}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-strong text-primary">Chat activity</span>
            <span className="mt-0.5 block text-small text-secondary">What you see while {bot.name} works.</span>
          </span>
          <span className="shrink-0 text-small text-secondary">{botChatActivitySummary(bot.chatActivity)}</span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
        </button>
      </FieldSet>
      <TelegramSection bot={bot} />
      {guard.dialog}
      {chatActivityGuard.dialog}
    </BotPageShell>
  );
}
