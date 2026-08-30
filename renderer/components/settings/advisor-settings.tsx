import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../ui";
import { advisorApi } from "../../lib/ipc";
import { useProviders } from "../../lib/queries";
import {
  availableAdvisorProviders,
  supportedAdvisorEfforts,
} from "../../lib/advisor-settings-models";
import {
  ADVISOR_DISCLOSURE_VERSION,
  type AdvisorConfigurationV1,
  type AdvisorSelectionV1,
} from "../../shared/advisor";
import type { GenerationThinkingLevel } from "../../shared/generation-thinking";

const PROVIDER_DEFAULT = "provider-default";

function sameSelection(left: AdvisorSelectionV1 | null, right: AdvisorSelectionV1 | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function AdvisorSettings() {
  const providersQuery = useProviders();
  const providers = availableAdvisorProviders(providersQuery.data ?? []);
  const [configuration, setConfiguration] = React.useState<AdvisorConfigurationV1>();
  const [enabled, setEnabled] = React.useState(false);
  const [providerId, setProviderId] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [effort, setEffort] = React.useState(PROVIDER_DEFAULT);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    let current = true;
    void advisorApi
      .get()
      .then((next) => {
        if (!current) return;
        const selection = next.selection;
        setConfiguration(next);
        setEnabled(Boolean(selection));
        setProviderId(selection?.providerId ?? "");
        setModelId(selection?.modelId ?? "");
        setEffort(selection?.effort ?? PROVIDER_DEFAULT);
      })
      .catch(() => {
        if (current) setError("Aiden couldn’t read the local advisor selection.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  const provider = providers.find((candidate) => candidate.id === providerId);
  const models = provider?.models ?? [];
  const efforts = supportedAdvisorEfforts(provider, modelId);
  const providerUnavailable = Boolean(configuration?.selection && !provider);
  const modelUnavailable = Boolean(
    configuration?.selection && provider && !models.includes(configuration.selection.modelId),
  );
  const selectedUnavailable = providerUnavailable || modelUnavailable;
  const draft: AdvisorSelectionV1 | null =
    enabled && providerId && modelId
      ? {
          providerId,
          modelId,
          ...(effort === PROVIDER_DEFAULT
            ? {}
            : { effort: effort as Exclude<GenerationThinkingLevel, "off"> }),
          disabledForExecutors: configuration?.disabledForExecutors ?? [],
          disclosureVersion: ADVISOR_DISCLOSURE_VERSION,
        }
      : null;
  const dirty = configuration ? !sameSelection(configuration.selection, draft) : false;
  const canSave = !loading && !saving && dirty && (!enabled || Boolean(provider && modelId));

  const chooseProvider = (nextProviderId: string) => {
    const next = providers.find((candidate) => candidate.id === nextProviderId);
    const nextModel =
      next?.defaultModel && next.models.includes(next.defaultModel)
        ? next.defaultModel
        : (next?.models[0] ?? "");
    setProviderId(nextProviderId);
    setModelId(nextModel);
    setEffort(PROVIDER_DEFAULT);
    setError(undefined);
  };

  const toggle = (nextEnabled: boolean) => {
    setEnabled(nextEnabled);
    if (nextEnabled && !providerId && providers[0]) chooseProvider(providers[0].id);
    setError(undefined);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await advisorApi.set(draft);
      setConfiguration(next);
      toast.success(next.selection ? "Advisor reviewer saved." : "Advisor turned off.");
    } catch {
      const message = "Aiden couldn’t validate or save that advisor selection.";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldSet title="Advisor" className="model-pad-fieldset">
      <Field
        label="Second-opinion reviewer"
        description="Let the active chat model request one tool-free review when stronger judgment could materially reduce risk. Advisor stays off for background, Telegram, Bot, and child-agent runs."
        orientation="vertical"
        className="model-pad-field"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-72">
            <div className="flex items-center gap-2">
              <Text variant="small-strong">Use Advisor in attended chats</Text>
              {configuration?.selection && !dirty && !selectedUnavailable ? (
                <Badge className="gap-1">
                  <Check aria-hidden="true" className="size-3 text-green" />
                  Saved
                </Badge>
              ) : selectedUnavailable ? (
                <Badge color="red">Unavailable</Badge>
              ) : null}
            </div>
            <Text as="p" variant="small" color="secondary" className="mt-1 text-pretty">
              The executor decides whether a consultation is worthwhile; each response allows at
              most one.
            </Text>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            aria-label="Use Advisor in attended chats"
            disabled={loading || saving || (!enabled && providers.length === 0)}
          />
        </div>

        {enabled ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1.5 text-small-strong text-primary">
              Provider
              <Select value={providerId} onValueChange={chooseProvider} disabled={saving}>
                <SelectTrigger size="small" aria-label="Advisor provider">
                  <SelectValue placeholder="Choose a provider…" />
                </SelectTrigger>
                <SelectContent>
                  {providerUnavailable && configuration?.selection ? (
                    <SelectItem value={configuration.selection.providerId} disabled>
                      {configuration.selection.providerId} · Unavailable
                    </SelectItem>
                  ) : null}
                  {providers.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-small-strong text-primary">
              Model
              <Select
                value={modelId}
                onValueChange={(value) => {
                  setModelId(value);
                  setEffort(PROVIDER_DEFAULT);
                  setError(undefined);
                }}
                disabled={!provider || saving}
              >
                <SelectTrigger size="small" aria-label="Advisor model">
                  <SelectValue placeholder="Choose a model…" />
                </SelectTrigger>
                <SelectContent>
                  {modelUnavailable && configuration?.selection ? (
                    <SelectItem value={configuration.selection.modelId} disabled>
                      {configuration.selection.modelId} · Unavailable
                    </SelectItem>
                  ) : null}
                  {models.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-small-strong text-primary">
              Reasoning
              <Select value={effort} onValueChange={setEffort} disabled={!modelId || saving}>
                <SelectTrigger size="small" aria-label="Advisor reasoning effort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PROVIDER_DEFAULT}>Provider default</SelectItem>
                  {efforts.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level[0]?.toLocaleUpperCase()}
                      {level.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        ) : null}

        <Callout
          className="mt-4"
          role={error ? "alert" : "status"}
          color={error ? "red" : undefined}
        >
          <Text as="p" variant="small" color={error ? "red" : "secondary"}>
            {error ??
              (enabled
                ? `A consultation sends surviving user, tool-result, tool-inventory, and supported-image evidence to ${provider?.label ?? "the selected provider"}. Aiden omits hidden reasoning, never attaches its provider credentials, and redacts high-confidence credential strings in text, but forwarded content can still contain sensitive data. The reviewer gets no tools, and the consultation counts as a separate provider request.`
                : providers.length === 0 && !loading
                  ? "Connect a provider with at least one chat model before enabling Advisor."
                  : "No reviewer context or prompt is added while Advisor is off.")}
          </Text>
        </Callout>

        <div className="mt-3 flex justify-end">
          <Button size="small" variant="accent" onClick={() => void save()} disabled={!canSave}>
            {saving ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Check />}
            {saving ? "Validating…" : "Save Advisor"}
          </Button>
        </div>
      </Field>
    </FieldSet>
  );
}
