// Settings → Image Generation: dedicated provider keys, the default image
// model, and the per-model inventory. Keys only go in; the state that comes
// back never holds them. Every action replaces local state with the state the
// main process returns. Actions run independently: each one locks only its own
// controls (one provider's key or fetch, one model row), never the whole page.

import * as React from "react";
import { KeyRound, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Field,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../ui";
import { imageGenerationApi } from "../../lib/ipc";
import { formatRelativeTime } from "../../lib/relative-time";
import { ImageModelLogo, ImageProviderLogo } from "../image-model-logo";
import {
  FAL_REFERENCE_FIELDS,
  IMAGE_GENERATION_LIMITS,
  IMAGE_GENERATION_PROVIDER_IDS,
  IMAGE_GENERATION_PROVIDER_NAMES,
  REPLICATE_REFERENCE_FIELDS,
  type ImageGenerationActionResult,
  type ImageGenerationAddCustomModelRequest,
  type ImageGenerationModelView,
  type ImageGenerationProviderId,
  type ImageGenerationProviderView,
  type ImageGenerationState,
  type ImageModelRef,
} from "../../shared/image-generation/types";

/** Rows rendered before "Show more"; fetched catalogs can hold hundreds. */
const MODEL_ROW_PAGE = 200;
const AUTOMATIC = "__automatic__";
const NO_REFERENCE_FIELD = "__none__";

type Notice = { tone: "info" | "error"; message: string };

const modelKey = (model: ImageModelRef) => `${model.provider}::${model.id}`;

function parseModelKey(value: string): ImageModelRef | null {
  const separator = value.indexOf("::");
  if (separator < 0) return null;
  const provider = value.slice(0, separator);
  const id = value.slice(separator + 2);
  return (IMAGE_GENERATION_PROVIDER_IDS as readonly string[]).includes(provider) && id
    ? { provider: provider as ImageGenerationProviderId, id }
    : null;
}

function reportFailure(result: ImageGenerationActionResult | null) {
  if (result && !result.ok) toast.error(result.message);
}

function keyStatus(provider: ImageGenerationProviderView): {
  label: string;
  color: "green" | "gray";
} {
  if (!provider.key.connected) return { label: "Not connected", color: "gray" };
  return provider.key.source === "env"
    ? { label: "Connected via environment", color: "green" }
    : { label: "Connected", color: "green" };
}

export function ImageGenerationSettings() {
  const [state, setState] = React.useState<ImageGenerationState | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  // Keys of the actions in flight, e.g. `fetch:fal`, `key:replicate`, `model:fal::id`.
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = React.useRef(new Set<string>());
  const [notices, setNotices] = React.useState<
    Partial<Record<ImageGenerationProviderId, Notice>>
  >({});
  const [confirmRemove, setConfirmRemove] = React.useState<ImageGenerationProviderId | null>(
    null,
  );

  const load = React.useCallback(async () => {
    try {
      setState(await imageGenerationApi.state());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Runs an action unless the same action is already in flight, and adopts the
   * returned state as the source of truth. Other actions keep running.
   */
  const run = React.useCallback(
    async (
      key: string,
      action: () => Promise<ImageGenerationActionResult>,
    ): Promise<ImageGenerationActionResult | null> => {
      if (pendingRef.current.has(key)) return null;
      pendingRef.current.add(key);
      setPending(new Set(pendingRef.current));
      try {
        const result = await action();
        if (result.ok) setState(result.state);
        return result;
      } catch (error) {
        void load();
        return {
          ok: false,
          code: "storage_error",
          message: error instanceof Error ? error.message : "Aiden couldn’t save that change.",
        };
      } finally {
        pendingRef.current.delete(key);
        setPending(new Set(pendingRef.current));
      }
    },
    [load],
  );

  const setNotice = React.useCallback(
    (provider: ImageGenerationProviderId, notice: Notice | null) =>
      setNotices((current) => {
        const next = { ...current };
        if (notice) next[provider] = notice;
        else delete next[provider];
        return next;
      }),
    [],
  );

  const saveKey = async (provider: ImageGenerationProviderId, key: string): Promise<boolean> => {
    setNotice(provider, null);
    const result = await run(`key:${provider}`, () => imageGenerationApi.setKey(provider, key));
    if (!result) return false;
    if (!result.ok) {
      setNotice(provider, { tone: "error", message: result.message });
      return false;
    }
    toast.success(`${IMAGE_GENERATION_PROVIDER_NAMES[provider]} image key saved.`);
    return true;
  };

  const removeKey = async (provider: ImageGenerationProviderId) => {
    setNotice(provider, null);
    const result = await run(`key:${provider}`, () => imageGenerationApi.removeKey(provider));
    if (result && !result.ok) setNotice(provider, { tone: "error", message: result.message });
    else if (result?.ok) toast.success(`${IMAGE_GENERATION_PROVIDER_NAMES[provider]} image key removed.`);
  };

  const fetchModels = async (provider: ImageGenerationProviderId) => {
    setNotice(provider, null);
    const result = await run(`fetch:${provider}`, () => imageGenerationApi.fetchModels(provider));
    if (!result) return;
    if (!result.ok) {
      setNotice(provider, { tone: "error", message: result.message });
      return;
    }
    const count = result.state.providers.find((entry) => entry.id === provider)?.fetchedCount ?? 0;
    setNotice(provider, {
      tone: "info",
      message: `Fetched ${count} ${count === 1 ? "model" : "models"}. New ones start off.`,
    });
  };

  const toggleModel = React.useCallback(
    (model: ImageGenerationModelView, enabled: boolean) =>
      void run(`model:${modelKey(model)}`, () =>
        imageGenerationApi.setModelEnabled(model.provider, model.id, enabled),
      ).then(reportFailure),
    [run],
  );

  const removeModel = React.useCallback(
    (model: ImageGenerationModelView) =>
      void run(`remove:${modelKey(model)}`, () =>
        imageGenerationApi.removeCustomModel({ provider: model.provider, id: model.id }),
      ).then(reportFailure),
    [run],
  );

  if (!state) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Text color="secondary" role="status">
          {loadError
            ? "Image Generation settings could not be loaded."
            : "Loading Image Generation settings…"}
        </Text>
        {loadError ? (
          <Button variant="muted" onClick={() => void load()}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  const removing = confirmRemove ? IMAGE_GENERATION_PROVIDER_NAMES[confirmRemove] : "";

  return (
    <div>
      <Callout className="mb-7">
        <Text variant="small-strong">Separate keys for images</Text>
        <Text variant="small" color="secondary" className="text-pretty">
          Image generation uses only the keys on this page. They’re encrypted on this Mac and never
          used for chat, and your chat provider keys are never used for images.
        </Text>
      </Callout>

      <FieldSet title="Providers">
        {state.providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            fetching={pending.has(`fetch:${provider.id}`)}
            savingKey={pending.has(`key:${provider.id}`)}
            notice={notices[provider.id]}
            onSaveKey={(key) => saveKey(provider.id, key)}
            onRequestRemove={() => setConfirmRemove(provider.id)}
            onFetch={() => void fetchModels(provider.id)}
          />
        ))}
      </FieldSet>

      <DefaultModelGroup
        state={state}
        busy={pending.has("default")}
        onChange={(model) =>
          void run("default", () => imageGenerationApi.setDefaultModel(model)).then(reportFailure)
        }
      />

      <ModelsGroup
        state={state}
        pending={pending}
        onToggle={toggleModel}
        onRemove={removeModel}
      />

      <AddModelForm
        busy={pending.has("add")}
        onAdd={(request) => run("add", () => imageGenerationApi.addCustomModel(request))}
      />

      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        title={`Remove the ${removing} image key?`}
        description={`Aiden deletes the encrypted key from this Mac. Image generation through ${removing} stops until you add a key again. Your chat providers aren’t affected.`}
        confirmLabel="Remove key"
        confirmVariant="destructive"
        busy={confirmRemove !== null && pending.has(`key:${confirmRemove}`)}
        onConfirm={() => {
          const provider = confirmRemove;
          setConfirmRemove(null);
          if (provider) void removeKey(provider);
        }}
      />
    </div>
  );
}

function ProviderRow({
  provider,
  fetching,
  savingKey,
  notice,
  onSaveKey,
  onRequestRemove,
  onFetch,
}: {
  provider: ImageGenerationProviderView;
  /** This provider's Fetch latest is running; it never locks the key controls. */
  fetching: boolean;
  /** This provider's key is being saved or removed. */
  savingKey: boolean;
  notice: Notice | undefined;
  onSaveKey: (key: string) => Promise<boolean>;
  onRequestRemove: () => void;
  onFetch: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const fetchHintId = React.useId();
  const status = keyStatus(provider);
  const stored = provider.key.source === "stored";
  const fetchBlocked = provider.fetchRequiresKey && !provider.key.connected;

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = draft.trim();
    if (!key || savingKey) return;
    if (await onSaveKey(key)) {
      setDraft("");
      setEditing(false);
    }
  };

  const fetchedLine = provider.fetchedAt
    ? `Last fetched ${formatRelativeTime(provider.fetchedAt)} · ${provider.fetchedCount} ${provider.fetchedCount === 1 ? "model" : "models"}`
    : "Using the built-in list. Fetch latest to see newer models.";

  return (
    <Field
      orientation="vertical"
      label={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-control text-secondary">
            <ImageProviderLogo providerId={provider.id} className="size-4" />
          </span>
          <span className="truncate">{provider.name}</span>
          <Badge color={status.color}>{status.label}</Badge>
        </span>
      }
      description={fetchedLine}
    >
      <div className="flex flex-wrap items-center gap-2">
        {!editing ? (
          <Button
            size="small"
            variant="muted"
            disabled={savingKey}
            onClick={() => setEditing(true)}
            aria-label={`${stored ? "Replace" : "Add"} ${provider.name} key`}
          >
            <KeyRound aria-hidden="true" />
            {stored ? "Replace key" : "Add key"}
          </Button>
        ) : null}
        {stored ? (
          <Button
            size="small"
            variant="transparent"
            disabled={savingKey}
            onClick={onRequestRemove}
            aria-label={`Remove ${provider.name} key`}
          >
            Remove
          </Button>
        ) : null}
        <Button
          size="small"
          variant="transparent"
          disabled={fetching || fetchBlocked}
          onClick={onFetch}
          aria-describedby={fetchBlocked ? fetchHintId : undefined}
          aria-label={`Fetch latest ${provider.name} models`}
        >
          {fetching ? (
            <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw aria-hidden="true" />
          )}
          {fetching ? "Fetching…" : "Fetch latest models"}
        </Button>
      </div>
      {fetchBlocked ? (
        <Text id={fetchHintId} as="p" variant="small" color="secondary">
          Add a {provider.name} key to fetch its model list. {provider.name} requires one for its
          catalog.
        </Text>
      ) : null}
      {editing ? (
        <form className="flex flex-wrap gap-2" onSubmit={(event) => void submit(event)}>
          <Input
            ref={inputRef}
            className="min-w-0 flex-1 basis-60"
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setDraft("");
              setEditing(false);
            }}
            autoComplete="off"
            spellCheck={false}
            maxLength={IMAGE_GENERATION_LIMITS.maxKeyLength}
            placeholder={`Paste a ${provider.name} API key`}
            aria-label={`${provider.name} image API key`}
            aria-invalid={notice?.tone === "error" ? true : undefined}
            disabled={savingKey}
          />
          <Button type="submit" size="medium" disabled={savingKey || !draft.trim()}>
            {savingKey ? (
              <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            ) : null}
            Save key
          </Button>
          <Button
            size="medium"
            variant="transparent"
            disabled={savingKey}
            onClick={() => {
              setDraft("");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {notice ? (
        <Text
          as="p"
          variant="small"
          color={notice.tone === "error" ? "status-red" : "secondary"}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </Text>
      ) : null}
    </Field>
  );
}

function isAvailable(state: ImageGenerationState, model: ImageGenerationModelView): boolean {
  return (
    model.enabled &&
    state.providers.some((provider) => provider.id === model.provider && provider.key.connected)
  );
}

function ModelOptionLabel({ model }: { model: ImageGenerationModelView }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ImageModelLogo
        maker={model.maker}
        providerId={model.provider}
        modelId={model.id}
        label={model.name}
        className="size-3.5 text-secondary"
      />
      <span className="truncate">{model.name}</span>
      <span className="shrink-0 text-tertiary">{IMAGE_GENERATION_PROVIDER_NAMES[model.provider]}</span>
    </span>
  );
}

function DefaultModelGroup({
  state,
  busy,
  onChange,
}: {
  state: ImageGenerationState;
  busy: boolean;
  onChange: (model: ImageModelRef | null) => void;
}) {
  const options = state.models.filter((model) => isAvailable(state, model));
  const current = state.defaultModel;
  const currentModel = current
    ? state.models.find((model) => model.provider === current.provider && model.id === current.id)
    : undefined;
  const currentAvailable = currentModel ? isAvailable(state, currentModel) : false;
  return (
    <FieldSet title="Default model">
      <Field
        label="Default image model"
        description={
          current && !currentAvailable
            ? "This model is off or its provider has no key, so Aiden picks automatically for now."
            : "Chats use it unless you ask for another model, and new Generate Image steps in Create Images start with it. Automatic picks the first available one."
        }
      >
        <Select
          value={current ? modelKey(current) : AUTOMATIC}
          disabled={busy}
          onValueChange={(value) => onChange(value === AUTOMATIC ? null : parseModelKey(value))}
        >
          <SelectTrigger className="w-full" aria-label="Default image model">
            <SelectValue>
              {currentModel ? (
                <ModelOptionLabel model={currentModel} />
              ) : current ? (
                `${current.id} (unavailable)`
              ) : (
                "Automatic"
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
            {current && !currentAvailable ? (
              <SelectItem value={modelKey(current)} disabled>
                {currentModel?.name ?? current.id} (unavailable)
              </SelectItem>
            ) : null}
            {options.map((model) => (
              <SelectItem key={modelKey(model)} value={modelKey(model)}>
                <ModelOptionLabel model={model} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FieldSet>
  );
}

type ProviderFilter = ImageGenerationProviderId | "all";

function matchesQuery(model: ImageGenerationModelView, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${model.name} ${model.id} ${model.maker ?? ""} ${IMAGE_GENERATION_PROVIDER_NAMES[model.provider]}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function ModelsGroup({
  state,
  pending,
  onToggle,
  onRemove,
}: {
  state: ImageGenerationState;
  pending: ReadonlySet<string>;
  onToggle: (model: ImageGenerationModelView, enabled: boolean) => void;
  onRemove: (model: ImageGenerationModelView) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<ProviderFilter>("all");
  const [showOff, setShowOff] = React.useState(false);
  const [limit, setLimit] = React.useState(MODEL_ROW_PAGE);
  const terms = React.useMemo(
    () => query.toLocaleLowerCase().split(/\s+/u).filter(Boolean),
    [query],
  );

  React.useEffect(() => setLimit(MODEL_ROW_PAGE), [terms, filter, showOff]);

  const inFilter = state.models.filter(
    (model) => filter === "all" || model.provider === filter,
  );
  // Fetched models start off; keep them out of the way until searched for.
  const hiddenOff = (model: ImageGenerationModelView) =>
    model.origin === "fetched" && !model.enabled;
  const revealOff = showOff || terms.length > 0;
  const matching = inFilter.filter(
    (model) => (revealOff || !hiddenOff(model)) && matchesQuery(model, terms),
  );
  const hiddenCount = revealOff ? 0 : inFilter.filter(hiddenOff).length;
  const rows = matching.slice(0, limit);

  return (
    <FieldSet title="Models">
      <div className="flex flex-col gap-3 p-4">
        <label className="relative block">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              event.preventDefault();
              setQuery("");
            }}
            placeholder="Search image models"
            aria-label="Search image models"
            className="pl-8"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter models by provider">
          {(["all", ...IMAGE_GENERATION_PROVIDER_IDS] as const).map((option) => (
            <Button
              key={option}
              size="small"
              variant={filter === option ? "muted" : "transparent"}
              aria-pressed={filter === option}
              className={filter === option ? "bg-list-selection text-primary" : "text-secondary"}
              onClick={() => setFilter(option)}
            >
              {option === "all" ? "All" : IMAGE_GENERATION_PROVIDER_NAMES[option]}
            </Button>
          ))}
        </div>
      </div>

      <div role="list" aria-label="Image models">
        {rows.map((model) => (
          <div role="listitem" key={modelKey(model)}>
            <ModelRow
              model={model}
              busy={
                pending.has(`model:${modelKey(model)}`) || pending.has(`remove:${modelKey(model)}`)
              }
              onToggle={onToggle}
              onRemove={onRemove}
            />
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <Text as="p" variant="small" color="secondary" className="px-4 pb-4" role="status">
          {terms.length > 0 ? `No image models match “${query.trim()}”.` : "No image models here yet."}
        </Text>
      ) : null}

      {matching.length > rows.length || hiddenCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4">
          <Text variant="small" color="secondary">
            {matching.length > rows.length
              ? `Showing ${rows.length} of ${matching.length}.`
              : `${hiddenCount} more from Fetch latest ${hiddenCount === 1 ? "is" : "are"} off. Search to find them.`}
          </Text>
          {matching.length > rows.length ? (
            <Button size="small" variant="muted" onClick={() => setLimit((value) => value + MODEL_ROW_PAGE)}>
              Show more
            </Button>
          ) : (
            <Button size="small" variant="muted" onClick={() => setShowOff(true)}>
              Show all
            </Button>
          )}
        </div>
      ) : null}
    </FieldSet>
  );
}

/** One model's row. Memoized: typing a search or another row's pending state leaves it alone. */
const ModelRow = React.memo(function ModelRow({
  model,
  busy,
  onToggle,
  onRemove,
}: {
  model: ImageGenerationModelView;
  /** This row's own switch or removal is in flight. */
  busy: boolean;
  onToggle: (model: ImageGenerationModelView, enabled: boolean) => void;
  onRemove: (model: ImageGenerationModelView) => void;
}) {
  const origin =
    model.origin === "fetched" ? "From Fetch latest" : model.origin === "custom" ? "Added by you" : null;
  return (
    <Field
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-control text-secondary">
            <ImageModelLogo
              maker={model.maker}
              providerId={model.provider}
              modelId={model.id}
              label={model.name}
              className="size-4"
            />
          </span>
          <span className="truncate">{model.name}</span>
        </span>
      }
      description={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-all font-mono">{model.id}</span>
          <span>· {IMAGE_GENERATION_PROVIDER_NAMES[model.provider]}</span>
          {origin ? <span>· {origin}</span> : null}
          {model.acceptsReferenceImages ? <Badge>Reference images</Badge> : null}
        </span>
      }
    >
      <div className="flex items-center justify-end gap-1">
        {model.origin === "custom" ? (
          <Button
            size="small"
            variant="transparent"
            iconOnly
            disabled={busy}
            aria-label={`Remove ${model.name}`}
            onClick={() => onRemove(model)}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : null}
        <Switch
          checked={model.enabled}
          disabled={busy}
          aria-label={`Use ${model.name}`}
          onCheckedChange={(checked) => onToggle(model, checked)}
        />
      </div>
    </Field>
  );
});

const ID_PLACEHOLDERS: Record<ImageGenerationProviderId, string> = {
  openrouter: "vendor/model",
  replicate: "owner/model",
  fal: "fal-ai/endpoint",
};

function AddModelForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (request: ImageGenerationAddCustomModelRequest) => Promise<ImageGenerationActionResult | null>;
}) {
  const [provider, setProvider] = React.useState<ImageGenerationProviderId>("openrouter");
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [references, setReferences] = React.useState(false);
  const [referenceField, setReferenceField] = React.useState(NO_REFERENCE_FIELD);
  const [editEndpoint, setEditEndpoint] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const formId = React.useId();

  const changeProvider = (next: ImageGenerationProviderId) => {
    setProvider(next);
    setReferences(false);
    setReferenceField(NO_REFERENCE_FIELD);
    setEditEndpoint("");
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !id.trim()) return;
    setError(null);
    const request: ImageGenerationAddCustomModelRequest = { provider, id: id.trim() };
    if (name.trim()) request.name = name.trim();
    if (provider === "openrouter" && references) request.acceptsReferenceImages = true;
    if (provider === "fal" && editEndpoint.trim()) request.editEndpoint = editEndpoint.trim();
    const fieldApplies = provider === "replicate" || (provider === "fal" && editEndpoint.trim());
    if (fieldApplies && referenceField !== NO_REFERENCE_FIELD) request.referenceField = referenceField;
    const result = await onAdd(request);
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      return;
    }
    toast.success(`Added ${request.name ?? request.id}.`);
    setId("");
    setName("");
    setReferences(false);
    setReferenceField(NO_REFERENCE_FIELD);
    setEditEndpoint("");
  };

  const referenceOptions: readonly string[] =
    provider === "replicate" ? Object.keys(REPLICATE_REFERENCE_FIELDS) : FAL_REFERENCE_FIELDS;

  return (
    <FieldSet title="Add model by ID">
      <Field
        orientation="vertical"
        description="Add a model the lists don’t include yet. Aiden checks the ID format here; the provider checks the rest when you generate."
      >
        <form
          id={formId}
          className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3"
          onSubmit={(event) => void submit(event)}
        >
          <label className="flex min-w-0 flex-col gap-1.5">
            <Text variant="small" color="secondary">
              Provider
            </Text>
            <Select
              value={provider}
              disabled={busy}
              onValueChange={(value) => changeProvider(value as ImageGenerationProviderId)}
            >
              <SelectTrigger aria-label="Provider for the new model">
                <SelectValue>{IMAGE_GENERATION_PROVIDER_NAMES[provider]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {IMAGE_GENERATION_PROVIDER_IDS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {IMAGE_GENERATION_PROVIDER_NAMES[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <Text variant="small" color="secondary">
              Model ID
            </Text>
            <Input
              value={id}
              onChange={(event) => {
                setId(event.target.value);
                setError(null);
              }}
              placeholder={ID_PLACEHOLDERS[provider]}
              maxLength={IMAGE_GENERATION_LIMITS.maxModelIdLength}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              disabled={busy}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <Text variant="small" color="secondary">
              Name (optional)
            </Text>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={IMAGE_GENERATION_LIMITS.maxModelNameLength}
              autoComplete="off"
              disabled={busy}
            />
          </label>
          {provider === "fal" ? (
            <label className="flex min-w-0 flex-col gap-1.5">
              <Text variant="small" color="secondary">
                Edit endpoint (optional)
              </Text>
              <Input
                value={editEndpoint}
                onChange={(event) => setEditEndpoint(event.target.value)}
                placeholder="fal-ai/endpoint/edit"
                maxLength={IMAGE_GENERATION_LIMITS.maxModelIdLength}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          ) : null}
          {provider === "replicate" || (provider === "fal" && editEndpoint.trim()) ? (
            <label className="flex min-w-0 flex-col gap-1.5">
              <Text variant="small" color="secondary">
                Reference image input (optional)
              </Text>
              <Select value={referenceField} disabled={busy} onValueChange={setReferenceField}>
                <SelectTrigger aria-label="Reference image input">
                  <SelectValue>
                    {referenceField === NO_REFERENCE_FIELD
                      ? provider === "fal"
                        ? "Default (image_urls)"
                        : "None"
                      : referenceField}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_REFERENCE_FIELD}>
                    {provider === "fal" ? "Default (image_urls)" : "None"}
                  </SelectItem>
                  {referenceOptions.map((field) => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {provider === "openrouter" ? (
            <div className="flex min-w-0 items-center justify-between gap-3 self-end">
              <Text variant="small" color="secondary">
                Takes reference images
              </Text>
              <Switch
                checked={references}
                disabled={busy}
                aria-label="Takes reference images"
                onCheckedChange={setReferences}
              />
            </div>
          ) : null}
        </form>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {error ? (
            <Text as="p" variant="small" color="status-red" role="alert" className="min-w-0 flex-1">
              {error}
            </Text>
          ) : (
            <span />
          )}
          <Button type="submit" form={formId} size="medium" disabled={busy || !id.trim()}>
            <Plus aria-hidden="true" />
            Add model
          </Button>
        </div>
      </Field>
    </FieldSet>
  );
}
