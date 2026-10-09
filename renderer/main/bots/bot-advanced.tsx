import * as React from "react";
import { ChevronLeft, Link2, RotateCcw, Unlink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  FieldSet,
  InlineMetadata,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  Textarea,
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
import { BOT_LIMITS, type BotDefinition } from "../../shared/bots";
import {
  accessDraftFromState,
  botAccessDiffers,
  botFullAccessAccepted,
  buildBotAccessUpdate,
  firstAvailableModel,
  firstAvailableVisionModel,
  type BotAccessDraft,
} from "./bot-access-draft";
import { updateBotIdentity } from "./bot-identity";

type ToggleKey = "fileScopeIds" | "connectionIds" | "skillIds" | "otherCapabilityIds";

function sameDraft(left: BotAccessDraft | null, right: BotAccessDraft | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function withRecommendedModel(draft: BotAccessDraft, catalog: BotCapabilityCatalog): BotAccessDraft {
  const model = firstAvailableModel(catalog);
  const supportsImages = catalog.providers
    .find((provider) => provider.id === model?.providerId)
    ?.models.find((candidate) => candidate.id === model?.modelId)?.supportsImages;
  const vision = supportsImages ? undefined : firstAvailableVisionModel(catalog, model?.providerId);
  return {
    ...draft,
    providerId: model?.providerId,
    modelId: model?.modelId,
    visionProviderId: vision?.providerId,
    visionModelId: vision?.modelId,
  };
}

function ModelSection({
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
  const provider = catalog.providers.find(({ id }) => id === draft.providerId);
  const model = provider?.models.find(({ id }) => id === draft.modelId);
  const visionProviders = catalog.providers.filter(
    (candidate) => candidate.available && candidate.models.some((item) => item.available && item.supportsImages),
  );
  const visionProvider = catalog.providers.find(({ id }) => id === draft.visionProviderId);
  const noModels = !firstAvailableModel(catalog);
  return (
    <FieldSet title="AI model">
      <Field
        orientation="vertical"
        label="Model"
        description="Recommended picks the first model you have set up."
      >
        {noModels ? (
          <Text as="p" variant="small" color="secondary">
            No AI model is set up yet. Add one in Settings → Providers.
          </Text>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            <Select
              value={draft.providerId ?? ""}
              disabled={disabled}
              onValueChange={(providerId) => {
                const nextProvider = catalog.providers.find(({ id }) => id === providerId);
                const nextModel = nextProvider?.models.find((candidate) => candidate.available);
                const vision = nextModel?.supportsImages
                  ? undefined
                  : firstAvailableVisionModel(catalog, providerId);
                onChange({
                  ...draft,
                  providerId,
                  modelId: nextModel?.id,
                  visionProviderId: vision?.providerId,
                  visionModelId: vision?.modelId,
                });
              }}
            >
              <SelectTrigger aria-label="AI service">
                <SelectValue placeholder="Service" />
              </SelectTrigger>
              <SelectContent>
                {catalog.providers.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id} disabled={!candidate.available}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={draft.modelId ?? ""}
              disabled={disabled}
              onValueChange={(modelId) => {
                const nextModel = provider?.models.find(({ id }) => id === modelId);
                const vision = nextModel?.supportsImages
                  ? undefined
                  : draft.visionProviderId && draft.visionModelId
                    ? { providerId: draft.visionProviderId, modelId: draft.visionModelId }
                    : firstAvailableVisionModel(catalog, provider?.id);
                onChange({
                  ...draft,
                  modelId,
                  visionProviderId: vision?.providerId,
                  visionModelId: vision?.modelId,
                });
              }}
            >
              <SelectTrigger aria-label="AI model">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {(provider?.models ?? []).map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id} disabled={!candidate.available}>
                    {candidate.label}{" "}
                    <InlineMetadata>· {candidate.supportsImages ? "Reads images" : "Text only"}</InlineMetadata>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div>
              <Button
                size="small"
                variant="transparent"
                disabled={disabled}
                onClick={() => onChange(withRecommendedModel(draft, catalog))}
              >
                <RotateCcw /> Use recommended
              </Button>
            </div>
          </div>
        )}
      </Field>
      {model && !model.supportsImages ? (
        <Field
          orientation="vertical"
          label="Image model"
          description={`${model.label} reads text only. Photos and screenshots go to this model.`}
        >
          {visionProviders.length === 0 ? (
            <Text as="p" variant="small" color="secondary">
              No model that reads images is set up. Add one in Settings → Providers.
            </Text>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              <Select
                value={draft.visionProviderId ?? ""}
                disabled={disabled}
                onValueChange={(providerId) => {
                  const nextProvider = catalog.providers.find(({ id }) => id === providerId);
                  const nextModel = nextProvider?.models.find(
                    (candidate) => candidate.available && candidate.supportsImages,
                  );
                  onChange({ ...draft, visionProviderId: providerId, visionModelId: nextModel?.id });
                }}
              >
                <SelectTrigger aria-label="Image service">
                  <SelectValue placeholder="Service" />
                </SelectTrigger>
                <SelectContent>
                  {visionProviders.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={draft.visionModelId ?? ""}
                disabled={disabled}
                onValueChange={(visionModelId) => onChange({ ...draft, visionModelId })}
              >
                <SelectTrigger aria-label="Image model">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  {(visionProvider?.models ?? [])
                    .filter((candidate) => candidate.available && candidate.supportsImages)
                    .map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </Field>
      ) : null}
    </FieldSet>
  );
}

function ToggleRows({
  options,
  selected,
  allowAll,
  disabled,
  onToggle,
}: {
  options: readonly BotCapabilityOption[];
  selected: readonly string[];
  allowAll: boolean;
  disabled: boolean;
  onToggle(id: string, checked: boolean): void;
}) {
  // Hide unusable, unselected entries instead of rows that can never be enabled.
  const visible = options.filter((option) => option.available || selected.includes(option.id));
  if (visible.length === 0) {
    return (
      <Text as="p" variant="small" color="tertiary">
        None available yet.
      </Text>
    );
  }
  return (
    <ul className="space-y-1">
      {visible.map((option) => {
        const checked = selected.includes(option.id);
        return (
          <li key={option.id} className="flex items-center justify-between gap-4 py-1.5">
            <span className="min-w-0">
              <Text variant="small-strong">{option.label}</Text>
              {option.description ? (
                <Text as="p" variant="small" color="tertiary">
                  {option.description}
                </Text>
              ) : null}
            </span>
            <Switch
              checked={allowAll || checked}
              disabled={disabled || allowAll || (!option.available && !checked)}
              onCheckedChange={(next) => onToggle(option.id, next)}
              aria-label={`Allow ${option.label}`}
            />
          </li>
        );
      })}
    </ul>
  );
}

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
    <FieldSet title="What it can use">
      <Field orientation="vertical">
        <RadioGroup
          orientation="vertical"
          aria-label="What it can use"
          value={full ? "full" : "custom"}
          disabled={disabled}
          onValueChange={(value) => onChange({ ...draft, usesFullAccess: value === "full" })}
        >
          <label className="flex items-start gap-3">
            <RadioGroupItem value="full" aria-label="Everything" className="mt-0.5" />
            <span>
              <Text variant="small-strong">Everything</Text>
              <Text as="p" variant="small" color="secondary">
                Anything Aiden can use on this Mac. Approvals and safety rules still apply.
              </Text>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <RadioGroupItem value="custom" aria-label="Only what I choose" className="mt-0.5" />
            <span>
              <Text variant="small-strong">Only what I choose</Text>
              <Text as="p" variant="small" color="secondary">
                Pick the files, commands, and connections below.
              </Text>
            </span>
          </label>
        </RadioGroup>
      </Field>
      {full ? null : (
        <>
          <Field orientation="vertical" label="Files and commands">
            <ToggleRows
              options={catalog.fileScopes}
              selected={draft.fileScopeIds}
              allowAll={false}
              disabled={disabled}
              onToggle={(id, checked) => toggle("fileScopeIds", id, checked)}
            />
            <div className="flex items-center justify-between gap-4 py-1.5">
              <Text variant="small-strong">Run commands</Text>
              <Switch
                checked={draft.shellEnabled}
                disabled={disabled || (!catalog.shellAvailable && !draft.shellEnabled)}
                onCheckedChange={(shellEnabled) => onChange({ ...draft, shellEnabled })}
                aria-label="Allow running commands"
              />
            </div>
          </Field>
          <Field orientation="vertical" label="Connections">
            <ToggleRows
              options={catalog.connections}
              selected={draft.connectionIds}
              allowAll={false}
              disabled={disabled}
              onToggle={(id, checked) => toggle("connectionIds", id, checked)}
            />
          </Field>
          <Field
            orientation="vertical"
            label="Skills"
            description={catalog.skillsEnabled === false ? "Skills are off in Settings. Choices are kept for when they’re back on." : undefined}
          >
            <ToggleRows
              options={catalog.skills.map((option) => ({
                ...option,
                available: option.available || catalog.skillsEnabled === false,
              }))}
              selected={draft.skillIds}
              allowAll={false}
              disabled={disabled}
              onToggle={(id, checked) => toggle("skillIds", id, checked)}
            />
          </Field>
          {catalog.otherCapabilities.length ? (
            <Field orientation="vertical" label="More">
              <ToggleRows
                options={catalog.otherCapabilities}
                selected={draft.otherCapabilityIds}
                allowAll={false}
                disabled={disabled}
                onToggle={(id, checked) => toggle("otherCapabilityIds", id, checked)}
              />
            </Field>
          ) : null}
        </>
      )}
    </FieldSet>
  );
}

function GreetingSection({ bot }: { bot: Pick<BotDefinition, "id" | "openingGreeting"> }) {
  const qc = useQueryClient();
  const [text, setText] = React.useState(bot.openingGreeting ?? "");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => setText(bot.openingGreeting ?? ""), [bot.openingGreeting]);
  const changed = text.trim() !== (bot.openingGreeting ?? "").trim();
  return (
    <FieldSet title="Opening greeting">
      <Field
        orientation="vertical"
        description="The first message in a new chat. Changing it won’t edit an existing chat."
      >
        <Textarea
          aria-label="Opening greeting"
          className="min-h-20 resize-y"
          value={text}
          maxLength={BOT_LIMITS.openingGreetingChars}
          disabled={saving}
          placeholder="Hi! What should we start with?"
          onChange={(event) => setText(event.target.value)}
        />
        <div>
          <Button
            size="small"
            variant="filled"
            disabled={saving || !changed}
            onClick={async () => {
              setSaving(true);
              try {
                await updateBotIdentity(qc, bot.id, { openingGreeting: text });
              } catch (error) {
                toast.error(userFacingErrorMessage(error, "Aiden couldn’t save the greeting."));
              } finally {
                setSaving(false);
              }
            }}
          >
            Save greeting
          </Button>
        </div>
      </Field>
    </FieldSet>
  );
}

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
        <div className="flex justify-end">
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
        </div>
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
          <Text color="secondary">Loading Telegram chats…</Text>
        ) : targets.isError ? (
          <Button size="small" variant="filled" onClick={() => void targets.refetch()}>
            <RotateCcw /> Try again
          </Button>
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
 * Power settings for one Bot: model, what it can use, the opening greeting,
 * and Telegram. Model and access save together.
 */
export function BotAdvanced({ bot, onClose }: { bot: BotDefinition; onClose(): void }) {
  const qc = useQueryClient();
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

  const save = async () => {
    if (!draft || !baseline || saving) return;
    setSaving(true);
    try {
      const [state, readCatalog] = await Promise.all([
        botsApi.getBotAccess(bot.id),
        botsApi.getCapabilityCatalog(bot.id),
      ]);
      if (!state) throw new Error("This Bot’s settings couldn’t be read.");
      let latestCatalog = readCatalog;
      const authoritative = accessDraftFromState(state, latestCatalog);
      const rebased = rebaseBotEditorAccessDraft(draft, baseline, authoritative);
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
        await botsApi.updateBotAccess({
          botId: bot.id,
          expectedRevision: state.access.revision,
          access: update,
        });
      }
      await qc.invalidateQueries({ queryKey: queryKeys.botAccess(bot.id) });
      await qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
      setDraft(rebased);
      setBaseline(rebased);
      toast.success("Saved");
    } catch (error) {
      toast.error(userFacingErrorMessage(error, "Aiden couldn’t save these settings."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-responsive flex flex-col gap-6">
      <header className="settings-page-heading flex items-center gap-3">
        <Button iconOnly variant="filled" size="large" aria-label="Back" onClick={onClose}>
          <ChevronLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <Text as="h1" variant="heading1" className="truncate">
            Advanced
          </Text>
          <Text as="p" variant="small" color="secondary">
            Settings for {bot.name}. Most people never need these.
          </Text>
        </div>
      </header>
      {catalogQuery.isError || accessQuery.isError ? (
        <EmptyState
          role="alert"
          title="These settings couldn’t be loaded"
          action={
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
          }
        />
      ) : !catalog || !draft ? (
        <Text color="secondary" role="status">
          Loading…
        </Text>
      ) : (
        <div>
          <ModelSection catalog={catalog} draft={draft} disabled={saving} onChange={setDraft} />
          <AccessSection catalog={catalog} draft={draft} disabled={saving} onChange={setDraft} />
          <div className="-mt-3 mb-7 flex justify-end">
            <Button
              variant="accent"
              disabled={saving || sameDraft(draft, baseline)}
              onClick={() => void save()}
            >
              Save changes
            </Button>
          </div>
        </div>
      )}
      <GreetingSection bot={bot} />
      <TelegramSection bot={bot} />
    </div>
  );
}
