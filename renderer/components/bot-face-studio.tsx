import * as React from "react";
import { Check, Dices, RotateCcw, Sparkles } from "lucide-react";
import { botsApi } from "../lib/ipc";
import { createChatModelProviders, resolveExplicitModelSelection } from "../lib/model-picker-data";
import { useProviders, useProvidersModelInfo } from "../lib/queries";
import type { Provider } from "../lib/types";
import { readModelSelection } from "../lib/use-model-selection";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_COLOR_LABELS,
  BOT_AVATAR_DETAILS,
  BOT_AVATAR_DETAIL_LABELS,
  BOT_AVATAR_EYES,
  BOT_AVATAR_EYE_LABELS,
  BOT_AVATAR_SHAPES,
  BOT_AVATAR_SHAPE_LABELS,
  type BotAvatarAppearance,
} from "../shared/bots";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Text,
  Textarea,
  toast,
} from "./ui";
import { BotAvatar } from "./bot-avatar";

type AvatarEditorTab = "shape" | "color" | "eyes" | "detail" | "pi";

const AVATAR_EDITOR_TABS = ["shape", "color", "eyes", "detail", "pi"] as const;
const EMPTY_PROVIDERS: Provider[] = [];
const AVATAR_EDITOR_TAB_LABELS: Record<AvatarEditorTab, string> = {
  shape: "Shape",
  color: "Color",
  eyes: "Eyes",
  detail: "Detail",
  pi: "With Pi",
};

interface StudioState {
  tab: AvatarEditorTab;
  prompt: string;
  rationale: string;
  selection: { providerId: string; model: string };
  generating: boolean;
}

type StudioAction = { type: "patch"; patch: Partial<StudioState> };

function studioReducer(state: StudioState, action: StudioAction): StudioState {
  return { ...state, ...action.patch };
}

function randomItem<const Value>(items: readonly Value[]): Value {
  return items[Math.floor(Math.random() * items.length)]!;
}

function AvatarOption({
  appearance,
  label,
  selected,
  disabled,
  onSelect,
}: {
  appearance: BotAvatarAppearance;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      disabled={disabled}
      className={`relative flex min-h-20 flex-col items-center justify-center gap-1 rounded-card px-1 py-2 outline-none transition-[background-color,border-color,box-shadow] duration-150 disabled:cursor-default disabled:opacity-55 ${
        selected
          ? "bg-status-accent-surface shadow-control"
          : "bg-well hover:bg-control-hover"
      }`}
      onClick={onSelect}
    >
      <BotAvatar avatar={appearance} name={label} />
      <span className="max-w-full truncate text-mini font-medium text-secondary">{label}</span>
      {selected ? (
        <span className="absolute right-1.5 top-1.5 grid size-4 place-items-center rounded-full bg-accent text-accent-foreground">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}

export function BotFaceStudio({
  avatar,
  botName,
  onChange,
  onGeneratingChange,
  disabled = false,
}: {
  avatar: BotAvatarAppearance;
  botName: string;
  onChange(avatar: BotAvatarAppearance): void;
  onGeneratingChange(generating: boolean): void;
  disabled?: boolean;
}) {
  const providers = useProviders();
  const configuredProviders = providers.data ?? EMPTY_PROVIDERS;
  const modelInfo = useProvidersModelInfo(configuredProviders);
  const [state, dispatch] = React.useReducer(
    studioReducer,
    undefined,
    (): StudioState => ({
      tab: "shape",
      prompt: "",
      rationale: "",
      selection: readModelSelection(),
      generating: false,
    }),
  );
  const generationRevision = React.useRef(0);
  const activeRequestId = React.useRef<string | null>(null);
  const mounted = React.useRef(true);
  const tabId = React.useId();
  const tabButtons = React.useRef<Partial<Record<AvatarEditorTab, HTMLButtonElement>>>({});

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generationRevision.current += 1;
      const requestId = activeRequestId.current;
      activeRequestId.current = null;
      if (requestId) {
        void botsApi.cancelAvatarSuggestion(requestId).catch(() => undefined);
      }
    };
  }, []);

  const modelProviders = React.useMemo(
    () => createChatModelProviders(configuredProviders, modelInfo.data),
    [configuredProviders, modelInfo.data],
  );
  const selection = resolveExplicitModelSelection(state.selection, modelProviders);
  const effectiveProvider = modelProviders.find(
    ({ provider }) => provider.id === selection.providerId,
  );

  const applyManual = (patch: Partial<BotAvatarAppearance>) => {
    if (disabled) return;
    generationRevision.current += 1;
    if (state.generating) onGeneratingChange(false);
    dispatch({ type: "patch", patch: { rationale: "", generating: false } });
    onChange({ ...avatar, ...patch, version: 1 });
  };

  const shuffleAvatar = () => {
    applyManual({
      shape: randomItem(BOT_AVATAR_SHAPES),
      color: randomItem(BOT_AVATAR_COLORS),
      eyes: randomItem(BOT_AVATAR_EYES),
      detail: randomItem(BOT_AVATAR_DETAILS),
    });
  };

  const generateAvatar = async () => {
    if (disabled || !state.prompt.trim() || !selection.providerId || !selection.model) return;
    const revision = ++generationRevision.current;
    const requestId = globalThis.crypto.randomUUID();
    activeRequestId.current = requestId;
    dispatch({ type: "patch", patch: { generating: true, rationale: "" } });
    onGeneratingChange(true);
    try {
      const suggestion = await botsApi.suggestAvatar({
        requestId,
        prompt: state.prompt,
        providerId: selection.providerId,
        model: selection.model,
        currentAvatar: avatar,
      });
      if (!mounted.current || generationRevision.current !== revision) return;
      onChange(suggestion.avatar);
      dispatch({ type: "patch", patch: { rationale: suggestion.rationale } });
    } catch (error) {
      if (!mounted.current || generationRevision.current !== revision) return;
      toast.error(error instanceof Error ? error.message : "Aiden could not design this bot face.");
    } finally {
      if (activeRequestId.current === requestId) activeRequestId.current = null;
      if (mounted.current && generationRevision.current === revision) {
        dispatch({ type: "patch", patch: { generating: false } });
        onGeneratingChange(false);
      }
    }
  };

  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % AVATAR_EDITOR_TABS.length;
    if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + AVATAR_EDITOR_TABS.length) % AVATAR_EDITOR_TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = AVATAR_EDITOR_TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = AVATAR_EDITOR_TABS[nextIndex]!;
    dispatch({ type: "patch", patch: { tab: nextTab } });
    tabButtons.current[nextTab]?.focus();
  };

  const options =
    state.tab === "shape"
      ? BOT_AVATAR_SHAPES.map((shape) => ({
          key: shape,
          appearance: { ...avatar, shape },
          label: BOT_AVATAR_SHAPE_LABELS[shape],
          selected: avatar.shape === shape,
          apply: () => applyManual({ shape }),
        }))
      : state.tab === "color"
        ? BOT_AVATAR_COLORS.map((color) => ({
            key: color,
            appearance: { ...avatar, color },
            label: BOT_AVATAR_COLOR_LABELS[color],
            selected: avatar.color === color,
            apply: () => applyManual({ color }),
          }))
        : state.tab === "eyes"
          ? BOT_AVATAR_EYES.map((eyes) => ({
              key: eyes,
              appearance: { ...avatar, eyes },
              label: BOT_AVATAR_EYE_LABELS[eyes],
              selected: avatar.eyes === eyes,
              apply: () => applyManual({ eyes }),
            }))
          : state.tab === "detail"
            ? BOT_AVATAR_DETAILS.map((detail) => ({
                key: detail,
                appearance: { ...avatar, detail },
                label: BOT_AVATAR_DETAIL_LABELS[detail],
                selected: avatar.detail === detail,
                apply: () => applyManual({ detail }),
              }))
            : [];

  return (
    <section
      className="overflow-hidden rounded-card border border-field bg-well"
      aria-labelledby="bot-face-studio-title"
      aria-busy={state.generating || undefined}
    >
      <div className="flex items-center justify-between gap-3 border-b border-separator px-4 py-3">
        <div>
          <Text id="bot-face-studio-title" as="h3" variant="small-strong">
            Bot face
          </Text>
          <Text as="p" variant="small" color="tertiary">
            Layered SVG · pastel body · dark eyes in every theme
          </Text>
        </div>
        <Button
          type="button"
          variant="filled"
          size="small"
          disabled={disabled || state.generating}
          onClick={shuffleAvatar}
        >
          <Dices /> Shuffle
        </Button>
      </div>
      <div className="grid grid-cols-[176px_minmax(0,1fr)] gap-4 p-4 max-[620px]:grid-cols-1">
        <div className="flex flex-col items-center justify-center rounded-card bg-control/45 p-4 text-center">
          <BotAvatar avatar={avatar} name={botName || "Bot face preview"} size="preview" />
          <Text as="p" variant="small-strong" className="mt-3">
            {BOT_AVATAR_SHAPE_LABELS[avatar.shape]} · {BOT_AVATAR_EYE_LABELS[avatar.eyes]}
          </Text>
          <Text as="p" variant="small" color="tertiary" className="mt-1 max-w-36">
            No mouth or theme-shifting facial ink.
          </Text>
        </div>
        <div className="min-w-0">
          <div
            className="grid grid-cols-5 gap-1 rounded-card bg-control p-1"
            aria-label="Bot face controls"
            role="tablist"
          >
            {AVATAR_EDITOR_TABS.map((value, index) => (
              <button
                key={value}
                ref={(element) => {
                  if (element) tabButtons.current[value] = element;
                  else delete tabButtons.current[value];
                }}
                type="button"
                id={`${tabId}-${value}-tab`}
                role="tab"
                aria-controls={`${tabId}-${value}-panel`}
                aria-selected={state.tab === value}
                tabIndex={state.tab === value ? 0 : -1}
                disabled={disabled}
                className={`min-w-0 rounded-control px-2 py-1.5 text-mini font-medium outline-none transition-[background-color,color,box-shadow] duration-150 ${
                  state.tab === value
                    ? "bg-popover text-primary shadow-control"
                    : "text-secondary hover:bg-control-hover"
                }`}
                onClick={() => dispatch({ type: "patch", patch: { tab: value } })}
                onKeyDown={(event) => moveTabFocus(event, index)}
              >
                <span className="block truncate">{AVATAR_EDITOR_TAB_LABELS[value]}</span>
              </button>
            ))}
          </div>

          {AVATAR_EDITOR_TABS.filter((value) => value !== state.tab).map((value) => (
            <div
              key={value}
              id={`${tabId}-${value}-panel`}
              role="tabpanel"
              aria-labelledby={`${tabId}-${value}-tab`}
              hidden
            />
          ))}

          {state.tab === "pi" ? (
            <div
              id={`${tabId}-${state.tab}-panel`}
              role="tabpanel"
              aria-labelledby={`${tabId}-${state.tab}-tab`}
              className="mt-3 space-y-3"
            >
              <label className="block">
                <Text variant="small-strong">Describe the look</Text>
                <Textarea
                  className="mt-1.5 min-h-20 resize-y"
                  value={state.prompt}
                  maxLength={1_200}
                  disabled={disabled || state.generating}
                  placeholder="A calm research bot that feels precise, patient, and a little cosmic."
                  onChange={(event) =>
                    dispatch({ type: "patch", patch: { prompt: event.target.value } })
                  }
                />
              </label>
              {providers.isError ? (
                <div className="flex items-center justify-between gap-2 rounded-card bg-control px-3 py-2">
                  <Text variant="small" color="secondary">
                    Aiden could not load configured providers.
                  </Text>
                  <Button
                    size="small"
                    variant="transparent"
                    disabled={disabled || state.generating}
                    onClick={() => void providers.refetch()}
                  >
                    <RotateCcw /> Retry
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <label className="min-w-0">
                    <Text variant="small" color="secondary">
                      Provider
                    </Text>
                    <Select
                      value={selection.providerId}
                      disabled={disabled || state.generating}
                      onValueChange={(providerId) => {
                        const choice = modelProviders.find(
                          ({ provider }) => provider.id === providerId,
                        );
                        const provider = choice?.provider;
                        dispatch({
                          type: "patch",
                          patch: {
                            selection: {
                              providerId,
                              model:
                                provider?.defaultModel &&
                                choice?.models.includes(provider.defaultModel)
                                  ? provider.defaultModel
                                  : (choice?.models[0] ?? ""),
                            },
                          },
                        });
                      }}
                    >
                      <SelectTrigger className="mt-1 w-full" aria-label="Bot face provider">
                        <SelectValue
                          placeholder={providers.isLoading ? "Loading…" : "Choose provider"}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {modelProviders.map(({ provider }) => (
                          <SelectItem key={provider.id} value={provider.id}>
                            {provider.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="min-w-0">
                    <Text variant="small" color="secondary">
                      Model
                    </Text>
                    <Select
                      value={selection.model}
                      disabled={disabled || state.generating || !effectiveProvider}
                      onValueChange={(model) =>
                        dispatch({
                          type: "patch",
                          patch: { selection: { providerId: selection.providerId, model } },
                        })
                      }
                    >
                      <SelectTrigger className="mt-1 w-full" aria-label="Bot face model">
                        <SelectValue placeholder="Choose model" />
                      </SelectTrigger>
                      <SelectContent>
                        {effectiveProvider?.models.map((model) => (
                          <SelectItem key={model} value={model}>
                            {model}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              )}
              {!providers.isLoading && !providers.isError && modelProviders.length === 0 ? (
                <div className="rounded-card bg-control px-3 py-2 text-small text-secondary">
                  Connect a Pi provider and model in Settings before asking Aiden to design a face.
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <Text variant="small" color="tertiary">
                  Uses the selected configured Pi provider directly. No Gemini key or avatar image
                  upload.
                </Text>
                <Button
                  type="button"
                  variant="accent"
                  size="small"
                  className="shrink-0"
                  disabled={
                    !state.prompt.trim() ||
                    !selection.providerId ||
                    !selection.model ||
                    disabled ||
                    state.generating
                  }
                  onClick={() => void generateAvatar()}
                >
                  <Sparkles /> {state.generating ? "Designing…" : "Design face"}
                </Button>
              </div>
              {state.rationale ? (
                <div
                  className="rounded-card border border-separator bg-control px-3 py-2 text-small text-secondary"
                  role="status"
                >
                  {state.rationale}
                </div>
              ) : null}
            </div>
          ) : (
            <div
              id={`${tabId}-${state.tab}-panel`}
              role="tabpanel"
              aria-labelledby={`${tabId}-${state.tab}-tab`}
              className={`mt-3 grid gap-2 ${state.tab === "shape" || state.tab === "color" ? "grid-cols-4" : "grid-cols-3"}`}
            >
              {options.map((option) => (
                <AvatarOption
                  key={option.key}
                  appearance={option.appearance}
                  label={option.label}
                  selected={option.selected}
                  disabled={disabled || state.generating}
                  onSelect={option.apply}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
