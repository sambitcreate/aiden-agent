// Telegram settings — bot token, enable toggle, pairing status, provider/model
// picker, and connection controls. The bot token is stored encrypted via
// safeStorage and never returned to the renderer.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Field,
  FieldSet,
  Input,
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

export function TelegramSettings() {
  const qc = useQueryClient();
  const telegram = useTelegramSettings();
  const providers = useProviders();
  const workspaces = useWorkspaces();
  const [keyDraft, setKeyDraft] = React.useState("");

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
  const workspaceOptions = telegramWorkspaceOptions(
    workspaces.data ?? [],
    telegramWorkspaceId,
  );
  const folderWorkspaceCount = workspaceOptions.filter(
    (workspace) =>
      workspace.value !== TELEGRAM_ASSISTANT_ONLY_VALUE && !workspace.unavailable,
  ).length;

  const saveKey = async () => {
    const value = keyDraft.trim();
    await telegramApi.setKey(value);
    setKeyDraft("");
    await invalidate();
    toast.success(value ? "Telegram bot token saved." : "Telegram bot token removed and bridge disabled.");
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
  }) => {
    try {
      await telegramApi.setExperience({
        thinkingLevel: patch.thinkingLevel ?? thinkingLevel,
        draftPreviews: patch.draftPreviews ?? draftPreviews,
        activity: patch.activity ?? activity,
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

  const selectedProvider = usableProviders.find((p) => p.id === telegramProviderId);
  const selectedModel = telegramModel || selectedProvider?.defaultModel || selectedProvider?.models[0] || "";

  return (
    <FieldSet title="Telegram Agent">
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
                const model = provider?.defaultModel ?? provider?.models[0] ?? "";
                void saveProvider(pid, model);
              }}
            >
              <SelectTrigger size="small" aria-label="Telegram provider">
                <SelectValue placeholder="Choose a provider…" />
              </SelectTrigger>
              <SelectContent>
                {usableProviders.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProvider && selectedProvider.models.length > 1 && (
              <Select
                value={selectedModel}
                onValueChange={(model) => void saveProvider(telegramProviderId, model)}
              >
                <SelectTrigger size="small" aria-label="Telegram model">
                  <SelectValue placeholder="Choose a model…" />
                </SelectTrigger>
                <SelectContent>
                  {selectedProvider.models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Configure at least one provider in Settings → Providers, then return here to select it for Telegram.
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
        description="Edit one Telegram message while Aiden answers, then replace it with the final response. Off by default for a quieter chat."
      >
        <Switch
          checked={draftPreviews}
          onCheckedChange={(checked) => void saveExperience({ draftPreviews: checked })}
        />
      </Field>

      <Field
        label="Technical activity"
        description="Choose whether Telegram shows provider reasoning, completed tool activity, both, or neither."
      >
        <Select
          value={activity}
          onValueChange={(value) =>
            void saveExperience({ activity: value as typeof activity })
          }
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
        <Field label="Connection" description="Start or stop polling. Polling runs in the background even when the Aiden window is closed.">
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
        <Field label="Paired owner" description="The Telegram account currently authorized to control Aiden.">
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

      <Field label="How to connect">
        <ol className="text-muted-foreground list-decimal space-y-1 pl-4 text-sm">
          <li>Open Telegram and message <strong>@BotFather</strong>.</li>
          <li>Send <code>/newbot</code> and follow the prompts to create a bot.</li>
          <li>Copy the bot token and paste it above, then Save.</li>
          <li>Choose a provider above (or set one up in Settings → Providers).</li>
          <li>Toggle Enable, then send <code>/start</code> to your bot from Telegram to pair.</li>
        </ol>
      </Field>

      <Field
        label="⚠ Security notice"
        description="Telegram turns run with full unattended authority — no approval prompts. Only the paired owner can trigger turns. Disconnect or disable to stop immediately."
      >
        <p className="text-muted-foreground text-sm">
          This is the same trust boundary as scheduled tasks: the paired owner can run
          mutating tools silently from their phone. Keep the bot private.
        </p>
      </Field>
    </FieldSet>
  );
}
