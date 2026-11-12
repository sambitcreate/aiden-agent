import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Callout,
  Field,
  FieldSet,
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
} from "../ui";
import { InfoHint } from "../ui-info-hint";
import { settingsApi } from "../../lib/ipc";
import { isUsable } from "../../lib/model-picker-data";
import { queryKeys, useProviders, useSettings } from "../../lib/queries";
import type { AppSettings } from "../../lib/types";
import { botRoutinesGoAhead } from "../../shared/bot-rules";
import {
  APPROVAL_MODE_HELP,
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  effectiveApprovalMode,
  parseApprovalModel,
  type ApprovalMode,
} from "../../shared/approval-mode";

const CHAT_MODEL = "chat";
const modelValue = (providerId: string, model: string) => `${providerId}::${model}`;

/** Saves a settings patch, showing it at once and rolling it back if saving fails. */
function useSettingsPatch() {
  const queryClient = useQueryClient();
  const [saving, setSaving] = React.useState(false);
  const save = async (patch: Omit<Partial<AppSettings>, "approvalModel"> & { approvalModel?: AppSettings["approvalModel"] | null }, failure: string) => {
    const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => {
      const next = { ...(current ?? {}), ...patch } as AppSettings & { approvalModel?: unknown };
      if (patch.approvalModel === null) delete next.approvalModel;
      return next as AppSettings;
    });
    setSaving(true);
    try {
      queryClient.setQueryData<AppSettings>(queryKeys.settings, await settingsApi.set(patch as Partial<AppSettings>));
    } catch {
      queryClient.setQueryData(queryKeys.settings, previous);
      toast.error(failure);
    } finally {
      setSaving(false);
    }
  };
  return { save, saving };
}

/**
 * Settings → Approvals (plan §3.1): one mode for the whole Mac. Auto shows only
 * when a usable model exists. A one-time note explains what changed for an
 * install that was already in use, and Advanced holds the approval model and
 * the legacy routines switch for people who had it on.
 */
export function ApprovalModeSettings({ children }: { /** The rules page, under the mode and above Advanced. */ children?: React.ReactNode } = {}) {
  const settings = useSettings();
  const providers = useProviders();
  const { save, saving } = useSettingsPatch();
  const usable = (providers.data ?? []).filter(isUsable);
  const usableModel = usable.length > 0;
  const mode = effectiveApprovalMode(settings.data, usableModel);
  const modes = APPROVAL_MODES.filter((value) => value !== "auto" || usableModel);
  const showChanges = settings.data?.approvalModeOrigin === "upgrade" && settings.data.approvalChangesSeen !== true;
  const legacyRoutines = botRoutinesGoAhead(settings.data);
  const approvalModel = parseApprovalModel(settings.data?.approvalModel);
  const modelChoice = approvalModel ? modelValue(approvalModel.providerId, approvalModel.model) : CHAT_MODEL;

  const choose = (next: ApprovalMode) => {
    if (next === mode && settings.data?.approvalMode !== undefined) return;
    void save({ approvalMode: next }, "Couldn't change approvals.");
  };

  return (
    <>
      {showChanges ? (
        <Callout role="note" aria-label="What changed" className="mb-7 gap-2 p-4">
          <Text variant="strong">What changed</Text>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-small text-secondary">
            <li>Approvals now follow one mode for this Mac. You're on {APPROVAL_MODE_LABELS[mode]}, so Aiden asks as before.</li>
            <li>Auto lets a model approve routine actions and ask you about the rest. It's your choice and never turns on by itself.</li>
            <li>Workspaces with Full access now use Never ask, with commands and file changes still allowed there.</li>
            <li>A routine no longer waits for your OK. A step that needs it is skipped and the Bot tells you.</li>
          </ul>
          <div>
            <Button size="small" variant="filled" onClick={() => void save({ approvalChangesSeen: true }, "Couldn't save that.")}>
              Got it
            </Button>
          </div>
        </Callout>
      ) : null}
      <FieldSet
        title="When Aiden asks"
        hint={
          <InfoHint topic="approval modes">
            Every Bot and workspace follows this, unless a workspace has its own in Workspace settings. Purchases, passwords and money always come to you.
          </InfoHint>
        }
      >
        <RadioGroup
          orientation="vertical"
          aria-label="Approval mode"
          value={mode}
          onValueChange={(value) => choose(value as ApprovalMode)}
          disabled={settings.isLoading}
          aria-busy={saving}
          className="gap-1 p-2"
        >
          {modes.map((value) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 transition-colors hover:bg-control-hover ${mode === value ? "bg-control" : ""}`}
            >
              <RadioGroupItem
                value={value}
                aria-label={APPROVAL_MODE_LABELS[value]}
                className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
              />
              <span className="flex flex-col gap-1">
                <Text>{APPROVAL_MODE_LABELS[value]}</Text>
                <Text as="span" variant="small" color="secondary">
                  {APPROVAL_MODE_HELP[value]}
                </Text>
              </span>
            </label>
          ))}
        </RadioGroup>
        {!usableModel && !providers.isLoading ? (
          <Text as="p" variant="small" color="secondary" className="px-4 pb-4 text-pretty">
            Auto appears once a model is connected in Providers.
          </Text>
        ) : null}
      </FieldSet>
      {children}
      <FieldSet title="Advanced">
        <Field
          label="Approval model"
          description="The model Auto asks before an action runs. By default it's the chat's own model, or for a Bot the Bot's own model, so nothing goes anywhere the chat or Bot wasn't already using. Each action it reviews is sent to this model, with typed text, passwords and card details left out."
        >
          <Select
            value={modelChoice}
            disabled={!usableModel}
            onValueChange={(value) => {
              if (value === modelChoice) return;
              if (value === CHAT_MODEL) {
                void save({ approvalModel: null }, "Couldn't change the approval model.");
                return;
              }
              const [providerId, ...rest] = value.split("::");
              void save({ approvalModel: { providerId: providerId!, model: rest.join("::") } }, "Couldn't change the approval model.");
            }}
          >
            <SelectTrigger aria-label="Approval model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CHAT_MODEL}>The chat's model</SelectItem>
              {usable.flatMap((provider) =>
                provider.models.map((model) => (
                  <SelectItem key={modelValue(provider.id, model)} value={modelValue(provider.id, model)}>
                    {`${provider.label} · ${model}`}
                  </SelectItem>
                )),
              )}
              {approvalModel && !usable.some((provider) => provider.id === approvalModel.providerId && provider.models.includes(approvalModel.model)) ? (
                <SelectItem value={modelChoice}>{`${approvalModel.model} (unavailable)`}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </Field>
        {legacyRoutines ? (
          <Field
            label="Routines go ahead without asking"
            description="An older setting you turned on: routines run Ask first steps and connected-app changes without your OK. Once off, it can't be turned back on; use Never ask instead."
          >
            <Switch
              aria-label="Let routines go ahead without asking"
              checked
              disabled={saving}
              onCheckedChange={(next) => {
                if (!next) void save({ botRoutinesGoAhead: false }, "Couldn't change how routines handle these steps.");
              }}
            />
          </Field>
        ) : null}
      </FieldSet>
    </>
  );
}
