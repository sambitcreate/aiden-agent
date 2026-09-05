import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Bot,
  Link2,
  MessageSquarePlus,
  Pencil,
  Plus,
  RotateCcw,
  Unlink,
} from "lucide-react";
import { BotAvatar } from "../components/bot-avatar";
import { BotFaceStudio } from "../components/bot-face-studio";
import {
  Button,
  Callout,
  Dialog,
  EmptyState,
  Field,
  FieldSet,
  Input,
  InlineMetadata,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  Textarea,
  toast,
} from "../components/ui";
import { botsApi, type BotAccessState } from "../lib/ipc";
import {
  queryKeys,
  useBotAccess,
  useBotCapabilityCatalog,
  useBotChats,
  useBots,
  useBotTelegramBinding,
  useBotTelegramTargets,
} from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import {
  DEFAULT_BOT_AVATAR,
  resolveBotAvatar,
  type BotCreateInput,
  type BotDefinition,
} from "../shared/bots";
import {
  botEditorIdentityDiffers,
  botEditorIdentityDraftFromDefinition,
  rebaseBotEditorAccessDraft,
  rebaseBotEditorIdentityDraft,
  type BotEditorAccessDraft,
  type BotEditorIdentityDraft,
} from "../shared/bot-editor-save";
import {
  BOT_ACCESS_SUMMARIES,
  BOT_FILE_SCOPE_SELECTION_GUIDANCE,
  BOT_FULL_ACCESS_NOTICE_VERSION,
  botFileScopeSelectionIsCoherent,
  nextBotFileScopeIds,
  type BotAccessUpdate,
  type BotCapabilityCatalog,
  type BotCapabilityOption,
  type BotNoticeDecision,
} from "../shared/bot-capabilities";

type BotDraft = BotEditorIdentityDraft;

function emptyDraft(): BotDraft {
  return { name: "", description: "", instructions: "", avatar: { ...DEFAULT_BOT_AVATAR } };
}

function draftFromBot(bot: BotDefinition | null): BotDraft {
  return bot ? botEditorIdentityDraftFromDefinition(bot, resolveBotAvatar) : emptyDraft();
}

function createInputFromDraft(draft: BotDraft): BotCreateInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    instructions: draft.instructions.trim(),
    avatar: draft.avatar,
  };
}

function updateInputFromDraft(draft: BotDraft, authoritative: BotDefinition): BotCreateInput {
  return {
    ...createInputFromDraft(draft),
    ...(authoritative.openingGreeting
      ? { openingGreeting: authoritative.openingGreeting }
      : {}),
  };
}

/** Mirrors the iOS editor draft: one model selection for Full and Custom. */
type BotAccessDraft = BotEditorAccessDraft;

function botFullAccessAccepted(catalog: BotCapabilityCatalog): boolean {
  return catalog.notice.requiresAcknowledgement === false
    && catalog.notice.acceptedDecision === "continue_full";
}

function firstAvailableModel(catalog: BotCapabilityCatalog) {
  const provider = catalog.providers.find(
    (candidate) => candidate.available && candidate.models.some((model) => model.available),
  );
  const model = provider?.models.find((candidate) => candidate.available);
  return provider && model ? { providerId: provider.id, modelId: model.id } : undefined;
}

function firstAvailableVisionModel(catalog: BotCapabilityCatalog, preferredProviderId?: string) {
  const providers = [
    ...catalog.providers.filter((provider) => provider.id === preferredProviderId),
    ...catalog.providers.filter((provider) => provider.id !== preferredProviderId),
  ];
  const provider = providers.find(
    (candidate) => candidate.available
      && candidate.models.some((model) => model.available && model.supportsImages),
  );
  const model = provider?.models.find((candidate) => candidate.available && candidate.supportsImages);
  return provider && model ? { providerId: provider.id, modelId: model.id } : undefined;
}

function accessDraftFromState(
  state: BotAccessState | null | undefined,
  catalog: BotCapabilityCatalog,
): BotAccessDraft {
  const fallback = firstAvailableModel(catalog);
  const selected = state?.modelSelection
    && catalog.providers.some((provider) =>
      provider.id === state.modelSelection!.providerId
      && provider.models.some((model) => model.id === state.modelSelection!.modelId))
      ? state.modelSelection
      : undefined;
  const selectedModel = catalog.providers.find(({ id }) => id === (selected?.providerId ?? fallback?.providerId))
    ?.models.find(({ id }) => id === (selected?.modelId ?? fallback?.modelId));
  const visionFallback = selectedModel?.supportsImages
    ? undefined
    : firstAvailableVisionModel(catalog, selected?.providerId ?? fallback?.providerId);
  const visionSelected = state?.visionModelSelection
    && catalog.providers.some((provider) =>
      provider.id === state.visionModelSelection!.providerId
      && provider.models.some((model) =>
        model.id === state.visionModelSelection!.modelId && model.supportsImages))
      ? state.visionModelSelection
      : visionFallback;
  return {
    usesFullAccess: state ? state.access.accessMode === "full" : false,
    providerId: selected?.providerId ?? fallback?.providerId,
    modelId: selected?.modelId ?? fallback?.modelId,
    visionProviderId: visionSelected?.providerId,
    visionModelId: visionSelected?.modelId,
    fileScopeIds: state?.access.custom ? [...state.access.custom.fileScopeIds] : [],
    shellEnabled: state?.access.custom?.shellEnabled ?? false,
    connectionIds: state?.access.custom ? [...state.access.custom.connectionIds] : [],
    skillIds: state?.access.custom ? [...state.access.custom.skillIds] : [],
    otherCapabilityIds: state?.access.custom ? [...state.access.custom.otherCapabilityIds] : [],
  };
}

function buildBotAccessUpdate(
  draft: BotAccessDraft,
  catalog: BotCapabilityCatalog,
): BotAccessUpdate {
  const provider = catalog.providers.find((candidate) => candidate.id === draft.providerId);
  const model = provider?.models.find((candidate) => candidate.id === draft.modelId);
  if (!provider?.available || !model?.available) {
    throw new Error("Choose an available provider and model for this bot.");
  }
  const visionProvider = catalog.providers.find(
    (candidate) => candidate.id === draft.visionProviderId,
  );
  const visionModel = visionProvider?.models.find(
    (candidate) => candidate.id === draft.visionModelId,
  );
  if (!model.supportsImages && (
    !visionProvider?.available || !visionModel?.available || !visionModel.supportsImages
  )) {
    throw new Error("Choose an available vision model for photos and screenshots.");
  }
  const visionSelection = model.supportsImages
    ? null
    : { providerId: visionProvider!.id, modelId: visionModel!.id };
  if (draft.usesFullAccess) {
    if (!botFullAccessAccepted(catalog)) {
      throw new Error("Review the Full Access notice before saving.");
    }
    return {
      accessMode: "full",
      catalogRevision: catalog.revision,
      confirmedForeground: true,
      providerId: provider.id,
      modelId: model.id,
      visionModel: visionSelection,
    };
  }
  const assertAvailable = (options: BotCapabilityOption[], selected: string[], label: string) => {
    for (const id of selected) {
      if (!options.some((option) => option.id === id && option.available)) {
        throw new Error(`A selected ${label} is no longer available. Review the access choices.`);
      }
    }
  };
  assertAvailable(catalog.fileScopes, draft.fileScopeIds, "file access");
  assertAvailable(catalog.connections, draft.connectionIds, "connection");
  assertAvailable(catalog.skills, draft.skillIds, "skill");
  assertAvailable(catalog.otherCapabilities, draft.otherCapabilityIds, "capability");
  if (draft.shellEnabled && !catalog.shellAvailable) {
    throw new Error("Run commands is not currently available on this Mac.");
  }
  if (!botFileScopeSelectionIsCoherent(draft.fileScopeIds, catalog.fileScopes)) {
    throw new Error(BOT_FILE_SCOPE_SELECTION_GUIDANCE);
  }
  return {
    accessMode: "custom",
    catalogRevision: catalog.revision,
    custom: {
      providerId: provider.id,
      modelId: model.id,
      fileScopeIds: [...draft.fileScopeIds],
      shellEnabled: draft.shellEnabled,
      connectionIds: [...draft.connectionIds],
      skillIds: [...draft.skillIds],
      otherCapabilityIds: [...draft.otherCapabilityIds],
    },
    visionModel: visionSelection,
  };
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function botAccessDiffers(
  update: BotAccessUpdate,
  state: BotAccessState | null | undefined,
): boolean {
  if (!state) return true;
  if (update.accessMode !== state.access.accessMode) return true;
  if (update.accessMode === "full") {
    return state.modelSelection?.providerId !== update.providerId
      || state.modelSelection?.modelId !== update.modelId
      || state.visionModelSelection?.providerId !== update.visionModel?.providerId
      || state.visionModelSelection?.modelId !== update.visionModel?.modelId;
  }
  if (state.access.accessMode === "full") return true;
  const current = state.access.custom;
  const next = update.custom;
  return current.providerId !== next.providerId
    || current.modelId !== next.modelId
    || current.shellEnabled !== next.shellEnabled
    || !sameIdSet(current.fileScopeIds, next.fileScopeIds)
    || !sameIdSet(current.connectionIds, next.connectionIds)
    || !sameIdSet(current.skillIds, next.skillIds)
    || !sameIdSet(current.otherCapabilityIds, next.otherCapabilityIds)
    || state.visionModelSelection?.providerId !== update.visionModel?.providerId
    || state.visionModelSelection?.modelId !== update.visionModel?.modelId;
}

function botModelLabel(
  catalog: BotCapabilityCatalog | undefined,
  state: BotAccessState | null | undefined,
): string | null {
  const selection = state?.modelSelection;
  if (!selection) return null;
  const provider = catalog?.providers.find((candidate) => candidate.id === selection.providerId);
  const model = provider?.models.find((candidate) => candidate.id === selection.modelId);
  return provider && model ? `${provider.label} · ${model.label}` : null;
}
const botChatDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** Wizard pages for the New/Edit Bot dialog; the last page is the review/confirm step. */
const BOT_EDITOR_STEPS = [
  { title: "Create a bot", description: "Name your bot and describe what it should do." },
  { title: "Review model and access", description: "Review the AI model and what this bot may use, then create it." },
] as const;

function BotEditor({
  bot,
  onOpenChange,
}: {
  bot: BotDefinition | null;
  onOpenChange(open: boolean): void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = React.useState<BotDraft>(() => draftFromBot(bot));
  const [identityBaseline, setIdentityBaseline] = React.useState<BotDraft>(() => draftFromBot(bot));
  const [committedBot, setCommittedBot] = React.useState<BotDefinition | null>(bot);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [generatingAvatar, setGeneratingAvatar] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [noticing, setNoticing] = React.useState(false);
  const savingRef = React.useRef(false);
  const catalogQuery = useBotCapabilityCatalog(true);
  const accessQuery = useBotAccess(bot?.id);
  const catalog = catalogQuery.data;
  const [accessDraft, setAccessDraft] = React.useState<BotAccessDraft | null>(null);
  const [accessBaseline, setAccessBaseline] = React.useState<BotAccessDraft | null>(null);
  const [step, setStep] = React.useState(0);
  const pageTopRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!catalog || accessDraft) return;
    if (bot && !accessQuery.isSuccess) return;
    const initial = accessDraftFromState(bot ? accessQuery.data : undefined, catalog);
    setAccessDraft(initial);
    setAccessBaseline(initial);
  }, [catalog, accessDraft, bot, accessQuery.isSuccess, accessQuery.data]);

  const acknowledgeNotice = async (decision: BotNoticeDecision) => {
    if (!catalog || noticing) return;
    setNoticing(true);
    try {
      await botsApi.acknowledgeAccessNotice({
        version: BOT_FULL_ACCESS_NOTICE_VERSION,
        decision,
        confirmedForeground: true,
      });
      await qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
      if (decision === "customize_first") {
        setAccessDraft((current) => current ? { ...current, usesFullAccess: false } : current);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Aiden could not save your access decision.",
      );
    } finally {
      setNoticing(false);
    }
  };

  const save = async () => {
    if (savingRef.current) return;
    if (!catalog || !accessDraft) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      let saved: BotDefinition;
      if (!committedBot) {
        // Creation is one main-owned transaction: identity, workspace, model,
        // and access either become visible together or are rolled back together.
        // Re-read the catalog so Custom grants bind against current opaque ids.
        const latestCatalog = await botsApi.getCapabilityCatalog();
        qc.setQueryData(queryKeys.botCapabilityCatalog, latestCatalog);
        saved = await botsApi.create({
          bot: createInputFromDraft(draft),
          access: buildBotAccessUpdate(accessDraft, latestCatalog),
        });
        setCommittedBot(saved);
        setIdentityBaseline(draftFromBot(saved));
      } else {
        const authoritativeBot = await botsApi.get(committedBot.id);
        if (!authoritativeBot) throw new Error("This bot is no longer available.");
        const authoritativeIdentity = draftFromBot(authoritativeBot);
        const rebasedIdentity = rebaseBotEditorIdentityDraft(
          draft,
          identityBaseline,
          authoritativeIdentity,
        );
        setDraft(rebasedIdentity);
        setIdentityBaseline(authoritativeIdentity);
        saved = botEditorIdentityDiffers(rebasedIdentity, authoritativeIdentity)
          ? await botsApi.update({
              id: authoritativeBot.id,
              expectedRevision: authoritativeBot.revision,
              ...updateInputFromDraft(rebasedIdentity, authoritativeBot),
            })
          : authoritativeBot;
        setCommittedBot(saved);
        setIdentityBaseline(draftFromBot(saved));

        // Rebase only fields edited in this dialog onto the latest policy and
        // catalog. Unrelated changes from iOS or another Mac surface survive.
        const [state, latestCatalog] = await Promise.all([
          botsApi.getBotAccess(saved.id),
          botsApi.getCapabilityCatalog(),
        ]);
        if (!state) throw new Error("This bot’s access policy could not be read.");
        const authoritativeAccess = accessDraftFromState(state, latestCatalog);
        const rebasedAccess = rebaseBotEditorAccessDraft(
          accessDraft,
          accessBaseline ?? accessDraft,
          authoritativeAccess,
        );
        setAccessDraft(rebasedAccess);
        setAccessBaseline(authoritativeAccess);
        qc.setQueryData(queryKeys.botCapabilityCatalog, latestCatalog);
        const update = buildBotAccessUpdate(rebasedAccess, latestCatalog);
        if (botAccessDiffers(update, state)) {
          await botsApi.updateBotAccess({
            botId: saved.id,
            expectedRevision: state.access.revision,
            access: update,
          });
          await qc.invalidateQueries({ queryKey: queryKeys.botAccess(saved.id) });
          await qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
        }
      }
      await qc.invalidateQueries({ queryKey: queryKeys.bots });
      qc.setQueryData(queryKeys.bot(saved.id), saved);
      onOpenChange(false);
      if (!bot) await navigate({ to: "/bots/$botId", params: { botId: saved.id } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Aiden could not save this bot.";
      setSaveError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const accessUnavailable = catalogQuery.isError || (!catalogQuery.isLoading && !catalog);
  const fullAccepted = catalog ? botFullAccessAccepted(catalog) : false;
  const selectedProvider = catalog?.providers.find(
    (provider) => provider.id === accessDraft?.providerId,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.id === accessDraft?.modelId,
  );
  const selectedVisionProvider = catalog?.providers.find(
    (provider) => provider.id === accessDraft?.visionProviderId,
  );
  const selectedVisionModel = selectedVisionProvider?.models.find(
    (model) => model.id === accessDraft?.visionModelId,
  );
  const availableVisionProviders = catalog?.providers.filter((provider) =>
    provider.available
    && provider.models.some((model) => model.available && model.supportsImages)) ?? [];
  const toggleId = (
    key: "fileScopeIds" | "connectionIds" | "skillIds" | "otherCapabilityIds",
    id: string,
    checked: boolean,
  ) =>
    setAccessDraft((current) => {
      if (!current || !catalog) return current;
      if (key === "fileScopeIds") {
        return {
          ...current,
          fileScopeIds: nextBotFileScopeIds(current.fileScopeIds, catalog.fileScopes, id, checked),
        };
      }
      const ids = new Set(current[key]);
      if (checked) ids.add(id);
      else ids.delete(id);
      return { ...current, [key]: [...ids] };
    });

  const isLastStep = step === BOT_EDITOR_STEPS.length - 1;
  const identityReady = Boolean(draft.name.trim() && draft.instructions.trim()) && !generatingAvatar;
  const accessModeReady = Boolean(
    !accessUnavailable && catalog && accessDraft && !(accessDraft.usesFullAccess && !fullAccepted),
  );
  const modelReady = Boolean(
    selectedProvider?.available && selectedModel?.available
      && (selectedModel.supportsImages || (
        selectedVisionProvider?.available
        && selectedVisionModel?.available
        && selectedVisionModel.supportsImages
      )),
  );
  const settingsReady = (() => {
    if (!catalog || !accessDraft || !accessModeReady || !modelReady) return false;
    try {
      buildBotAccessUpdate(accessDraft, catalog);
      return true;
    } catch {
      return false;
    }
  })();
  // Each page gates its own Next button; the review page re-checks everything
  // so Confirm can never run against an incomplete draft.
  const stepValid = [identityReady, identityReady && settingsReady];
  const goNext = () => {
    if (!stepValid[step]) return;
    setStep((current) => Math.min(current + 1, BOT_EDITOR_STEPS.length - 1));
  };
  React.useEffect(() => {
    if (step === 0) return;
    pageTopRef.current?.focus();
  }, [step]);
  const summaryRow = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-small text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-small text-primary">{value}</dd>
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={bot ? `Edit ${bot.name}` : "Create a bot"}
      description={BOT_EDITOR_STEPS[step]!.description}
      confirmLabel={isLastStep ? (bot ? "Save changes" : "Create a bot") : "Review model and access"}
      confirmDisabled={saving || !stepValid[step]}
      busy={saving}
      onConfirm={isLastStep ? save : goNext}
      size="large"
    >
      <div
        key={step}
        ref={pageTopRef}
        tabIndex={-1}
        className="aiden-bot-wizard-page space-y-5 pr-1 pb-2 outline-none scroll-pb-6"
        role="group"
        aria-label={`${BOT_EDITOR_STEPS[step]!.title} step`}
      >
        <div className="flex items-center justify-between gap-4">
          {step > 0 ? (
            <Button
              size="small"
              variant="transparent"
              disabled={saving}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              <ArrowLeft /> Back
            </Button>
          ) : (
            <span aria-hidden="true" />
          )}
          <div className="flex items-center gap-2" aria-hidden="true">
            {BOT_EDITOR_STEPS.map((_candidate, index) => (
              <span
                key={index}
                className={`size-2 rounded-full ${index === step ? "bg-accent" : "bg-control-hover"}`}
              />
            ))}
          </div>
          <Text as="p" variant="small" color="tertiary" className="tabular-nums" aria-live="polite">
            Step {step + 1} of {BOT_EDITOR_STEPS.length}
          </Text>
        </div>
        {saveError ? <Callout color="red" role="alert">{saveError} Your choices are still here.</Callout> : null}
        {step === 0 ? (
          <>
            <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
          <label className="block">
            <Text variant="small-strong">Name</Text>
            <Input
              autoFocus
              className="mt-1.5"
              value={draft.name}
              disabled={saving}
              maxLength={80}
              placeholder="Release reviewer"
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label className="block">
            <Text variant="small-strong">Short description</Text>
            <Input
              className="mt-1.5"
              value={draft.description}
              disabled={saving}
              maxLength={280}
              placeholder="What this bot is best at"
              onChange={(event) =>
                setDraft((current) => ({ ...current, description: event.target.value }))
              }
            />
          </label>
        </div>

        <details className="rounded-card bg-well p-3">
          <summary className="cursor-pointer rounded-control text-small-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">Customize appearance (optional)</summary>
        <BotFaceStudio
          avatar={draft.avatar}
          botName={draft.name}
          onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))}
          onGeneratingChange={setGeneratingAvatar}
          disabled={saving}
        />
        </details>

        <label className="block">
          <Text variant="small-strong">Instructions</Text>
          <Text as="span" variant="small" color="tertiary" className="ml-2">
            Applied to every new turn
          </Text>
          <Textarea
            className="mt-1.5 min-h-40 resize-y"
            value={draft.instructions}
            disabled={saving}
            maxLength={32_000}
            placeholder="Describe the role, priorities, tone, and how this bot should approach work."
            onChange={(event) =>
              setDraft((current) => ({ ...current, instructions: event.target.value }))
            }
          />
        </label>
          </>
        ) : null}

        {step === 1 ? (
          <>
        {catalogQuery.isLoading || (bot && accessQuery.isLoading) ? (
          <Text as="p" variant="small" color="secondary">
            Loading access choices…
          </Text>
        ) : accessUnavailable ? (
          <Callout title="Access choices are unavailable">
            <div className="space-y-3">
              <Text as="p" variant="small" color="secondary">
                Aiden could not read this Mac’s Bot capability list, so access cannot be saved.
              </Text>
              <Button size="small" variant="filled" onClick={() => void catalogQuery.refetch()}>
                Try again
              </Button>
            </div>
          </Callout>
        ) : catalog && accessDraft ? (
          <FieldSet>
            <Field description="Custom Access can reduce the capabilities this bot may use.">
              <div className="flex gap-2" role="group" aria-label="Bot access mode">
                <Button
                  size="small"
                  variant={accessDraft.usesFullAccess ? "accent" : "filled"}
                  disabled={saving}
                  aria-pressed={accessDraft.usesFullAccess}
                  onClick={() =>
                    setAccessDraft((current) =>
                      current ? { ...current, usesFullAccess: true } : current)
                  }
                >
                  Full
                </Button>
                <Button
                  size="small"
                  variant={!accessDraft.usesFullAccess ? "accent" : "filled"}
                  disabled={saving}
                  aria-pressed={!accessDraft.usesFullAccess}
                  onClick={() =>
                    setAccessDraft((current) =>
                      current ? { ...current, usesFullAccess: false } : current)
                  }
                >
                  Custom
                </Button>
              </div>
            </Field>
            {accessDraft.usesFullAccess && !fullAccepted ? (
              <Callout title="Review Full Access">
                <div className="space-y-3">
                  <Text as="p" variant="small" color="secondary">
                    Full Access lets this bot use everything Aiden and your Mac currently allow,
                    including the shell, enabled connections, and skills. Credentials stay on your
                    Mac.
                  </Text>
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      variant="accent"
                      disabled={noticing}
                      onClick={() => void acknowledgeNotice("continue_full")}
                    >
                      Continue with Full Access
                    </Button>
                    <Button
                      size="small"
                      variant="filled"
                      disabled={noticing}
                      onClick={() => void acknowledgeNotice("customize_first")}
                    >
                      Customize first
                    </Button>
                  </div>
                </div>
              </Callout>
            ) : null}
          </FieldSet>
        ) : null}
          </>
        ) : null}

        {step === 1 ? (
          <>
            {catalogQuery.isLoading || (bot && accessQuery.isLoading) ? (
              <Text as="p" variant="small" color="secondary">
                Loading access choices…
              </Text>
            ) : accessUnavailable ? (
              <Text as="p" variant="small" color="secondary">
                Aiden could not read this Mac’s Bot capability list yet. Go back and try again.
              </Text>
            ) : catalog && accessDraft ? (
            <Field
              orientation="vertical"
              label="AI provider and model"
              description="This bot uses this provider and model in every chat. Credentials stay on your Mac."
            >
              <div className="grid gap-3">
                <Select
                  value={accessDraft.providerId ?? ""}
                  disabled={saving}
                  onValueChange={(providerId) => {
                    const provider = catalog.providers.find(
                      (candidate) => candidate.id === providerId,
                    );
                    const model = provider?.models.find((candidate) => candidate.available);
                    setAccessDraft((current) =>
                      current
                        ? (() => {
                            const vision = model?.supportsImages
                              ? undefined
                              : firstAvailableVisionModel(catalog, providerId);
                            return {
                              ...current,
                              providerId,
                              modelId: model?.id,
                              visionProviderId: vision?.providerId,
                              visionModelId: vision?.modelId,
                            };
                          })()
                        : current);
                  }}
                >
                  <SelectTrigger aria-label="AI provider for this bot">
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog.providers.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id} disabled={!provider.available}>
                        {provider.label}
                        {provider.available ? "" : " (unavailable)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={accessDraft.modelId ?? ""}
                  disabled={saving}
                  onValueChange={(modelId) => {
                    const model = selectedProvider?.models.find((candidate) => candidate.id === modelId);
                    setAccessDraft((current) => {
                      if (!current) return current;
                      const vision = model?.supportsImages
                        ? undefined
                        : (current.visionProviderId && current.visionModelId
                            ? {
                                providerId: current.visionProviderId,
                                modelId: current.visionModelId,
                              }
                            : firstAvailableVisionModel(catalog, selectedProvider?.id));
                      return {
                        ...current,
                        modelId,
                        visionProviderId: vision?.providerId,
                        visionModelId: vision?.modelId,
                      };
                    });
                  }}
                >
                  <SelectTrigger aria-label="AI model for this bot">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {(selectedProvider?.models ?? []).map((model) => (
                      <SelectItem key={model.id} value={model.id} disabled={!model.available}>
                        {model.label} <InlineMetadata>· {model.supportsImages ? "Vision" : "Text only"}{model.available ? "" : " (unavailable)"}</InlineMetadata>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedModel?.supportsImages === false ? (
                  <Callout title="Image understanding">
                    <div className="grid gap-3">
                      <Text as="p" variant="small" color="secondary">
                        {selectedModel.label} reads text only. Attached photos and screenshots will
                        be sent to the vision model you choose below; replies still come from the
                        primary model.
                      </Text>
                      {availableVisionProviders.length > 0 ? (
                        <>
                          <Select
                            value={accessDraft.visionProviderId ?? ""}
                            disabled={saving}
                            onValueChange={(providerId) => {
                              const provider = catalog.providers.find(({ id }) => id === providerId);
                              const model = provider?.models.find(
                                (candidate) => candidate.available && candidate.supportsImages,
                              );
                              setAccessDraft((current) => current ? {
                                ...current,
                                visionProviderId: providerId,
                                visionModelId: model?.id,
                              } : current);
                            }}
                          >
                            <SelectTrigger aria-label="Image understanding provider for this bot">
                              <SelectValue placeholder="Image provider" />
                            </SelectTrigger>
                            <SelectContent>
                              {availableVisionProviders.map((provider) => (
                                <SelectItem key={provider.id} value={provider.id}>
                                  {provider.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={accessDraft.visionModelId ?? ""}
                            disabled={saving}
                            onValueChange={(visionModelId) =>
                              setAccessDraft((current) => current
                                ? { ...current, visionModelId }
                                : current)}
                          >
                            <SelectTrigger aria-label="Image understanding model for this bot">
                              <SelectValue placeholder="Image model" />
                            </SelectTrigger>
                            <SelectContent>
                              {(selectedVisionProvider?.models ?? []).filter(
                                (model) => model.available && model.supportsImages,
                              ).map((model) => (
                                <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </>
                      ) : (
                        <Text as="p" variant="small" color="secondary">
                          No image-capable model is connected. Add one in Settings → Providers,
                          then refresh this Bot.
                        </Text>
                      )}
                      <Text as="p" variant="small" color="tertiary">
                        The attached image and a focused question go to this provider. Credentials
                        stay on your Mac.
                      </Text>
                    </div>
                  </Callout>
                ) : selectedModel?.supportsImages ? (
                  <Callout title="Native image understanding">
                    <Text as="p" variant="small" color="secondary">
                      {selectedModel.label} handles attached images directly.
                    </Text>
                  </Callout>
                ) : null}
              </div>
            </Field>
            ) : null}
          </>
        ) : null}

        {step === 1 ? (
          <details className="rounded-card bg-well p-3">
            <summary className="cursor-pointer rounded-control text-small-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">Customize files, commands and connections</summary>
            {accessDraft?.usesFullAccess ? (
              <Text as="p" variant="small" color="secondary">
                Full Access already allows every capability below. Switch to Custom Access above to choose specific ones.
              </Text>
            ) : null}
            {catalog && accessDraft ? (
              <FieldSet>
            <Field
              orientation="vertical"
              label="Files and commands"
              description="Choose which files the bot may work with and whether it may run commands on this Mac."
            >
              <ul className="space-y-1">
                {catalog.fileScopes
                  .filter((option) => option.available || accessDraft.fileScopeIds.includes(option.id))
                  .map((option) => {
                  const selected = accessDraft.fileScopeIds.includes(option.id);
                  return (
                    <li
                      key={option.id}
                      className="flex items-center justify-between gap-4 rounded-control px-3 py-2.5"
                    >
                      <span className="min-w-0">
                        <Text variant="small-strong">{option.label}</Text>
                        {option.description ? (
                          <Text as="p" variant="small" color="tertiary">
                            {option.description}
                          </Text>
                        ) : null}
                      </span>
                      <Switch
                        checked={accessDraft.usesFullAccess || selected}
                        disabled={saving || accessDraft.usesFullAccess || (!option.available && !selected)}
                        onCheckedChange={(checked) => toggleId("fileScopeIds", option.id, checked)}
                        aria-label={`Allow ${option.label} for this bot`}
                      />
                    </li>
                  );
                })}
                <li className="flex items-center justify-between gap-4 rounded-control px-3 py-2.5">
                  <span className="min-w-0">
                    <Text variant="small-strong">Run commands</Text>
                    <Text as="p" variant="small" color="tertiary">
                      Allows Aiden’s existing shell tool for this bot.
                    </Text>
                  </span>
                  <Switch
                    checked={accessDraft.usesFullAccess || accessDraft.shellEnabled}
                    disabled={saving || accessDraft.usesFullAccess || (!catalog.shellAvailable && !accessDraft.shellEnabled)}
                    onCheckedChange={(shellEnabled) =>
                      setAccessDraft((current) =>
                        current ? { ...current, shellEnabled } : current)
                    }
                    aria-label="Allow run commands for this bot"
                  />
                </li>
              </ul>
            </Field>
            {([
              ["Connections", "Services and accounts this bot may use.", catalog.connections, "connectionIds"],
              ["Skills", "Aiden skills this bot may use.", catalog.skills, "skillIds"],
              ["Other capabilities", "Additional capabilities available on this Mac.", catalog.otherCapabilities, "otherCapabilityIds"],
            ] as const).map(([title, description, options, key]) => {
              // Match iOS: hide unusable, unselected tombstones (e.g. skills
              // whose metadata failed validation) instead of surfacing rows
              // that can never be enabled.
              const visible = options.filter(
                (option) => option.available || accessDraft[key].includes(option.id),
              );
              return (
              <Field key={title} orientation="vertical" label={title} description={description}>
                {visible.length === 0 ? (
                  <Text as="p" variant="small" color="tertiary">
                    None available yet.
                  </Text>
                ) : (
                  <ul className="space-y-1">
                    {visible.map((option) => {
                      const selected = accessDraft[key].includes(option.id);
                      return (
                        <li
                          key={option.id}
                          className="flex items-center justify-between gap-4 rounded-control px-3 py-2.5"
                        >
                          <span className="min-w-0">
                            <Text variant="small-strong">{option.label}</Text>
                            {option.description ? (
                              <Text as="p" variant="small" color="tertiary">
                                {option.description}
                              </Text>
                            ) : null}
                          </span>
                          <Switch
                            checked={accessDraft.usesFullAccess || selected}
                            disabled={saving || accessDraft.usesFullAccess || (!option.available && !selected)}
                            onCheckedChange={(checked) => toggleId(key, option.id, checked)}
                            aria-label={`Allow ${option.label} for this bot`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Field>
              );
            })}
              </FieldSet>
            ) : null}
          </details>
        ) : null}

        {step === 1 && catalog && accessDraft ? (
          <div className="space-y-4">
            <dl className="space-y-3">
              {summaryRow("Name", draft.name.trim())}
              {draft.description.trim() ? summaryRow("Description", draft.description.trim()) : null}
              {summaryRow(
                "Access",
                accessDraft.usesFullAccess ? "Full Access" : "Custom Access",
              )}
              {selectedProvider && selectedModel
                ? summaryRow("Model", `${selectedProvider.label} · ${selectedModel.label}`)
                : null}
              {selectedModel?.supportsImages
                ? summaryRow("Images", `Handled by ${selectedModel.label}`)
                : selectedVisionProvider && selectedVisionModel
                  ? summaryRow(
                      "Images",
                      `${selectedVisionProvider.label} · ${selectedVisionModel.label}`,
                    )
                  : null}
              {accessDraft.usesFullAccess
                ? summaryRow("Capabilities", "Everything Aiden and this Mac allow")
                : summaryRow(
                    "Capabilities",
                    `${accessDraft.fileScopeIds.length} file scopes · `
                      + `${accessDraft.connectionIds.length} connections · `
                      + `${accessDraft.skillIds.length} skills`
                      + `${accessDraft.otherCapabilityIds.length
                        ? ` · ${accessDraft.otherCapabilityIds.length} other`
                        : ""}`,
                  )}
              {accessDraft.usesFullAccess || catalog.shellAvailable
                ? summaryRow(
                    "Commands",
                    accessDraft.usesFullAccess || accessDraft.shellEnabled ? "Allowed" : "Off",
                  )
                : null}
            </dl>
            <Text as="p" variant="small" color="tertiary">
              {bot
                ? "Saving applies these choices to every new turn with this bot."
                : "Creating applies these choices to every turn with this bot."}
              {" "}Credentials stay on your Mac.
            </Text>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function Roster({ bots, onCreate }: { bots: BotDefinition[]; onCreate(): void }) {
  const navigate = useNavigate();
  const active = bots.filter((bot) => bot.archivedAt === undefined);
  const archived = bots.filter((bot) => bot.archivedAt !== undefined);
  if (bots.length === 0) {
    return (
      <div className="space-y-4 text-center">
        <EmptyState
          title="Create your first bot"
          description="Create a bot with its own role, instructions, and ongoing conversation."
        />
        <Button variant="accent" onClick={onCreate}>
          <Plus /> Create a bot
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-8">
      {[
        { title: "Your bots", items: active },
        { title: "Archived", items: archived },
      ].map((group) =>
        group.items.length ? (
          <section key={group.title}>
            <Text as="h2" variant="small-strong" color="secondary">
              {group.title}
            </Text>
            <div className="mt-2 grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
              {group.items.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  className="flex min-h-28 items-start gap-3 rounded-card border border-field bg-well p-4 text-left outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:border-separator hover:bg-control-hover hover:shadow-control focus-visible:bg-control-hover"
                  onClick={() => navigate({ to: "/bots/$botId", params: { botId: bot.id } })}
                >
                  <BotAvatar botId={bot.id} avatar={bot.avatar} name={bot.name} photoLoading="visible" size="large" />
                  <span className="min-w-0 flex-1">
                    <Text as="span" variant="strong" className="block truncate">
                      {bot.name}
                    </Text>
                    <Text
                      as="span"
                      variant="small"
                      color="secondary"
                      className="mt-1 line-clamp-2 block"
                    >
                      {bot.description ?? "A reusable Pi-powered teammate."}
                    </Text>
                    {bot.archivedAt ? (
                      <Text as="span" variant="small" color="tertiary" className="mt-2 block">
                        Archived
                      </Text>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

function BotAccessSummary({ botId }: { botId: string }) {
  const accessQuery = useBotAccess(botId);
  const catalogQuery = useBotCapabilityCatalog(true);
  const state = accessQuery.data;
  const model = botModelLabel(catalogQuery.data, state);
  if (!state) return null;
  return (
    <section className="mt-6" aria-labelledby="bot-access-title">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Text id="bot-access-title" as="h2" variant="small-strong" color="secondary">
          Access
        </Text>
        <span className="rounded-pill bg-control px-2 py-0.5 text-mini font-medium text-secondary">
          {state.access.accessMode === "full" ? "Full Access" : "Custom Access"}
        </span>
        {model ? (
          <Text as="p" variant="small" color="secondary">
            {model}
          </Text>
        ) : null}
      </div>
      {state.access.accessMode === "custom" ? (
        <Text as="p" variant="small" color="tertiary" className="mt-1">
          {BOT_ACCESS_SUMMARIES.custom}
        </Text>
      ) : (
        <Text as="p" variant="small" color="tertiary" className="mt-1">
          {BOT_ACCESS_SUMMARIES.full}
        </Text>
      )}
    </section>
  );
}

export function BotsView() {
  const params = useParams({ strict: false }) as { botId?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { activeId } = useActiveWorkspace();
  const bots = useBots(true);
  const chats = useBotChats(params.botId);
  const telegramBinding = useBotTelegramBinding(params.botId);
  const selected = bots.data?.find((bot) => bot.id === params.botId);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editorBot, setEditorBot] = React.useState<BotDefinition | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [telegramOpen, setTelegramOpen] = React.useState(false);
  const [telegramTarget, setTelegramTarget] = React.useState("");
  const [telegramSaving, setTelegramSaving] = React.useState(false);
  const telegramTargets = useBotTelegramTargets(telegramOpen);

  const openCreate = () => {
    setEditorBot(null);
    setEditorOpen(true);
  };
  const openEdit = () => {
    if (selected) {
      setEditorBot(selected);
      setEditorOpen(true);
    }
  };
  const startConversation = async () => {
    if (!selected || !activeId || selected.archivedAt) return;
    setStarting(true);
    try {
      const chat = await botsApi.createChat({ botId: selected.id, workspaceId: activeId });
      await qc.invalidateQueries({ queryKey: queryKeys.botChats(selected.id) });
      await navigate({
        to: "/bots/$botId/chat/$chatId",
        params: { botId: selected.id, chatId: chat.id },
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Aiden could not start the conversation.",
      );
    } finally {
      setStarting(false);
    }
  };
  const toggleArchive = async () => {
    if (!selected) return;
    setArchiving(true);
    try {
      const next = selected.archivedAt
        ? await botsApi.restore({ id: selected.id, expectedRevision: selected.revision })
        : await botsApi.archive({ id: selected.id, expectedRevision: selected.revision });
      qc.setQueryData(queryKeys.bot(selected.id), next);
      if (!selected.archivedAt) qc.setQueryData(queryKeys.botTelegramBinding(selected.id), null);
      await qc.invalidateQueries({ queryKey: queryKeys.bots });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden could not update this bot.");
    } finally {
      setArchiving(false);
    }
  };
  const bindTelegram = async () => {
    if (!selected || !telegramTarget) return;
    const target = telegramTargets.data?.[Number(telegramTarget)];
    if (!target) return;
    setTelegramSaving(true);
    try {
      const binding = await botsApi.bindTelegram({
        botId: selected.id,
        profile: target.profile,
        ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
      });
      qc.setQueryData(queryKeys.botTelegramBinding(selected.id), binding);
      setTelegramOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Aiden could not bind this Telegram chat.",
      );
    } finally {
      setTelegramSaving(false);
    }
  };
  const unbindTelegram = async () => {
    if (!selected) return;
    setTelegramSaving(true);
    try {
      await botsApi.unbindTelegram(selected.id);
      qc.setQueryData(queryKeys.botTelegramBinding(selected.id), null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Aiden could not unbind this Telegram chat.",
      );
    } finally {
      setTelegramSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl px-8 pb-16 pt-16 max-[640px]:px-5">
        {params.botId ? (
          selected ? (
            <>
              <Button variant="transparent" size="small" onClick={() => navigate({ to: "/bots" })}>
                <ArrowLeft /> All bots
              </Button>
              <header className="mt-6 flex items-start justify-between gap-5 max-[680px]:flex-col">
                <div className="flex min-w-0 items-start gap-4">
                  <BotAvatar botId={selected.id} avatar={selected.avatar} name={selected.name} photoLoading="immediate" size="large" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Text as="h1" variant="heading1" className="truncate">
                        {selected.name}
                      </Text>
                      <span className="rounded-pill bg-control px-2 py-0.5 text-mini font-medium text-secondary">
                        Bot
                      </span>
                    </div>
                    <Text as="p" color="secondary" className="mt-1 max-w-2xl">
                      {selected.description ?? "A reusable Pi-powered teammate."}
                    </Text>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="filled" onClick={openEdit}>
                    <Pencil /> Edit
                  </Button>
                  <Button
                    variant="filled"
                    disabled={archiving}
                    onClick={() => void toggleArchive()}
                  >
                    {selected.archivedAt ? <RotateCcw /> : <Archive />}
                    {selected.archivedAt ? "Restore" : "Archive"}
                  </Button>
                </div>
              </header>
              {selected.archivedAt ? (
                <div className="mt-6 rounded-card border border-field bg-well px-4 py-3 text-regular text-secondary">
                  This bot is archived. Its conversations remain available, but it cannot start or
                  continue work until restored.
                </div>
              ) : null}
              <BotAccessSummary botId={selected.id} />
              <section className="mt-10" aria-labelledby="bot-conversations-title">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Text id="bot-conversations-title" as="h2" variant="strong">
                      Conversations
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1">
                      Each conversation keeps its own workspace, model, and Pi session.
                    </Text>
                  </div>
                  <Button
                    variant="accent"
                    disabled={!activeId || Boolean(selected.archivedAt) || starting}
                    onClick={() => void startConversation()}
                  >
                    <MessageSquarePlus /> {starting ? "Starting…" : "New conversation"}
                  </Button>
                </div>
                <div className="mt-4 overflow-hidden rounded-card border border-field bg-well">
                  {chats.isLoading ? (
                    <Text as="p" color="secondary" className="p-5">
                      Loading conversations…
                    </Text>
                  ) : chats.isError ? (
                    <div className="space-y-3 p-5">
                      <Text as="p" color="secondary">
                        Aiden could not load this bot’s conversations.
                      </Text>
                      <Button size="small" variant="filled" onClick={() => void chats.refetch()}>
                        <RotateCcw /> Try again
                      </Button>
                    </div>
                  ) : (chats.data?.length ?? 0) === 0 ? (
                    <EmptyState
                      placement="inline"
                      title="No conversations yet"
                      description="Start one in the active workspace when you are ready."
                    />
                  ) : (
                    chats.data?.map((chat, index) => (
                      <button
                        key={chat.id}
                        type="button"
                        className={`flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-control-hover focus-visible:bg-list-selection ${index ? "border-t border-separator" : ""}`}
                        onClick={() =>
                          navigate({
                            to: "/bots/$botId/chat/$chatId",
                            params: { botId: selected.id, chatId: chat.id },
                          })
                        }
                      >
                        <Bot className="size-4 text-secondary" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-regular text-primary">
                          {chat.title}
                        </span>
                        <span className="text-small text-tertiary">
                          {botChatDateFormatter.format(chat.updatedAt)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </section>
              <section className="mt-10" aria-labelledby="bot-instructions-title">
                <Text id="bot-instructions-title" as="h2" variant="small-strong" color="secondary">
                  Instructions
                </Text>
                <p className="mt-2 whitespace-pre-wrap rounded-card bg-well p-4 text-regular leading-6 text-primary">
                  {selected.instructions}
                </p>
              </section>
              <section
                className="mt-10 rounded-card border border-field bg-well p-4"
                aria-labelledby="bot-telegram-title"
              >
                <div className="flex items-center justify-between gap-4 max-[620px]:items-start max-[620px]:flex-col">
                  <div>
                    <Text id="bot-telegram-title" as="h2" variant="strong">
                      Telegram control
                    </Text>
                    <Text as="p" variant="small" color="secondary" className="mt-1">
                      {telegramBinding.isLoading
                        ? "Checking the one-to-one Telegram binding…"
                        : telegramBinding.isError
                          ? "Aiden could not load this bot’s Telegram binding."
                          : telegramBinding.data
                            ? `Bound to ${telegramBinding.data.profile}${telegramBinding.data.threadId ? ` · topic ${telegramBinding.data.threadId}` : " · direct message"}.`
                            : "Bind one paired Telegram chat to control this bot remotely."}
                    </Text>
                  </div>
                  {telegramBinding.isError ? (
                    <Button
                      variant="filled"
                      disabled={telegramBinding.isFetching}
                      onClick={() => void telegramBinding.refetch()}
                    >
                      <RotateCcw /> Try again
                    </Button>
                  ) : telegramBinding.data ? (
                    <Button
                      variant="filled"
                      disabled={telegramSaving || Boolean(selected.archivedAt)}
                      onClick={() => void unbindTelegram()}
                    >
                      <Unlink /> Unbind
                    </Button>
                  ) : (
                    <Button
                      variant="filled"
                      disabled={telegramBinding.isLoading || Boolean(selected.archivedAt)}
                      onClick={() => {
                        setTelegramTarget("");
                        setTelegramOpen(true);
                      }}
                    >
                      <Link2 /> Bind Telegram
                    </Button>
                  )}
                </div>
                <Text as="p" variant="small" color="tertiary" className="mt-3">
                  Tokens, owner pairing, model, and workspace stay managed in Settings → Telegram.
                </Text>
              </section>
            </>
          ) : bots.isLoading ? (
            <Text color="secondary">Loading bot…</Text>
          ) : (
            <EmptyState
              title="Bot not found"
              description="This bot may have been removed from local storage."
            />
          )
        ) : (
          <>
            <header className="flex items-end justify-between gap-4">
              <div>
                <Text as="h1" variant="heading1">
                  Bots
                </Text>
                <Text as="p" color="secondary" className="mt-1 max-w-2xl">
                  Create a bot for work you return to, with its own instructions and conversations.
                </Text>
              </div>
              <Button variant="accent" onClick={openCreate}>
                <Plus /> Create a bot
              </Button>
            </header>
            <div className="mt-8">
              {bots.isLoading ? (
                <Text color="secondary">Loading bots…</Text>
              ) : bots.isError ? (
                <div className="space-y-3 rounded-card bg-well p-5">
                  <Text as="p" color="secondary">
                    Aiden could not load your bots.
                  </Text>
                  <Button size="small" variant="filled" onClick={() => void bots.refetch()}>
                    <RotateCcw /> Try again
                  </Button>
                </div>
              ) : (
                <Roster bots={bots.data ?? []} onCreate={openCreate} />
              )}
            </div>
          </>
        )}
      </main>
      {editorOpen ? <BotEditor bot={editorBot} onOpenChange={setEditorOpen} /> : null}
      <Dialog
        open={telegramOpen}
        onOpenChange={setTelegramOpen}
        title="Bind Telegram chat"
        description="One exact direct message or private topic will route to this bot’s durable Pi conversation. A target can belong to only one bot."
        confirmLabel="Bind chat"
        confirmDisabled={!telegramTarget || telegramTargets.isLoading || telegramTargets.isError}
        busy={telegramSaving}
        onConfirm={bindTelegram}
      >
        {telegramTargets.isLoading ? (
          <Text color="secondary">Loading paired Telegram chats…</Text>
        ) : telegramTargets.isError ? (
          <div className="space-y-3">
            <Text color="secondary">Aiden could not load Telegram targets.</Text>
            <Button size="small" variant="filled" onClick={() => void telegramTargets.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : (telegramTargets.data?.length ?? 0) === 0 ? (
          <EmptyState
            placement="inline"
            title="No bindable Telegram chats"
            description="Add a bot token, pair its owner, and choose a folder workspace in Settings → Telegram first."
          />
        ) : (
          <label className="block">
            <Text variant="small-strong">Telegram target</Text>
            <Select value={telegramTarget} onValueChange={setTelegramTarget}>
              <SelectTrigger className="mt-1.5 w-full" aria-label="Telegram target">
                <SelectValue placeholder="Choose a chat" />
              </SelectTrigger>
              <SelectContent>
                {telegramTargets.data?.map((target, index) => (
                  <SelectItem
                    key={`${target.profile}:${target.threadId ?? "dm"}`}
                    value={String(index)}
                    disabled={!target.enabled || !target.workspaceId}
                  >
                    {target.label}
                    {target.workspaceName
                      ? ` · ${target.workspaceName}`
                      : " · choose workspace first"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
      </Dialog>
    </div>
  );
}
