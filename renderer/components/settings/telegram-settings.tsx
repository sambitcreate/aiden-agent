// Telegram settings — bot token, enable toggle, pairing status, provider/model
// picker, and connection controls. The bot token is stored encrypted via
// safeStorage and never returned to the renderer.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
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
  toast,
} from "../ui";
import { telegramApi } from "../../lib/ipc";
import {
  queryKeys,
  useProviders,
  useSettings,
  useTelegramSettings,
  useWorkspaces,
} from "../../lib/queries";
import {
  TELEGRAM_ASSISTANT_ONLY_VALUE,
  telegramWorkspaceOptions,
} from "../../lib/telegram-workspace-options";
import {
  GENERATION_THINKING_LEVELS,
  type GenerationThinkingLevel,
} from "../../shared/generation-thinking";
import { isModelHidden } from "../../shared/model-visibility";

export function TelegramSettings() {
  const qc = useQueryClient();
  const telegram = useTelegramSettings();
  const providers = useProviders();
  const settings = useSettings();
  const workspaces = useWorkspaces();
  const [keyDraft, setKeyDraft] = React.useState("");
  const [profileDraft, setProfileDraft] = React.useState("");
  const [deleteProfileOpen, setDeleteProfileOpen] = React.useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.telegram });
  const enabled = telegram.data?.enabled ?? false;
  const hasToken = telegram.data?.hasToken ?? false;
  const allowedUserId = telegram.data?.allowedUserId;
  const polling = telegram.data?.polling ?? false;
  const lastError = telegram.data?.lastError;
  const queuedCount = telegram.data?.queuedCount ?? 0;
  const telegramProviderId = telegram.data?.providerId ?? "";
  const telegramModel = telegram.data?.model ?? "";
  const telegramWorkspaceId = telegram.data?.workspaceId;
  const thinkingLevel = telegram.data?.thinkingLevel ?? "medium";
  const draftPreviews = telegram.data?.draftPreviews ?? false;
  const activity = telegram.data?.activity ?? "quiet";
  const rendering = telegram.data?.rendering ?? "rich";
  const voiceMode = telegram.data?.voiceMode ?? "hidden";
  const threadedMode = telegram.data?.threadedMode ?? false;
  const activeProfile = telegram.data?.activeProfile ?? "default";
  const profiles = telegram.data?.profiles ?? [];
  const workspaceOptions = telegramWorkspaceOptions(workspaces.data ?? [], telegramWorkspaceId);
  const folderWorkspaceCount = workspaceOptions.filter(
    (workspace) => workspace.value !== TELEGRAM_ASSISTANT_ONLY_VALUE && !workspace.unavailable,
  ).length;

  const saveKey = async () => {
    const value = keyDraft.trim();
    await telegramApi.setKey(value);
    setKeyDraft("");
    await invalidate();
    toast.success(
      value ? "Telegram bot token saved." : "Telegram bot token removed and bridge disabled.",
    );
  };

  const toggle = async (value: boolean) => {
    await telegramApi.setEnabled(value);
    await invalidate();
  };

  const connect = async () => {
    try {
      await telegramApi.connect();
      await invalidate();
      toast.success("Telegram bridge connected.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to connect.");
    }
  };

  const disconnect = async () => {
    await telegramApi.disconnect();
    await invalidate();
    toast.success("Telegram bridge disconnected.");
  };

  const resetPairing = async () => {
    await telegramApi.resetPairing();
    await invalidate();
    toast.success("Pairing reset. The next /start will claim a new owner.");
  };

  const selectProfile = async (profile: string) => {
    await telegramApi.selectProfile(profile);
    setKeyDraft("");
    await invalidate();
  };

  const createProfile = async () => {
    const profile = profileDraft.trim().toLowerCase();
    if (!profile) return;
    try {
      await telegramApi.createProfile(profile);
      setProfileDraft("");
      await invalidate();
      toast.success(`Telegram profile ${profile} created.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create Telegram profile.");
    }
  };

  const deleteProfile = async () => {
    if (activeProfile === "default") return;
    await telegramApi.deleteProfile(activeProfile);
    await invalidate();
    toast.success(`Telegram profile ${activeProfile} deleted.`);
  };

  const saveProvider = async (providerId: string, model: string) => {
    await telegramApi.setProvider(providerId, model);
    await invalidate();
    toast.success("Telegram provider saved.");
  };

  const saveWorkspace = async (workspaceId: string) => {
    try {
      await telegramApi.setWorkspace(
        workspaceId === TELEGRAM_ASSISTANT_ONLY_VALUE ? undefined : workspaceId,
      );
      await invalidate();
      toast.success(
        workspaceId === TELEGRAM_ASSISTANT_ONLY_VALUE
          ? "Telegram workspace scope cleared."
          : "Telegram workspace scope saved.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save Telegram workspace scope.",
      );
    }
  };

  const saveExperience = async (patch: {
    thinkingLevel?: GenerationThinkingLevel;
    draftPreviews?: boolean;
    activity?: "quiet" | "thinking" | "tools" | "verbose";
    rendering?: "rich" | "html";
    voiceMode?: "hidden" | "mirror" | "always";
    threadedMode?: boolean;
  }) => {
    try {
      await telegramApi.setExperience({
        thinkingLevel: patch.thinkingLevel ?? thinkingLevel,
        draftPreviews: patch.draftPreviews ?? draftPreviews,
        activity: patch.activity ?? activity,
        rendering: patch.rendering ?? rendering,
        voiceMode: patch.voiceMode ?? voiceMode,
        threadedMode: patch.threadedMode ?? threadedMode,
      });
      await invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save Telegram controls.");
    }
  };

  // Providers that have at least one model and a key (or don't need one).
  const usableProviders = (providers.data ?? []).filter(
    (p) => p.models.length > 0 && (p.hasKey || !p.needsKey),
  );

  const visibleModelsForProvider = (provider: (typeof usableProviders)[number]) =>
    provider.models.filter(
      (modelId) => !isModelHidden(settings.data?.hiddenModelsByProvider, provider.id, modelId),
    );

  const selectableProviders = usableProviders.filter(
    (provider) =>
      visibleModelsForProvider(provider).length > 0 || provider.id === telegramProviderId,
  );

  const selectedProvider = usableProviders.find((p) => p.id === telegramProviderId);
  const visibleModels = selectedProvider ? visibleModelsForProvider(selectedProvider) : [];
  const currentHiddenModel =
    selectedProvider &&
    telegramModel &&
    isModelHidden(settings.data?.hiddenModelsByProvider, selectedProvider.id, telegramModel)
      ? telegramModel
      : undefined;
  const selectedModel =
    telegramModel ||
    (selectedProvider?.defaultModel && visibleModels.includes(selectedProvider.defaultModel)
      ? selectedProvider.defaultModel
      : visibleModels[0]) ||
    "";

  return (
    <FieldSet title="Telegram Agent">
      <Field
        label="Bot profile"
        description="Each profile has an isolated bot token, owner, offset, workspace routing, and polling lease."
      >
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Select value={activeProfile} onValueChange={(profile) => void selectProfile(profile)}>
              <SelectTrigger size="small" aria-label="Telegram bot profile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((profile) => (
                  <SelectItem key={profile.name} value={profile.name}>
                    {profile.name}
                    {profile.status.status === "polling" ? (
                      <>
                        {" "}
                        <InlineMetadata>· connected</InlineMetadata>
                      </>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeProfile !== "default" && (
              <Button size="small" variant="destructive" onClick={() => setDeleteProfileOpen(true)}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={profileDraft}
              onChange={(event) => setProfileDraft(event.target.value)}
              placeholder="New profile name"
              aria-label="New Telegram profile name"
            />
            <Button
              size="small"
              variant="muted"
              onClick={() => void createProfile()}
              disabled={!profileDraft.trim()}
            >
              Add profile
            </Button>
          </div>
        </div>
      </Field>

      <Field
        label="Enable Telegram bridge"
        description={
          hasToken
            ? "When enabled, Aiden polls Telegram and responds to messages from your paired phone as a headless, full-access agent."
            : "Add a bot token below before enabling the bridge."
        }
      >
        <Switch checked={enabled} onCheckedChange={toggle} disabled={!hasToken} />
      </Field>

      <Field
        label="Bot token"
        description={
          hasToken
            ? "A token is saved. Enter a new value to replace it."
            : "Create a bot via @BotFather in Telegram, then paste the token here. Stored encrypted on this device."
        }
      >
        <div className="flex gap-2">
          <Input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={hasToken ? "••••••••••••" : "Paste your bot token from @BotFather"}
          />
          <Button
            size="medium"
            variant={!keyDraft.trim() && hasToken ? "destructive" : "filled"}
            onClick={saveKey}
            disabled={!keyDraft.trim() && !hasToken}
          >
            {keyDraft.trim() ? (hasToken ? "Replace" : "Save") : "Remove"}
          </Button>
        </div>
      </Field>

      <Field
        label="Workspace"
        description="Project automation runs only in this folder. Assistant-only mode cannot access project files or tools."
      >
        <Select
          value={telegramWorkspaceId ?? TELEGRAM_ASSISTANT_ONLY_VALUE}
          onValueChange={(workspaceId) => void saveWorkspace(workspaceId)}
        >
          <SelectTrigger size="small" aria-label="Telegram workspace">
            <SelectValue placeholder="Assistant-only mode" />
          </SelectTrigger>
          <SelectContent>
            {workspaceOptions.map((workspace) => (
              <SelectItem
                key={workspace.value}
                value={workspace.value}
                disabled={workspace.unavailable}
              >
                {workspace.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {folderWorkspaceCount === 0 && (
          <p className="text-muted-foreground text-sm">
            Add a folder workspace in Settings → Workspaces to enable project automation.
          </p>
        )}
      </Field>

      <Field
        label="Provider"
        description={
          usableProviders.length > 0
            ? "The AI provider and model used for Telegram turns."
            : "No providers configured. Go to Settings → Providers to add one."
        }
      >
        {usableProviders.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Select
              value={telegramProviderId}
              onValueChange={(pid) => {
                const provider = usableProviders.find((p) => p.id === pid);
                if (!provider) return;
                const models = visibleModelsForProvider(provider);
                const model =
                  provider.defaultModel && models.includes(provider.defaultModel)
                    ? provider.defaultModel
                    : models[0];
                if (model) void saveProvider(pid, model);
              }}
            >
              <SelectTrigger size="small" aria-label="Telegram provider">
                <SelectValue placeholder="Choose a provider…" />
              </SelectTrigger>
              <SelectContent>
                {selectableProviders.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProvider &&
              visibleModels.length > 0 &&
              (visibleModels.length > 1 || Boolean(currentHiddenModel)) && (
                <Select
                  value={selectedModel}
                  onValueChange={(model) => void saveProvider(telegramProviderId, model)}
                >
                  <SelectTrigger size="small" aria-label="Telegram model">
                    <SelectValue placeholder="Choose a model…">
                      {currentHiddenModel ? (
                        <>
                          {currentHiddenModel} <InlineMetadata>· Hidden</InlineMetadata>
                        </>
                      ) : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {visibleModels.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            {selectedProvider && visibleModels.length === 0 && currentHiddenModel ? (
              <p className="text-muted-foreground text-sm">
                {currentHiddenModel} is hidden. Show a model in Provider Settings before changing
                this bot's model.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Configure at least one provider in Settings → Providers, then return here to select it
            for Telegram.
          </p>
        )}
      </Field>

      <Field
        label="Thinking level"
        description="Reasoning effort for Telegram turns. The selected model safely normalizes unsupported levels."
      >
        <Select
          value={thinkingLevel}
          onValueChange={(value) =>
            void saveExperience({ thinkingLevel: value as GenerationThinkingLevel })
          }
        >
          <SelectTrigger size="small" aria-label="Telegram thinking level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GENERATION_THINKING_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Live answer drafts"
        description="Stream structurally complete Telegram-native Rich Drafts while Aiden answers; the persisted final reply completes the preview lifecycle."
      >
        <Switch
          checked={draftPreviews}
          onCheckedChange={(checked) => void saveExperience({ draftPreviews: checked })}
        />
      </Field>

      <Field
        label="Assistant rendering"
        description="Native Rich Markdown preserves Telegram formatting; HTML remains a compatibility fallback."
      >
        <Select
          value={rendering}
          onValueChange={(value) => void saveExperience({ rendering: value as typeof rendering })}
        >
          <SelectTrigger size="small" aria-label="Telegram assistant rendering">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rich">Native Rich Markdown</SelectItem>
            <SelectItem value="html">Legacy HTML</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Voice replies"
        description="Hidden sends voice only when explicitly requested. Mirror follows voice input; Always replaces automatic text replies with voice when synthesis succeeds and falls back to text on failure."
      >
        <Select
          value={voiceMode}
          onValueChange={(value) => void saveExperience({ voiceMode: value as typeof voiceMode })}
        >
          <SelectTrigger size="small" aria-label="Telegram voice reply policy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hidden">Hidden / explicit only</SelectItem>
            <SelectItem value="mirror">Mirror voice input</SelectItem>
            <SelectItem value="always">Always</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Private-chat threads"
        description="Create one Telegram topic per configured Aiden workspace and route each topic only to that workspace. Enable Threaded Mode for the bot in @BotFather first."
      >
        <Switch
          checked={threadedMode}
          onCheckedChange={(checked) => void saveExperience({ threadedMode: checked })}
        />
      </Field>

      <Field
        label="Technical activity"
        description="Choose whether Telegram shows provider reasoning, completed tool activity, both, or neither."
      >
        <Select
          value={activity}
          onValueChange={(value) => void saveExperience({ activity: value as typeof activity })}
        >
          <SelectTrigger size="small" aria-label="Telegram technical activity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="quiet">Quiet</SelectItem>
            <SelectItem value="thinking">Thinking</SelectItem>
            <SelectItem value="tools">Tools</SelectItem>
            <SelectItem value="verbose">Thinking and tools</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {hasToken && (
        <Field
          label="Connection"
          description="Start or stop polling. Polling runs in the background even when the Aiden window is closed."
        >
          <div className="flex items-center gap-3">
            <Button size="medium" variant="filled" onClick={connect} disabled={polling}>
              Connect
            </Button>
            <Button size="medium" variant="muted" onClick={disconnect} disabled={!polling}>
              Disconnect
            </Button>
            <span className="text-muted-foreground text-sm">
              {polling ? "● Polling" : "○ Idle"}
              {queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
            </span>
          </div>
        </Field>
      )}

      {allowedUserId !== undefined && (
        <Field
          label="Paired owner"
          description="The Telegram account currently authorized to control Aiden."
        >
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-sm">User ID: {allowedUserId}</span>
            <Button size="small" variant="muted" onClick={resetPairing}>
              Reset pairing
            </Button>
          </div>
        </Field>
      )}

      {lastError && (
        <Field label="Last error">
          <p className="text-destructive text-sm">{lastError}</p>
        </Field>
      )}

      {(telegram.data?.recentDiagnostics.length ?? 0) > 0 && (
        <Field
          label="Recent diagnostics"
          description="Redacted, process-local transport and recovery events for this profile."
        >
          <div className="space-y-1 text-sm text-muted-foreground">
            {telegram.data?.recentDiagnostics
              .slice(-5)
              .reverse()
              .map((event) => (
                <p key={`${event.at}-${event.message}`}>
                  [{event.level}] {event.message}
                </p>
              ))}
          </div>
        </Field>
      )}

      <Field label="How to connect">
        <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-sm">
          <li>
            Open Telegram and message <strong>@BotFather</strong>.
          </li>
          <li>
            Send <code>/newbot</code> and follow the prompts to create a bot.
          </li>
          <li>Copy the bot token and paste it above, then Save.</li>
          <li>
            If you want workspace topics, enable Threaded Mode for the bot in{" "}
            <strong>@BotFather</strong>.
          </li>
          <li>Choose a provider above (or set one up in Settings → Providers).</li>
          <li>
            Toggle Enable, then send <code>/start</code> to your bot from Telegram to pair.
          </li>
        </ol>
      </Field>

      <Field
        label="⚠ Security notice"
        description="Telegram turns run with full unattended authority — no approval prompts. Only the paired owner can trigger turns. Disconnect or disable to stop immediately."
      >
        <p className="text-muted-foreground text-sm">
          This is the same trust boundary as scheduled tasks: the paired owner can run mutating
          tools silently from their phone. Keep the bot private.
        </p>
      </Field>

      <AlertDialog
        open={deleteProfileOpen}
        onOpenChange={setDeleteProfileOpen}
        title={`Delete Telegram profile “${activeProfile}”?`}
        description="The profile token and owner binding will be removed. The default profile is unaffected."
        confirmLabel="Delete profile"
        confirmVariant="destructive"
        onConfirm={() => void deleteProfile()}
      />
    </FieldSet>
  );
}
