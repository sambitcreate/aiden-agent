# Bot chat activity · Slice A (quick fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can choose a Bot's AI model while creating it (desktop, iOS, Android), reach Advanced (and Memory) from every Bot ••• menu, and Advanced's model control no longer wraps.

**Architecture:** One pure helper module (`bot-model-choice.ts`) owns how a primary model and its photo model are chosen, shared by the New Bot dialog and Advanced. A Bot-specific `BotModelPicker` popover (searchable, grouped by provider) replaces Advanced's Service + Model selects and appears in the New Bot dialog. The phones reuse their existing model choice plumbing: iOS gets a pushed model list used by New Bot and Advanced, Android maps the Bot catalog into its shared `AidenModelPickerField`. No main-process or Remote contract change.

**Tech Stack:** React 19 + TanStack Router/Query + Radix Popover + cmdk (`Command`) in `renderer/`, `node:test` + Testing Library (happy-dom); SwiftUI + XCTest; Jetpack Compose + JUnit.

**Spec:** [`docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md`](../specs/2026-10-14-bot-chat-activity-design.md) §2 decisions 7–8, §4 slice A, §10.

**Slice plans:** A (this), B (status line + Chat activity), C1 (workbench shell), C2 (Bots sidebar + side panel, stacked on C1), D (phones). B–D get their own plans before they start.

## Global Constraints

- Bot model and provider ids in `BotCapabilityCatalog` are opaque, main-minted ids. Never map them to real provider ids in the renderer and never send real ids from the renderer.
- New Bots keep today's default: Full access with the recommended model (`firstAvailableModel`) plus an image model (`firstAvailableVisionModel`) when that model reads text only.
- With no AI model set up, creating a Bot still works and the Bot reports `needs_model` (existing behaviour).
- No decorative borders or outlines on choice rows; selection is shown with the check/radio and background state. Keep `focus-visible` rings. Text inputs (the picker's filter) get no accent border on focus.
- Copy is sentence case on desktop: "AI model", "Model for photos", "Recommended", "Set up…", "Choose a model", "Reads images", "Text only".
- Menu order everywhere in this slice: Profile, Files (chat only), Memory, Advanced, separator, Delete Bot. Routines and Pin arrive in slice C2.
- Every new desktop test file goes in `package.json` `test:bots` **and** `scripts/ci-test-registry.json` (next to its sibling `renderer/main/bots/bot-create-flow.test.tsx`), then `npm run test:ci-policy` passes.
- Tests follow AGENTS.md: behavioural oracles only, no source-grepping, no exact class strings, no snapshots.
- No network calls are added. models.dev and other catalogs are untouched.

## Review Focus

1. **The chosen model disappears before Create** (the provider was signed out in Settings meanwhile). Expected: Create stops on step 1 with "That model isn’t available any more. Choose another one." and creates nothing, rather than silently using a different model. Test: Task 3, step 1, test B.
2. **A provider that is not set up** still lists its models but they cannot be chosen. Expected: rows are disabled and choosing one does nothing. Test: Task 2, step 1, test 2.
3. **Switching between a text-only and an image-reading model** changes the photo model without losing a valid manual choice. Expected: an image-reading model clears the photo model; a text-only model keeps a still-valid photo model, otherwise fills the first available. Test: Task 1, step 1.
4. **A long model name in Advanced** (the owner's DeepSeek screenshot). Expected: the control shows only the model name, and "Reads images"/"Text only" sits under the row label. Test: Task 4, step 1.
5. **The model list fails to load when New Bot opens.** Expected: the field says it couldn't load the models and offers Try again; Next and Create still work with the recommended model. Test: Task 3, step 1, test C.

---

## File map

| File | Responsibility |
|---|---|
| Create `renderer/main/bots/bot-model-choice.ts` | Pure model/photo-model choice rules and the Full-access update built from a choice |
| Create `renderer/main/bots/bot-model-choice.test.ts` | Unit tests for the rules |
| Create `renderer/main/bots/bot-model-picker.tsx` | `BotModelPicker` popover |
| Create `renderer/main/bots/bot-model-picker.test.tsx` | Picker behaviour |
| Modify `renderer/main/bots/bot-create-flow.tsx` | AI model field in step 1; Create uses the choice |
| Modify `renderer/main/bots/bot-create-flow.test.tsx` | Choice, vanished model, load failure |
| Modify `renderer/main/bots/bot-advanced.tsx` | `ModelSection` uses `BotModelPicker`; `withRecommendedModel` removed |
| Modify `renderer/main/bots/bot-profile.test.tsx` | Advanced assertions follow the new control |
| Modify `renderer/main/bots/bot-chat-header.tsx`, `bot-chat-header.test.tsx` | Memory + Advanced in the chat ••• menu |
| Modify `renderer/main/bots/bot-list.tsx`, `bot-list.test.tsx`, `renderer/main/bots-view.tsx`, `renderer/main/bots/bot-chat-pane.tsx` | Memory + Advanced in row menus; wiring |
| Modify `ios/AidenOnTheGo/Features/Bots/AidenBotSettingsDraft.swift` | `selectModel` / `selectVisionModel` |
| Modify `ios/AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift` | `AidenBotModelRow`, `AidenBotModelListView`, `aidenBotModelListSections`; Advanced uses them |
| Modify `ios/AidenOnTheGo/Features/Bots/AidenBotCreateView.swift` | AI model section |
| Modify `ios/AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift` | Memory + Advanced in ••• |
| Modify `ios/AidenOnTheGoTests/AidenBotHomeProfileTests.swift` | Draft and list tests |
| Create `android/.../features/bots/AidenBotModelChoice.kt` | Catalog → shared picker providers; recommended route |
| Modify `android/.../features/bots/AidenBotEditorScreen.kt` | Create draft carries a model; field in the create screen |
| Modify `android/.../features/bots/AidenBotAdvancedScreen.kt` | Radio rows → `AidenModelPickerField` |
| Modify `android/.../features/bots/AidenBotChatHeader.kt`, `AidenBotSessionScreen.kt`, `android/app/src/main/res/values/strings.xml` | Memory + Advanced in ••• |
| Create `android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotModelChoiceTest.kt` | Mapping and create draft tests |
| Modify `package.json`, `scripts/ci-test-registry.json`, `.memory/bots-rework-ui.md`, `docs/plans/README.md`, the spec §10 | Registration, project memory, index, deviation note |

`android/...` = `android/app/src/main/java/sbtbiswas/AidenOnTheGo`.

---

### Task 1: Model choice rules

**Files:**
- Create: `renderer/main/bots/bot-model-choice.ts`
- Test: `renderer/main/bots/bot-model-choice.test.ts`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `firstAvailableModel`, `firstAvailableVisionModel` from `renderer/main/bots/bot-access-draft.ts`; `BotCapabilityCatalog`, `BotProviderOption`, `BotModelOption`, `BotAccessUpdate` from `renderer/shared/bot-capabilities.ts`.
- Produces:
  - `interface BotModelChoice { providerId?: string; modelId?: string; visionProviderId?: string; visionModelId?: string }`
  - `findBotModel(catalog, providerId?, modelId?): { provider: BotProviderOption; model: BotModelOption } | undefined`
  - `botModelUsable(found): boolean`
  - `recommendedBotModelChoice(catalog): BotModelChoice`
  - `chooseBotModel(catalog, current: BotModelChoice, providerId: string, modelId: string): BotModelChoice` (always returns all four keys)
  - `chooseBotVisionModel(catalog, current, providerId, modelId): BotModelChoice`
  - `sameBotModelChoice(a, b): boolean`
  - `botFullAccess(catalog, choice): { access: BotAccessUpdate; hasModel: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/main/bots/bot-model-choice.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotCapabilityCatalog } from "../../shared/bot-capabilities";
import { catalogFixture } from "./test-fixtures";
import {
  botFullAccess,
  chooseBotModel,
  chooseBotVisionModel,
  recommendedBotModelChoice,
  sameBotModelChoice,
} from "./bot-model-choice";

// Text Service/Writer reads text only; Vision Service/Seer reads images.
function catalog(): BotCapabilityCatalog {
  const base = catalogFixture();
  return {
    ...base,
    providers: [
      ...base.providers,
      {
        id: "prov-off",
        label: "Signed Out",
        available: false,
        models: [{ id: "model-off", label: "Ghost", available: true, supportsImages: true }],
      },
      {
        id: "prov-more",
        label: "More Vision",
        available: true,
        models: [{ id: "model-eye", label: "Eye", available: true, supportsImages: true }],
      },
    ],
  };
}

test("the recommended choice is the first model, paired with a photo model when it reads text only", () => {
  assert.deepEqual(recommendedBotModelChoice(catalog()), {
    providerId: "prov-text",
    modelId: "model-text",
    visionProviderId: "prov-vision",
    visionModelId: "model-vision",
  });
});

test("choosing a model that reads images drops the photo model", () => {
  const next = chooseBotModel(catalog(), recommendedBotModelChoice(catalog()), "prov-vision", "model-vision");
  assert.deepEqual(next, {
    providerId: "prov-vision",
    modelId: "model-vision",
    visionProviderId: undefined,
    visionModelId: undefined,
  });
});

test("choosing a text-only model keeps a still-valid photo model the person picked", () => {
  const picked = chooseBotVisionModel(catalog(), recommendedBotModelChoice(catalog()), "prov-more", "model-eye");
  const next = chooseBotModel(catalog(), picked, "prov-text", "model-text");
  assert.equal(next.visionProviderId, "prov-more");
  assert.equal(next.visionModelId, "model-eye");
});

test("choosing a text-only model with no photo model fills the first one available", () => {
  const next = chooseBotModel(catalog(), { providerId: "prov-vision", modelId: "model-vision" }, "prov-text", "model-text");
  assert.equal(next.visionProviderId, "prov-vision");
  assert.equal(next.visionModelId, "model-vision");
});

test("a model from a provider that is not set up, or an unknown one, changes nothing", () => {
  const start = recommendedBotModelChoice(catalog());
  assert.equal(chooseBotModel(catalog(), start, "prov-off", "model-off"), start);
  assert.equal(chooseBotModel(catalog(), start, "prov-text", "missing"), start);
});

test("a text-only model can't become the photo model", () => {
  const start = recommendedBotModelChoice(catalog());
  assert.equal(chooseBotVisionModel(catalog(), start, "prov-text", "model-text"), start);
});

test("sameBotModelChoice compares all four parts", () => {
  const start = recommendedBotModelChoice(catalog());
  assert.equal(sameBotModelChoice(start, { ...start }), true);
  assert.equal(sameBotModelChoice(start, { ...start, visionModelId: "model-eye" }), false);
});

test("Full access carries the chosen model and photo model, and no model keys when there is none", () => {
  const withModel = botFullAccess(catalog(), recommendedBotModelChoice(catalog()));
  assert.equal(withModel.hasModel, true);
  assert.deepEqual(withModel.access, {
    accessMode: "full",
    catalogRevision: "catalog-1",
    confirmedForeground: true,
    providerId: "prov-text",
    modelId: "model-text",
    visionModel: { providerId: "prov-vision", modelId: "model-vision" },
  });
  const none = botFullAccess(catalogFixture({ models: false }), {});
  assert.equal(none.hasModel, false);
  assert.deepEqual(none.access, { accessMode: "full", catalogRevision: "catalog-1", confirmedForeground: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-model-choice.test.ts`
Expected: FAIL, `Cannot find module './bot-model-choice'`.

- [ ] **Step 3: Write the implementation**

```ts
// renderer/main/bots/bot-model-choice.ts
import type {
  BotAccessUpdate,
  BotCapabilityCatalog,
  BotModelOption,
  BotProviderOption,
} from "../../shared/bot-capabilities";
import { firstAvailableModel, firstAvailableVisionModel } from "./bot-access-draft";

/**
 * A Bot's model and, when that model reads text only, the model its photos and
 * screenshots go to. Ids are the catalog's opaque ids.
 */
export interface BotModelChoice {
  providerId?: string;
  modelId?: string;
  visionProviderId?: string;
  visionModelId?: string;
}

export function findBotModel(
  catalog: BotCapabilityCatalog,
  providerId: string | undefined,
  modelId: string | undefined,
): { provider: BotProviderOption; model: BotModelOption } | undefined {
  if (!providerId || !modelId) return undefined;
  const provider = catalog.providers.find(({ id }) => id === providerId);
  const model = provider?.models.find(({ id }) => id === modelId);
  return provider && model ? { provider, model } : undefined;
}

export function botModelUsable(found: ReturnType<typeof findBotModel>): boolean {
  return Boolean(found?.provider.available && found.model.available);
}

/** Today's default for a new Bot: the first model, plus a photo model when it reads text only. */
export function recommendedBotModelChoice(catalog: BotCapabilityCatalog): BotModelChoice {
  const model = firstAvailableModel(catalog);
  if (!model) return {};
  const readsImages = findBotModel(catalog, model.providerId, model.modelId)?.model.supportsImages === true;
  const vision = readsImages ? undefined : firstAvailableVisionModel(catalog, model.providerId);
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    visionProviderId: vision?.providerId,
    visionModelId: vision?.modelId,
  };
}

/**
 * Picks the primary model. A model that reads images needs no photo model; a
 * text-only one keeps a still-usable photo model, else gets the first available.
 * An unusable choice returns `current` unchanged.
 */
export function chooseBotModel(
  catalog: BotCapabilityCatalog,
  current: BotModelChoice,
  providerId: string,
  modelId: string,
): BotModelChoice {
  const found = findBotModel(catalog, providerId, modelId);
  if (!found || !botModelUsable(found)) return current;
  if (found.model.supportsImages) {
    return { providerId, modelId, visionProviderId: undefined, visionModelId: undefined };
  }
  const kept = findBotModel(catalog, current.visionProviderId, current.visionModelId);
  const vision = kept && botModelUsable(kept) && kept.model.supportsImages
    ? { providerId: kept.provider.id, modelId: kept.model.id }
    : firstAvailableVisionModel(catalog, providerId);
  return { providerId, modelId, visionProviderId: vision?.providerId, visionModelId: vision?.modelId };
}

/** Picks the photo model; only a usable model that reads images is accepted. */
export function chooseBotVisionModel(
  catalog: BotCapabilityCatalog,
  current: BotModelChoice,
  providerId: string,
  modelId: string,
): BotModelChoice {
  const found = findBotModel(catalog, providerId, modelId);
  if (!found || !botModelUsable(found) || !found.model.supportsImages) return current;
  return { ...current, visionProviderId: providerId, visionModelId: modelId };
}

export function sameBotModelChoice(a: BotModelChoice, b: BotModelChoice): boolean {
  return a.providerId === b.providerId
    && a.modelId === b.modelId
    && a.visionProviderId === b.visionProviderId
    && a.visionModelId === b.visionModelId;
}

/** The Full-access update a new Bot is created with. No model means no model keys. */
export function botFullAccess(
  catalog: BotCapabilityCatalog,
  choice: BotModelChoice,
): { access: BotAccessUpdate; hasModel: boolean } {
  const hasModel = Boolean(choice.providerId && choice.modelId);
  const hasVision = hasModel && Boolean(choice.visionProviderId && choice.visionModelId);
  return {
    hasModel,
    access: {
      accessMode: "full",
      catalogRevision: catalog.revision,
      confirmedForeground: true,
      ...(hasModel ? { providerId: choice.providerId!, modelId: choice.modelId! } : {}),
      ...(hasVision ? { visionModel: { providerId: choice.visionProviderId!, modelId: choice.visionModelId! } } : {}),
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-model-choice.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Register the test file**

In `package.json`, append ` renderer/main/bots/bot-model-choice.test.ts` to the end of the `test:bots` command string. In `scripts/ci-test-registry.json`, add `"renderer/main/bots/bot-model-choice.test.ts",` directly after `"renderer/main/bots/bot-create-flow.test.tsx",`.

Run: `npm run test:ci-policy`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/bots/bot-model-choice.ts renderer/main/bots/bot-model-choice.test.ts package.json scripts/ci-test-registry.json
git commit -m "Bots: shared model and photo-model choice rules"
```

---

### Task 2: `BotModelPicker`

**Files:**
- Create: `renderer/main/bots/bot-model-picker.tsx`
- Test: `renderer/main/bots/bot-model-picker.test.tsx`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json`

**Interfaces:**
- Consumes: `findBotModel`, `botModelUsable` (Task 1); `Button`, `Command`, `CommandEmpty`, `CommandGroup`, `CommandInput`, `CommandItem`, `CommandList`, `InlineMetadata`, `Popover`, `PopoverContent`, `PopoverTrigger` from `renderer/components/ui`; `ProviderIcon` from `renderer/components/provider-icon`.
- Produces:
  - `botModelCapabilityLabel(supportsImages?: boolean): "Reads images" | "Text only"`
  - `BotModelPicker(props: { catalog: BotCapabilityCatalog; label: string; providerId?: string; modelId?: string; imagesOnly?: boolean; recommended?: { providerId: string; modelId: string }; disabled?: boolean; onSelect(providerId: string, modelId: string): void })`. The trigger is a button whose accessible name is `label` and whose visible text is the model's name only.

Provider icons: catalog ids are opaque, so `ProviderIcon` falls back to the provider's initial. Real logos need a non-secret icon slug in the catalog. That is out of scope here; it is recorded in `.memory/bots-rework-ui.md` follow-ups in Task 8.

- [ ] **Step 1: Write the failing tests**

```tsx
// renderer/main/bots/bot-model-picker.test.tsx
import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotCapabilityCatalog } from "../../shared/bot-capabilities";
import { catalogFixture } from "./test-fixtures";
import { BotModelPicker } from "./bot-model-picker";

afterEach(cleanup);

function catalog(): BotCapabilityCatalog {
  const base = catalogFixture();
  return {
    ...base,
    providers: [
      ...base.providers,
      {
        id: "prov-off",
        label: "Signed Out",
        available: false,
        models: [{ id: "model-off", label: "Ghost", available: true, supportsImages: true }],
      },
    ],
  };
}

function mount(props: Partial<React.ComponentProps<typeof BotModelPicker>> = {}) {
  const picks: string[] = [];
  render(
    <BotModelPicker
      catalog={catalog()}
      label="AI model"
      providerId="prov-text"
      modelId="model-text"
      recommended={{ providerId: "prov-text", modelId: "model-text" }}
      onSelect={(providerId, modelId) => picks.push(`${providerId}/${modelId}`)}
      {...props}
    />,
  );
  return picks;
}

test("the trigger names only the model, and marks the recommended one", () => {
  mount();
  const trigger = screen.getByRole("button", { name: "AI model" });
  assert.match(trigger.textContent ?? "", /Writer/u);
  assert.match(trigger.textContent ?? "", /Recommended/u);
  assert.doesNotMatch(trigger.textContent ?? "", /Text only|Reads images/u);
});

test("models are grouped by service; choosing one reports it and closes, unusable ones can't be chosen", async () => {
  const picks = mount();
  fireEvent.click(screen.getByRole("button", { name: "AI model" }));
  assert.ok(await screen.findByText("Vision Service"));
  assert.ok(screen.getByText("Signed Out · Not set up"));

  const ghost = screen.getByRole("option", { name: /^Ghost/u });
  assert.equal(ghost.getAttribute("aria-disabled"), "true");
  fireEvent.click(ghost);
  assert.deepEqual(picks, []);

  fireEvent.click(screen.getByRole("option", { name: /^Seer/u }));
  assert.deepEqual(picks, ["prov-vision/model-vision"]);
  assert.equal(screen.queryByRole("option", { name: /^Seer/u }), null);
});

test("each option says whether the model reads images", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "AI model" }));
  assert.match((await screen.findByRole("option", { name: /^Writer/u })).textContent ?? "", /Text only/u);
  assert.match(screen.getByRole("option", { name: /^Seer/u }).textContent ?? "", /Reads images/u);
});

test("the photo picker lists only models that read images", async () => {
  mount({ label: "Model for photos", imagesOnly: true, providerId: "prov-vision", modelId: "model-vision" });
  fireEvent.click(screen.getByRole("button", { name: "Model for photos" }));
  assert.ok(await screen.findByRole("option", { name: /^Seer/u }));
  assert.equal(screen.queryByRole("option", { name: /^Writer/u }), null);
});

test("typing filters the list", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "AI model" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Filter models" }), { target: { value: "seer" } });
  assert.ok(screen.getByRole("option", { name: /^Seer/u }));
  assert.equal(screen.queryByRole("option", { name: /^Writer/u }), null);
});
```

The file uses JSX types, so add `import type * as React from "react";` as the second import if `tsc` asks for it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-model-picker.test.tsx`
Expected: FAIL, `Cannot find module './bot-model-picker'`.

- [ ] **Step 3: Write the implementation**

```tsx
// renderer/main/bots/bot-model-picker.tsx
import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  InlineMetadata,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui";
import { ProviderIcon } from "../../components/provider-icon";
import type { BotCapabilityCatalog } from "../../shared/bot-capabilities";
import { findBotModel } from "./bot-model-choice";

export function botModelCapabilityLabel(supportsImages: boolean | undefined): "Reads images" | "Text only" {
  return supportsImages ? "Reads images" : "Text only";
}

/**
 * The Bot's model chooser: a one-line trigger naming the model, and a
 * searchable list grouped by service. Models of a service that isn't set up
 * stay listed but can't be chosen.
 */
export function BotModelPicker({
  catalog,
  label,
  providerId,
  modelId,
  imagesOnly = false,
  recommended,
  disabled = false,
  onSelect,
}: {
  catalog: BotCapabilityCatalog;
  /** The trigger's accessible name, e.g. "AI model" or "Model for photos". */
  label: string;
  providerId?: string;
  modelId?: string;
  imagesOnly?: boolean;
  recommended?: { providerId: string; modelId: string };
  disabled?: boolean;
  onSelect(providerId: string, modelId: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = findBotModel(catalog, providerId, modelId);
  const isRecommended = Boolean(
    selected && recommended
      && recommended.providerId === selected.provider.id
      && recommended.modelId === selected.model.id,
  );
  const groups = catalog.providers
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => !imagesOnly || model.supportsImages === true),
    }))
    .filter(({ models }) => models.length > 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="filled"
          size="medium"
          disabled={disabled}
          aria-label={label}
          aria-haspopup="listbox"
          className="w-full min-w-0 max-w-full flex-nowrap justify-start gap-2 whitespace-nowrap"
        >
          {selected ? (
            <ProviderIcon
              providerId={selected.provider.id}
              providerLabel={selected.provider.label}
              className="size-4 shrink-0 text-tertiary"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-left">{selected?.model.label ?? "Choose a model"}</span>
          {isRecommended ? <InlineMetadata className="shrink-0">Recommended</InlineMetadata> : null}
          <ChevronDown className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-1.5rem))] p-0">
        <Command
          label={label}
          onKeyDown={(event) => {
            // Keep Escape for the popover; other keys stay inside the list.
            if (event.key !== "Escape") event.stopPropagation();
          }}
        >
          <CommandInput aria-label="Filter models" placeholder="Filter models…" />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map(({ provider, models }) => (
              <CommandGroup
                key={provider.id}
                heading={provider.available ? provider.label : `${provider.label} · Not set up`}
              >
                {models.map((model) => {
                  const usable = provider.available && model.available;
                  const isSelected = selected?.provider.id === provider.id && selected.model.id === model.id;
                  return (
                    <CommandItem
                      key={model.id}
                      value={`${provider.id}/${model.id}`}
                      keywords={[model.label, provider.label]}
                      disabled={!usable}
                      onSelect={() => {
                        onSelect(provider.id, model.id);
                        setOpen(false);
                      }}
                      className="gap-2"
                    >
                      <ProviderIcon providerId={provider.id} providerLabel={provider.label} className="size-4 shrink-0 text-tertiary" />
                      <span className="min-w-0 flex-1 truncate">{model.label}</span>
                      <InlineMetadata className="shrink-0">{botModelCapabilityLabel(model.supportsImages)}</InlineMetadata>
                      {isSelected ? <Check className="size-4 shrink-0" aria-label="Selected" /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

If `InlineMetadata` does not accept `className`, drop that prop and wrap it in `<span className="shrink-0">…</span>` instead. Check its props in `renderer/components/ui.tsx` first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-model-picker.test.tsx`
Expected: PASS, 5 tests.

If cmdk renders the group heading without the exact text node, change the two heading assertions to `screen.getByText(/Vision Service/u)`. Keep the assertion; it is the oracle that grouping happened.

- [ ] **Step 5: Register and commit**

Append ` renderer/main/bots/bot-model-picker.test.tsx` to `test:bots` in `package.json`. Add `"renderer/main/bots/bot-model-picker.test.tsx",` after the Task 1 entry in `scripts/ci-test-registry.json`.

Run: `npm run test:ci-policy && npx tsc --noEmit`
Expected: both PASS.

```bash
git add renderer/main/bots/bot-model-picker.tsx renderer/main/bots/bot-model-picker.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: searchable Bot model picker"
```

---

### Task 3: AI model in the New Bot dialog

**Files:**
- Modify: `renderer/main/bots/bot-create-flow.tsx`
- Test: `renderer/main/bots/bot-create-flow.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`BotModelChoice`, `botFullAccess`, `chooseBotModel`, `chooseBotVisionModel`, `findBotModel`, `botModelUsable`, `recommendedBotModelChoice`), Task 2 (`BotModelPicker`), `useBotCapabilityCatalog(enabled, botId?)` from `renderer/lib/queries.ts`, `firstAvailableModel`.
- Produces: `recommendedFullAccess(catalog)` stays exported, now `= botFullAccess(catalog, recommendedBotModelChoice(catalog))`, so existing imports keep working.

- [ ] **Step 1: Write the failing tests**

Add to `renderer/main/bots/bot-create-flow.test.tsx`. The existing first test already checks the default access (Writer + Seer); extend it so it also proves the field shows the default. After `const dialog = await fillNameStep(...)` is too late, since the field is on step 1. Insert the check into `fillNameStep` behind an option:

```tsx
async function fillNameStep(name: string, help: string, beforeNext?: (dialog: HTMLElement) => Promise<void>) {
  fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
  const dialog = await screen.findByRole("dialog", { name: "New Bot" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: name } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "What should it help with?" }), {
    target: { value: help },
  });
  await beforeNext?.(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
  return dialog;
}
```

Then add these tests:

```tsx
test("the AI model field starts on the recommended model and its photo model", async () => {
  installBotTestIpc({ "bots:list": () => [], "bots:getCapabilityCatalog": () => catalogFixture() });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  fireEvent.click(await screen.findByRole("button", { name: "New Bot" }));
  const dialog = await screen.findByRole("dialog", { name: "New Bot" });
  const model = await within(dialog).findByRole("button", { name: "AI model" });
  assert.match(model.textContent ?? "", /Writer.*Recommended/u);
  assert.match(within(dialog).getByRole("button", { name: "Model for photos" }).textContent ?? "", /Seer/u);
});

// Test A
test("choosing a model that reads images creates the Bot with it and no photo model", async () => {
  const calls = installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => catalogFixture(),
    "bots:create": () => botFixture({ id: "bot-9", name: "Seer Bot" }),
    "bots:introduce": () => true,
    "bots:get": () => botFixture({ id: "bot-9", name: "Seer Bot" }),
    "bots:live:summary": () => ({ botId: "bot-9", preview: null, updatedAt: null, state: { kind: "idle" } }),
    "bots:live:subscribe": () => liveSnapshot("bot-9", { kind: "idle" }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Seer Bot", "", async (step) => {
    fireEvent.click(await within(step).findByRole("button", { name: "AI model" }));
    fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
    assert.equal(within(step).queryByRole("button", { name: "Model for photos" }), null);
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:create")));
  const { access } = calls.find((call) => call.channel === "bots:create")!.args[0] as { access: BotAccessUpdate };
  assert.equal(access.providerId, "prov-vision");
  assert.equal(access.modelId, "model-vision");
  assert.equal("visionModel" in access, false);
});

// Test B
test("a chosen model that is gone by Create stops on the first step and creates nothing", async () => {
  let catalog = catalogFixture();
  const calls = installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => catalog,
    "bots:create": () => botFixture({ id: "bot-9" }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Seer Bot", "", async (step) => {
    fireEvent.click(await within(step).findByRole("button", { name: "AI model" }));
    fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  });
  // Seer's service is signed out before Create.
  catalog = {
    ...catalog,
    providers: catalog.providers.map((provider) =>
      provider.id === "prov-vision" ? { ...provider, available: false } : provider),
  };
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

  const step1 = await screen.findByRole("dialog", { name: "New Bot" });
  assert.ok(await within(step1).findByText("That model isn’t available any more. Choose another one."));
  assert.equal(calls.some((call) => call.channel === "bots:create"), false);
});

// Test C
test("if the models can't be loaded the field says so, and the Bot is still created with the recommended model", async () => {
  let failCatalog = true;
  const calls = installBotTestIpc({
    "bots:list": () => [],
    "bots:getCapabilityCatalog": () => {
      if (failCatalog) throw new Error("offline");
      return catalogFixture();
    },
    "bots:create": () => botFixture({ id: "bot-9", name: "Planner" }),
    "bots:introduce": () => true,
    "bots:get": () => botFixture({ id: "bot-9", name: "Planner" }),
    "bots:live:summary": () => ({ botId: "bot-9", preview: null, updatedAt: null, state: { kind: "idle" } }),
    "bots:live:subscribe": () => liveSnapshot("bot-9", { kind: "idle" }),
  });
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  const dialog = await fillNameStep("Planner", "", async (step) => {
    assert.ok(await within(step).findByText("Aiden couldn’t load your models."));
    assert.ok(within(step).getByRole("button", { name: "Try again" }));
    failCatalog = false;
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:create")));
  const { access } = calls.find((call) => call.channel === "bots:create")!.args[0] as { access: BotAccessUpdate };
  assert.equal(access.modelId, "model-text");
});
```

Extend the existing "with no AI model…" test. Right after `const dialog = await fillNameStep("Researcher", "")`, the dialog is already on step 2, so pass a `beforeNext` instead:

```tsx
  const dialog = await fillNameStep("Researcher", "", async (step) => {
    assert.ok(await within(step).findByText(/No AI model set up yet/u));
    assert.ok(within(step).getByRole("button", { name: "Set up…" }));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-create-flow.test.tsx`
Expected: the new tests FAIL (no "AI model" button). The old tests still pass.

- [ ] **Step 3: Implement**

In `renderer/main/bots/bot-create-flow.tsx`:

1. Imports. Add:

```tsx
import { useNavigate } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "../../components/ui"; // merge into the existing ui import
import { useBotCapabilityCatalog } from "../../lib/queries";
import {
  botFullAccess,
  botModelUsable,
  chooseBotModel,
  chooseBotVisionModel,
  findBotModel,
  recommendedBotModelChoice,
  type BotModelChoice,
} from "./bot-model-choice";
import { BotModelPicker } from "./bot-model-picker";
```

Then remove `firstAvailableVisionModel` from the `./bot-access-draft` import, since it becomes unused. Keep `firstAvailableModel`.

2. Replace the body of `recommendedFullAccess` (keep its doc comment and export):

```tsx
export function recommendedFullAccess(catalog: BotCapabilityCatalog): {
  access: BotAccessUpdate;
  hasModel: boolean;
} {
  return botFullAccess(catalog, recommendedBotModelChoice(catalog));
}
```

3. Add the field component above `BotCreateFlow`:

```tsx
export const BOT_MODEL_GONE_MESSAGE = "That model isn’t available any more. Choose another one.";

/** Step 1's AI model: the recommended model by default, changeable before Create. */
function CreateModelField({
  catalog,
  choice,
  disabled,
  onChange,
  onSetUp,
}: {
  catalog: UseQueryResult<BotCapabilityCatalog>;
  choice: BotModelChoice;
  disabled: boolean;
  onChange(next: BotModelChoice): void;
  onSetUp(): void;
}) {
  const title = (
    <Text as="span" variant="small-strong">
      AI model
    </Text>
  );
  if (catalog.isLoading) {
    return (
      <div className="flex flex-col gap-1.5">
        {title}
        <span role="status" aria-label="Loading models" className="block h-8 rounded-control bg-control motion-safe:animate-pulse" />
      </div>
    );
  }
  if (catalog.isError || !catalog.data) {
    return (
      <div className="flex flex-col gap-1.5">
        {title}
        <div className="flex items-center gap-2">
          <Text as="p" variant="small" color="secondary" className="flex-1">
            Aiden couldn’t load your models.
          </Text>
          <Button size="small" variant="filled" onClick={() => void catalog.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const data = catalog.data;
  const recommended = firstAvailableModel(data);
  if (!recommended) {
    return (
      <div className="flex flex-col gap-1.5">
        {title}
        <div className="flex items-center gap-2">
          <Text as="p" variant="small" color="secondary" className="flex-1">
            No AI model set up yet. You can still create it; it asks for one when you open it.
          </Text>
          <Button size="small" variant="filled" onClick={onSetUp}>
            Set up…
          </Button>
        </div>
      </div>
    );
  }
  const primary = findBotModel(data, choice.providerId, choice.modelId);
  const needsPhotoModel = primary !== undefined && primary.model.supportsImages !== true;
  return (
    <div className="flex flex-col gap-1.5">
      {title}
      <BotModelPicker
        catalog={data}
        label="AI model"
        providerId={choice.providerId}
        modelId={choice.modelId}
        recommended={recommended}
        disabled={disabled}
        onSelect={(providerId, modelId) => onChange(chooseBotModel(data, choice, providerId, modelId))}
      />
      {needsPhotoModel ? (
        choice.visionProviderId && choice.visionModelId ? (
          <>
            <Text as="span" variant="small-strong" className="mt-2">
              For photos
            </Text>
            <BotModelPicker
              catalog={data}
              label="Model for photos"
              imagesOnly
              providerId={choice.visionProviderId}
              modelId={choice.visionModelId}
              disabled={disabled}
              onSelect={(providerId, modelId) => onChange(chooseBotVisionModel(data, choice, providerId, modelId))}
            />
            <Text as="p" variant="small" color="secondary">
              {primary.model.label} reads text only, so photos and screenshots go here.
            </Text>
          </>
        ) : (
          <Text as="p" variant="small" color="secondary">
            {primary.model.label} reads text only, and no model that reads images is set up.
          </Text>
        )
      ) : null}
    </div>
  );
}
```

4. Inside `BotCreateFlow`, add state and wiring:

```tsx
  const navigate = useNavigate();
  const catalogQuery = useBotCapabilityCatalog(open);
  // null = the recommended model, worked out from the latest catalog.
  const [choice, setChoice] = React.useState<BotModelChoice | null>(null);
  const shownChoice = choice ?? (catalogQuery.data ? recommendedBotModelChoice(catalogQuery.data) : {});
  const openProviders = () => {
    onOpenChange(false);
    void navigate({ to: "/settings", search: { section: "providers" } });
  };
```

Add `setChoice(null);` to the reset effect that runs when `open` changes.

5. In `create`, replace `const { access, hasModel } = recommendedFullAccess(catalog);` with:

```tsx
      let picked: BotModelChoice;
      if (choice) {
        const found = findBotModel(catalog, choice.providerId, choice.modelId);
        if (!found || !botModelUsable(found)) {
          setError(BOT_MODEL_GONE_MESSAGE);
          setStep(1);
          void qc.invalidateQueries({ queryKey: queryKeys.botCapabilityCatalog });
          return;
        }
        // Re-checks the photo model against the fresh catalog too.
        picked = chooseBotModel(catalog, choice, found.provider.id, found.model.id);
      } else {
        picked = recommendedBotModelChoice(catalog);
      }
      const { access, hasModel } = botFullAccess(catalog, picked);
```

The `return` inside `try` still runs `finally`, which clears `busy`.

6. In step 1's JSX, insert the field after the "What should it help with?" block and before the "It can use everything…" text:

```tsx
            <CreateModelField
              catalog={catalogQuery}
              choice={shownChoice}
              disabled={busy}
              onChange={setChoice}
              onSetUp={openProviders}
            />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-create-flow.test.tsx`
Expected: PASS. The original tests are unchanged in behaviour: the default access still equals Writer + Seer.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add renderer/main/bots/bot-create-flow.tsx renderer/main/bots/bot-create-flow.test.tsx
git commit -m "Bots: choose the AI model when creating a Bot on the Mac"
```

---

### Task 4: Advanced uses the same picker (fixes the wrapping select)

**Files:**
- Modify: `renderer/main/bots/bot-advanced.tsx` (`withRecommendedModel`, `ModelSection`)
- Test: `renderer/main/bots/bot-profile.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–2. `BotAccessDraft` has `providerId`, `modelId`, `visionProviderId`, `visionModelId` (from `renderer/shared/bot-editor-save.ts`).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Update the existing Advanced test and add the failing one**

In `bot-profile.test.tsx`, test "Advanced shows the model, image model, access and Telegram controls, and no opening greeting", replace the three combobox assertions with:

```tsx
  const model = await screen.findByRole("button", { name: "AI model" });
  assert.match(model.textContent ?? "", /Writer/u);
  assert.ok(screen.getByRole("button", { name: "Model for photos" }));
  assert.equal(screen.queryByRole("combobox", { name: "AI service" }), null);
```

Add a new test after it:

```tsx
test("Advanced names only the model in its control, says what it reads under the label, and saves a new choice", async () => {
  const { accessUpdates } = advancedIpc();
  await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-1?page=advanced" });
  const model = await screen.findByRole("button", { name: "AI model" });
  assert.doesNotMatch(model.textContent ?? "", /Text only|Reads images/u);
  assert.ok(screen.getByText("Text only"), "the capability is the row's description");

  fireEvent.click(model);
  fireEvent.click(await screen.findByRole("option", { name: /^Seer/u }));
  assert.equal(screen.queryByRole("button", { name: "Model for photos" }), null, "Seer reads images");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(accessUpdates.length, 1));
  const sent = JSON.stringify(accessUpdates[0]);
  assert.match(sent, /"modelId":"model-vision"/u);
  assert.doesNotMatch(sent, /visionModel/u);
});
```

Add `waitFor` to the Testing Library import if it is not already there.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test renderer/main/bots/bot-profile.test.tsx`
Expected: the two Advanced tests FAIL (no "AI model" button).

- [ ] **Step 3: Implement**

In `bot-advanced.tsx`:

1. Delete `withRecommendedModel` (lines ~59–73).
2. Import `chooseBotModel`, `chooseBotVisionModel`, `findBotModel`, `recommendedBotModelChoice`, `sameBotModelChoice` from `./bot-model-choice` and `BotModelPicker`, `botModelCapabilityLabel` from `./bot-model-picker`. Remove imports that become unused: `Select*` (if no other section uses them; the Telegram section does, so keep them if so), `InlineMetadata` (if unused), and `firstAvailableVisionModel`.
3. Replace `ModelSection`'s body from `const provider = …` through the end of its `return` with:

```tsx
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
```

`recommended` always carries all four keys when a model exists, so spreading it clears a stale photo model.

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test renderer/main/bots/bot-profile.test.tsx`
Expected: PASS, including "Advanced saves access with the toolbar's one Save…" and "Advanced Back with an unsaved access change…".

- [ ] **Step 5: Visual check of the original bug**

Run the app (`npm run dev`, or use the `run` skill), open a Bot → ••• → Advanced with a long model name such as DeepSeek V4 Flash Vision Exp, in light and dark. Confirm:
- the control is one line, with an ellipsis and the chevron on the same line;
- "Reads images" or "Text only" sits under the "Model" label;
- keyboard Tab shows the focus ring on the trigger;
- the filter field has no accent ring.

Note the result in the PR description.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/bots/bot-advanced.tsx renderer/main/bots/bot-profile.test.tsx
git commit -m "Bots: Advanced uses the Bot model picker; the model control no longer wraps"
```

---

### Task 5: Memory and Advanced in every desktop ••• menu

**Files:**
- Modify: `renderer/main/bots/bot-chat-header.tsx`, `renderer/main/bots/bot-chat-pane.tsx`, `renderer/main/bots/bot-list.tsx`, `renderer/main/bots-view.tsx`
- Test: `renderer/main/bots/bot-chat-header.test.tsx`, `renderer/main/bots/bot-list.test.tsx`

**Interfaces:**
- Consumes: `BotSubpage` (`"instructions" | "advanced" | "memory"`) from `renderer/main/bots/bot-page-search.ts`.
- Produces:
  - `BotChatActions` gains optional `onOpenMemory?(): void` and `onOpenAdvanced?(): void`.
  - `BotList` gains optional `onOpenPage?(bot: BotDefinition, page: "memory" | "advanced"): void`.

- [ ] **Step 1: Write the failing tests**

In `bot-chat-header.test.tsx`, pass the new handlers in `renderHeader`:

```tsx
        onOpenMemory={() => calls.push("memory")}
        onOpenAdvanced={() => calls.push("advanced")}
```

Replace the menu test with:

```tsx
test("the ••• menu offers Profile, Files, Memory, Advanced and Delete Bot, in that order", async () => {
  const calls = renderHeader();
  const more = screen.getByRole("button", { name: "More for SLMob" });
  fireEvent.keyDown(more, { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Profile", "Files", "Memory", "Advanced", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Advanced" }));
  assert.deepEqual(calls, ["advanced"]);
});
```

In `bot-list.test.tsx`, add `onOpenPage={(value, page) => calls.push(`${page}:${value.id}`)}` to `renderList`'s `BotList` props. Update the "each row's ••• button…" test:

```tsx
test("each row's ••• button reaches Profile, Memory, Advanced and Delete Bot without a right-click", async () => {
  const calls = renderList([{ bot: bot("b1", "Planner") }]);
  const more = screen.getByRole("button", { name: "More for Planner" });
  fireEvent.keyDown(more, { key: "Enter" });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Profile", "Memory", "Advanced", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Advanced" }));
  assert.deepEqual(calls, ["advanced:b1"], "the menu acts on its Bot without opening the chat");
});
```

In the context-menu test, append before its final assertion:

```tsx
  fireEvent.contextMenu(screen.getByRole("button", { name: /^Planner/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
```

and change that assertion to `["open:b2", "profile:b1", "delete:b1", "memory:b1"]`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-chat-header.test.tsx renderer/main/bots/bot-list.test.tsx`
Expected: FAIL (menu lists lack Memory and Advanced).

- [ ] **Step 3: Implement**

`bot-chat-header.tsx`, in `BotChatActions`:

```tsx
export function BotChatActions({
  bot,
  onOpenProfile,
  onOpenFiles,
  onOpenMemory,
  onOpenAdvanced,
  onDelete,
}: {
  bot: Pick<BotDefinition, "name">;
  onOpenProfile(): void;
  onOpenFiles?(): void;
  onOpenMemory?(): void;
  onOpenAdvanced?(): void;
  onDelete(): void;
}) {
```

Menu body:

```tsx
        <DropdownMenuItem onSelect={onOpenProfile}>Profile</DropdownMenuItem>
        {onOpenFiles ? <DropdownMenuItem onSelect={onOpenFiles}>Files</DropdownMenuItem> : null}
        {onOpenMemory ? <DropdownMenuItem onSelect={onOpenMemory}>Memory</DropdownMenuItem> : null}
        {onOpenAdvanced ? <DropdownMenuItem onSelect={onOpenAdvanced}>Advanced</DropdownMenuItem> : null}
        <DropdownMenuSeparator />
```

Update its doc comment to "Profile, Files, Memory, Advanced and Delete Bot."

`bot-chat-pane.tsx`: `openAdvanced` and `openMemory` are declared after the JSX that builds the header (around lines 526 and 643). Move both `const` declarations above the `shell` helper that renders `BotChatActions`, then pass:

```tsx
            onOpenMemory={openMemory}
            onOpenAdvanced={openAdvanced}
```

`bot-list.tsx`: add `onOpenPage` to `BotRowMenuItems`, `BotListItem` and `BotList` props (optional, typed `(bot: BotDefinition, page: "memory" | "advanced") => void`), threaded the same way `onOpenProfile` is. In `BotRowMenuItems`:

```tsx
      <Item onSelect={() => onOpenProfile(bot)}>Profile</Item>
      {onOpenPage ? <Item onSelect={() => onOpenPage(bot, "memory")}>Memory</Item> : null}
      {onOpenPage ? <Item onSelect={() => onOpenPage(bot, "advanced")}>Advanced</Item> : null}
      <Separator />
```

`bots-view.tsx`, in the `BotList` props:

```tsx
          onOpenPage={(bot, page) => void navigate({ to: "/bots/$botId", params: { botId: bot.id }, search: { page } })}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx tsx --test renderer/main/bots/bot-chat-header.test.tsx renderer/main/bots/bot-list.test.tsx renderer/main/bots/bot-chat-pane.test.tsx renderer/main/bots/bots-home.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/main/bots/bot-chat-header.tsx renderer/main/bots/bot-chat-header.test.tsx renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-list.tsx renderer/main/bots/bot-list.test.tsx renderer/main/bots-view.tsx
git commit -m "Bots: Memory and Advanced in every desktop ••• menu"
```

---

### Task 6: iOS — model choice in New Bot and Advanced, Memory/Advanced in •••

**Files:**
- Modify: `ios/AidenOnTheGo/Features/Bots/AidenBotSettingsDraft.swift`, `AidenBotAdvancedView.swift`, `AidenBotCreateView.swift`, `AidenBotSessionChatView.swift`
- Test: `ios/AidenOnTheGoTests/AidenBotHomeProfileTests.swift`

New views go in the existing `AidenBotAdvancedView.swift`, so the Xcode project file needs no new file references.

**Interfaces:**
- Consumes: `AidenBotEditorDraft` (`customAccess.providerID/modelID`, `visionProviderID/visionModelID`, `reconcileVisionSelection(catalog:)`), `AidenBotCapabilityCatalog.model(providerId:modelId:)`, `AidenBotCustomAccessDraft(catalog:)`, `AidenProviderIcon(providerID:providerLabel:size:)`.
- Produces:
  - `AidenBotEditorDraft.selectModel(providerID:modelID:catalog:) -> Bool` and `selectVisionModel(providerID:modelID:catalog:) -> Bool`.
  - `struct AidenBotModelListSection: Identifiable { provider; models }`.
  - `func aidenBotModelListSections(catalog:imagesOnly:query:) -> [AidenBotModelListSection]`.
  - `struct AidenBotModelRow: View` and `struct AidenBotModelListView: View`.

- [ ] **Step 1: Write the failing tests**

Add to `AidenBotHomeProfileTests.swift`:

```swift
    // MARK: Model choice (New Bot and Advanced)

    private func fixtureCatalog() throws -> AidenBotCapabilityCatalog {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: JSONSerialization.data(withJSONObject: try XCTUnwrap(object["botCapabilityCatalog"]))
        )
    }

    /// The fixture has a text-only `model_fixture` and an image-reading
    /// `vision_model_fixture` under `provider_fixture`.
    func testChoosingAModelPairsAPhotoModelOnlyWhenItReadsTextOnly() throws {
        let catalog = try fixtureCatalog()
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: catalog, defaultAccess: .recommended))

        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft.visionModelID, "vision_model_fixture")

        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "vision_model_fixture", catalog: catalog))
        XCTAssertNil(draft.visionModelID)

        XCTAssertFalse(draft.selectModel(providerID: "provider_fixture", modelID: "missing", catalog: catalog))
        XCTAssertEqual(draft.customAccess.modelID, "vision_model_fixture", "an unknown model changes nothing")
        XCTAssertFalse(draft.selectVisionModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog),
                       "a text-only model can't read photos")

        draft.name = "Seer"
        let request = try draft.createRequest(catalog: catalog)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let access = try XCTUnwrap(body["access"] as? [String: Any])
        XCTAssertEqual(access["modelId"] as? String, "vision_model_fixture", "Create sends the chosen model")
    }

    func testModelListOffersOnlyImageModelsForPhotosAndFiltersBySearch() throws {
        let catalog = try fixtureCatalog()
        XCTAssertEqual(
            aidenBotModelListSections(catalog: catalog, imagesOnly: true, query: "").flatMap { $0.models.map(\.id) },
            ["vision_model_fixture"]
        )
        XCTAssertEqual(
            aidenBotModelListSections(catalog: catalog, imagesOnly: false, query: "VISION").flatMap { $0.models.map(\.id) },
            ["vision_model_fixture"]
        )
        XCTAssertTrue(aidenBotModelListSections(catalog: catalog, imagesOnly: false, query: "zzz").isEmpty)
    }
```

If the Full-access wire keys differ from `modelId` (check `AidenBotAccessUpdate`'s `CodingKeys`), use the encoded key name. The assertion stays "Create sends the chosen model".

- [ ] **Step 2: Run to verify they fail**

Run:
```bash
xcodebuild test -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO -only-testing:AidenOnTheGoTests/AidenBotHomeProfileTests
```
Expected: build FAILS (`selectModel` and `aidenBotModelListSections` not found).

- [ ] **Step 3: Implement the draft methods**

In `AidenBotSettingsDraft.swift`, inside `struct AidenBotEditorDraft`, after `reconcileVisionSelection`:

```swift
    /// Picks the Bot's model and keeps a photo model only while it is needed.
    /// A model the Mac can't run changes nothing and returns false.
    @discardableResult
    mutating func selectModel(providerID: String, modelID: String, catalog: AidenBotCapabilityCatalog) -> Bool {
        guard let provider = catalog.providers.first(where: { $0.id == providerID }), provider.available,
              provider.models.contains(where: { $0.id == modelID && $0.available }) else { return false }
        customAccess.providerID = providerID
        customAccess.modelID = modelID
        reconcileVisionSelection(catalog: catalog)
        return true
    }

    /// Picks the model photos and screenshots go to; only a usable model that reads images.
    @discardableResult
    mutating func selectVisionModel(providerID: String, modelID: String, catalog: AidenBotCapabilityCatalog) -> Bool {
        guard let provider = catalog.providers.first(where: { $0.id == providerID }), provider.available,
              provider.models.contains(where: { $0.id == modelID && $0.available && $0.supportsImages })
        else { return false }
        visionProviderID = providerID
        visionModelID = modelID
        return true
    }
```

- [ ] **Step 4: Implement the shared views**

Append to `AidenBotAdvancedView.swift`:

```swift
// MARK: - Model choice (New Bot and Advanced)

struct AidenBotModelListSection: Identifiable {
    let provider: AidenBotProviderOption
    let models: [AidenBotModelOption]
    var id: String { provider.id }
}

/// The Mac's models grouped by service, optionally only those that read images,
/// filtered by a search that matches the model or service name.
func aidenBotModelListSections(
    catalog: AidenBotCapabilityCatalog,
    imagesOnly: Bool,
    query: String
) -> [AidenBotModelListSection] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return catalog.providers.compactMap { provider in
        let models = provider.models.filter { model in
            (!imagesOnly || model.supportsImages)
                && (needle.isEmpty
                    || model.label.localizedCaseInsensitiveContains(needle)
                    || provider.label.localizedCaseInsensitiveContains(needle))
        }
        return models.isEmpty ? nil : AidenBotModelListSection(provider: provider, models: models)
    }
}

/// A row naming the chosen model; it pushes the model list.
struct AidenBotModelRow: View {
    let title: String
    let catalog: AidenBotCapabilityCatalog
    let providerID: String?
    let modelID: String?
    var imagesOnly = false
    var recommended: AidenBotModelSelection? = nil
    let onSelect: (String, String) -> Void

    @Environment(\.aidenPalette) private var palette

    private var current: (provider: AidenBotProviderOption, model: AidenBotModelOption)? {
        guard let provider = catalog.providers.first(where: { $0.id == providerID }),
              let model = provider.models.first(where: { $0.id == modelID }) else { return nil }
        return (provider, model)
    }

    var body: some View {
        NavigationLink {
            AidenBotModelListView(
                title: title, catalog: catalog, providerID: providerID, modelID: modelID,
                imagesOnly: imagesOnly, recommended: recommended, onSelect: onSelect
            )
        } label: {
            HStack(spacing: 8) {
                Text(title).foregroundStyle(palette.foreground)
                Spacer(minLength: 8)
                if let current {
                    AidenProviderIcon(providerID: current.provider.id, providerLabel: current.provider.label, size: 18)
                    Text(current.model.label).foregroundStyle(palette.secondary).lineLimit(1)
                } else {
                    Text("Choose").foregroundStyle(palette.secondary)
                }
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue(current?.model.label ?? "None")
    }
}

/// The Mac's models: Recommended first, then one section per service.
struct AidenBotModelListView: View {
    let title: String
    let catalog: AidenBotCapabilityCatalog
    let providerID: String?
    let modelID: String?
    let imagesOnly: Bool
    let recommended: AidenBotModelSelection?
    let onSelect: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var query = ""

    var body: some View {
        List {
            if query.isEmpty, let recommended,
               let provider = catalog.providers.first(where: { $0.id == recommended.providerId }),
               let model = provider.models.first(where: { $0.id == recommended.modelId }),
               !imagesOnly || model.supportsImages {
                Section("Recommended") { row(provider, model) }
            }
            ForEach(aidenBotModelListSections(catalog: catalog, imagesOnly: imagesOnly, query: query)) { section in
                Section {
                    ForEach(section.models) { model in row(section.provider, model) }
                } header: {
                    HStack(spacing: 6) {
                        AidenProviderIcon(providerID: section.provider.id, providerLabel: section.provider.label, size: 14)
                        Text(section.provider.available ? section.provider.label : "\(section.provider.label) · Not set up")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .searchable(text: $query, prompt: "Search models")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ provider: AidenBotProviderOption, _ model: AidenBotModelOption) -> some View {
        let usable = provider.available && model.available
        let isSelected = provider.id == providerID && model.id == modelID
        return Button {
            onSelect(provider.id, model.id)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.label).foregroundStyle(palette.foreground)
                    Text(usable ? (model.supportsImages ? "Reads images" : "Text only") : "Set up on your Mac")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityLabel("Selected")
                }
            }
        }
        .disabled(!usable)
    }
}
```

If `AidenBotModelSelection` is not the Swift name of the `{providerId, modelId}` value (search `struct AidenBotModelSelection` in `ios/AidenOnTheGo/Models/AidenBot.swift`), use the type the draft's `visionSelection` returns. If `supportsImages` is optional in Swift, compare with `== true`.

- [ ] **Step 5: Use them in Advanced**

In `AidenBotAdvancedView.modelSection(_:)`, replace the `Picker("AI", …)`, `Picker("Model", …)`, `Picker("Photos", …)` and `Picker("Photo model", …)` blocks (keep the "To look at photos…" text and "Use recommended") with:

```swift
            AidenBotModelRow(
                title: "Model",
                catalog: catalog,
                providerID: draft?.customAccess.providerID,
                modelID: draft?.customAccess.modelID,
                recommended: recommendedDraft(catalog).map {
                    AidenBotModelSelection(providerId: $0.customAccess.providerID, modelId: $0.customAccess.modelID)
                }
            ) { providerID, modelID in
                draft?.selectModel(providerID: providerID, modelID: modelID, catalog: catalog)
            }
            if selectedPrimaryModel(in: catalog)?.supportsImages == false {
                if visionProviders(in: catalog).isEmpty {
                    Text("To look at photos, add an AI that can see images on your Mac.")
                        .foregroundStyle(palette.secondary)
                } else {
                    AidenBotModelRow(
                        title: "Photos",
                        catalog: catalog,
                        providerID: draft?.visionProviderID,
                        modelID: draft?.visionModelID,
                        imagesOnly: true
                    ) { providerID, modelID in
                        draft?.selectVisionModel(providerID: providerID, modelID: modelID, catalog: catalog)
                    }
                }
            }
```

Delete the now-unused `providerBinding`, `modelBinding`, `visionProviderBinding`, `visionModelBinding` and `selectedVisionProvider`.

- [ ] **Step 6: Use them in New Bot**

In `AidenBotCreateView.content`, inside `Form { … }` after the existing `Section`, add:

```swift
                if let catalog, let current = draft {
                    Section {
                        AidenBotModelRow(
                            title: "Model",
                            catalog: catalog,
                            providerID: current.customAccess.providerID,
                            modelID: current.customAccess.modelID,
                            recommended: AidenBotCustomAccessDraft(catalog: catalog).map {
                                AidenBotModelSelection(providerId: $0.providerID, modelId: $0.modelID)
                            }
                        ) { providerID, modelID in
                            retainedAttempt = nil
                            retainedCreatedBot = nil
                            draft?.selectModel(providerID: providerID, modelID: modelID, catalog: catalog)
                        }
                        if catalog.model(providerId: current.customAccess.providerID,
                                         modelId: current.customAccess.modelID)?.supportsImages == false,
                           current.visionProviderID != nil {
                            AidenBotModelRow(
                                title: "Photos",
                                catalog: catalog,
                                providerID: current.visionProviderID,
                                modelID: current.visionModelID,
                                imagesOnly: true
                            ) { providerID, modelID in
                                retainedAttempt = nil
                                retainedCreatedBot = nil
                                draft?.selectVisionModel(providerID: providerID, modelID: modelID, catalog: catalog)
                            }
                        }
                    } header: {
                        Text("AI model")
                    } footer: {
                        Text("You can change this later in Advanced.")
                    }
                }
```

- [ ] **Step 7: Memory and Advanced in the chat •••**

In `AidenBotSessionChatView.moreMenu`, after the Files button:

```swift
            if AidenBotHostFeature.isAdvertised(AidenBotHostFeature.memory, coordinator: coordinator) {
                Button {
                    profileOpensMemory = true
                    isShowingProfile = true
                } label: {
                    Label("Memory", systemImage: AidenBotMemorySymbol.name)
                }
            }
            Button {
                isShowingAdvanced = true
            } label: {
                Label("Advanced", systemImage: "slider.horizontal.3")
            }
```

Also change the menu's doc comment to "Profile, Files, Memory, Advanced and Delete for this Bot."

- [ ] **Step 8: Run to verify the tests pass**

Run the Step 2 command, then the whole Bot suite:
```bash
xcodebuild test -quiet -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO -only-testing:AidenOnTheGoTests/AidenBotHomeProfileTests -only-testing:AidenOnTheGoTests/AidenBotContractTests -parallel-testing-enabled NO
```
Expected: PASS. Run serially (`-parallel-testing-enabled NO`); the parallel launch flake on Xcode-beta is recorded in `.memory/bots-rework-ui.md`.

- [ ] **Step 9: Look at it in the Simulator**

Use the iOS Simulator tool: `attach`, build and `launch`. Then New Bot → Model → pick a text-only model, and check that Photos appears. In a chat, open ••• → Advanced and confirm the Model row. Take a screenshot for the PR.

- [ ] **Step 10: Commit**

```bash
git add ios/AidenOnTheGo/Features/Bots ios/AidenOnTheGoTests/AidenBotHomeProfileTests.swift
git commit -m "iOS Bots: choose the AI model in New Bot and Advanced; Memory and Advanced in •••"
```

---

### Task 7: Android — model choice in New Bot and Advanced, Memory/Advanced in •••

**Files:**
- Create: `android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotModelChoice.kt`
- Modify: `features/bots/AidenBotEditorScreen.kt`, `features/bots/AidenBotAdvancedScreen.kt`, `features/bots/AidenBotChatHeader.kt`, `features/bots/AidenBotSessionScreen.kt`, `android/app/src/main/res/values/strings.xml`
- Test: Create `android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotModelChoiceTest.kt`

Android has no photo-model choice today. Its Advanced saves only the primary model, so this task adds none.

**Interfaces:**
- Consumes: `AidenModelPickerField(title, providers, selection, onSelect)`, `AidenModelPickerProvider/Model`, `AidenModelCapability.VISION`, `AidenModelRoute` (all in `features/shared`); `AidenBotCapabilityCatalog.containsAvailable(providerId, modelId)`; `AidenBotAccessUpdate.full(revision, AidenBotModelSelection)`; `AidenBotCustomAccessDraft.fromCatalog`.
- Produces:
  - `aidenBotModelPickerProviders(catalog): List<AidenModelPickerProvider>`
  - `aidenBotRecommendedModel(catalog): AidenModelRoute?`
  - `AidenBotCreateDraft.model: AidenModelRoute?`
  - `AidenBotCreateDraft.request(catalog: AidenBotCapabilityCatalog? = null)`
  - `AidenBotChatTopBar` params `onOpenMemory: (() -> Unit)? = null` and `onOpenAdvanced: (() -> Unit)? = null`

- [ ] **Step 1: Write the failing tests**

```kotlin
// android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotModelChoiceTest.kt
package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.AidenRemoteContractFixture
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelCapability
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.models.AidenBotAccessMode

class AidenBotModelChoiceTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val catalog by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        json.decodeFromString<AidenRemoteContractFixture>(text).botCapabilityCatalog
    }

    @Test
    fun pickerListsEveryModelMarksImageReadersAndDisablesOnesTheMacCannotRun() {
        val signedOut = catalog.copy(providers = catalog.providers.map { it.copy(available = false) })
        val models = aidenBotModelPickerProviders(signedOut).flatMap { it.models }
        assertEquals(listOf("model_fixture", "vision_model_fixture"), models.map { it.id })
        assertTrue(models.none { it.available })
        val live = aidenBotModelPickerProviders(catalog).flatMap { it.models }.associateBy { it.id }
        assertEquals(listOf(AidenModelCapability.VISION), live.getValue("vision_model_fixture").capabilities)
        assertTrue(live.getValue("model_fixture").capabilities.isEmpty())
    }

    @Test
    fun recommendedModelIsTheFirstOneTheMacCanRun() {
        assertEquals(AidenModelRoute("provider_fixture", "model_fixture"), aidenBotRecommendedModel(catalog))
    }

    @Test
    fun createWithoutAChoiceLeavesAccessToTheMacAndAChoiceIsSentAsFullAccess() {
        val draft = AidenBotCreateDraft(name = "Seer")
        assertNull(draft.request(catalog)!!.access)

        val chosen = draft.copy(model = AidenModelRoute("provider_fixture", "vision_model_fixture")).request(catalog)!!
        assertEquals(AidenBotAccessMode.FULL, chosen.access!!.accessMode)
        assertEquals("vision_model_fixture", chosen.access!!.modelId)
        assertEquals(catalog.revision, chosen.access!!.catalogRevision)
    }

    @Test
    fun aChoiceTheMacCannotRunCannotBeCreated() {
        val draft = AidenBotCreateDraft(name = "Seer", model = AidenModelRoute("provider_fixture", "missing"))
        assertNull(draft.request(catalog))
        assertNull(draft.copy(model = AidenModelRoute("provider_fixture", "model_fixture")).request(null))
        assertFalse(AidenBotCreateDraft(name = "").canCreate)
    }
}
```

`AidenRemoteContractFixture` lives in the test sources. If it isn't in package `sbtbiswas.AidenOnTheGo`, fix the import to its package (see `AidenBotContractTest.kt`).

- [ ] **Step 2: Run to verify they fail**

```bash
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --tests '*AidenBotModelChoiceTest*' --console=plain
```
Expected: compile FAILURE (`aidenBotModelPickerProviders`, `model` not found).

- [ ] **Step 3: Implement the mapping**

```kotlin
// android/app/src/main/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotModelChoice.kt
package sbtbiswas.AidenOnTheGo.features.bots

import sbtbiswas.AidenOnTheGo.features.shared.AidenModelCapability
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelPickerModel
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelPickerProvider
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.models.AidenBotCapabilityCatalog

/**
 * The Mac's Bot models as the shared picker lists them. Models the Mac can't
 * run right now stay listed but disabled, so the list matches the desktop.
 */
fun aidenBotModelPickerProviders(catalog: AidenBotCapabilityCatalog): List<AidenModelPickerProvider> =
    catalog.providers.map { provider ->
        AidenModelPickerProvider(
            id = provider.id,
            label = provider.label,
            models = provider.models.map { model ->
                AidenModelPickerModel(
                    id = model.id,
                    label = model.label,
                    capabilities = if (model.supportsImages == true) listOf(AidenModelCapability.VISION) else emptyList(),
                    available = provider.available && model.available
                )
            }
        )
    }.filter { it.models.isNotEmpty() }

/** The model a new Bot starts with: the first one the Mac can run. */
fun aidenBotRecommendedModel(catalog: AidenBotCapabilityCatalog): AidenModelRoute? =
    AidenBotCustomAccessDraft.fromCatalog(catalog)?.let { AidenModelRoute(it.providerID, it.modelID) }
```

- [ ] **Step 4: Implement the create draft and screen**

In `AidenBotEditorScreen.kt`, change `AidenBotCreateDraft`:

```kotlin
data class AidenBotCreateDraft(
    val name: String = "",
    val help: String = "",
    /** Null keeps the Mac's recommended model (access omitted, Full). */
    val model: AidenModelRoute? = null
) {
    val canCreate: Boolean
        get() = name.isNotBlank()

    /**
     * The create request. With no [model] chosen, access is omitted and the Mac
     * uses Full access with its recommended model. A chosen model is sent as Full
     * access and needs the [catalog] it came from; one the Mac can't run gives null.
     */
    fun request(catalog: AidenBotCapabilityCatalog? = null): AidenBotCreateRequest? {
        if (!canCreate) return null
        val access = model?.let { route ->
            val cat = catalog ?: return null
            if (!cat.containsAvailable(route.providerId, route.modelId)) return null
            AidenBotAccessUpdate.full(cat.revision, AidenBotModelSelection(providerId = route.providerId, modelId = route.modelId))
        }
        val trimmedName = name.trim().take(AidenBotWire.MAX_NAME_LENGTH)
        return AidenBotCreateRequest(
            name = trimmedName,
            purpose = aidenBotSubtitle(help),
            instructions = help.trim().take(AidenBotWire.MAX_INSTRUCTIONS_LENGTH).ifEmpty { AIDEN_BOT_DEFAULT_INSTRUCTIONS },
            avatar = AidenBotSemanticAvatar.Recipe(AidenBotCharacter.autoAssigned(trimmedName)),
            access = access
        )
    }
}
```

Add imports for `AidenModelRoute`, `AidenModelPickerField` (`sbtbiswas.AidenOnTheGo.features.shared.*`) and `kotlinx.coroutines.CancellationException` if not already imported.

In `AidenBotCreateScreen`, load the catalog:

```kotlin
    var catalog by remember { mutableStateOf<AidenBotCapabilityCatalog?>(null) }
    LaunchedEffect(client) {
        val cl = client ?: return@LaunchedEffect
        catalog = try { cl.botCapabilityCatalog() } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }
```

Change both `draft.request()` calls (in `actionEnabled` and `onAction`) to `draft.request(catalog)`. After the help field, add:

```kotlin
        catalog?.let { cat ->
            val providers = remember(cat) { aidenBotModelPickerProviders(cat) }
            if (providers.any { provider -> provider.models.any { it.available } }) {
                Text(
                    text = stringResource(R.string.bot_advanced_model),
                    style = MaterialTheme.typography.labelLarge,
                    color = palette.secondary
                )
                AidenModelPickerField(
                    title = stringResource(R.string.bot_advanced_model),
                    providers = providers,
                    selection = draft.model ?: aidenBotRecommendedModel(cat),
                    onSelect = { entry -> draft = draft.copy(model = entry.route) }
                )
            }
        }
```

If the catalog fails to load, the field is simply absent and Create sends no access, which is today's behaviour.

- [ ] **Step 5: Advanced uses the shared field**

In `AidenBotAdvancedScreen.kt`, replace the `AidenConnectedColumn { … models.forEachIndexed … }` block inside the model section (keep the "Use recommended" `TextButton`) with:

```kotlin
                            AidenModelPickerField(
                                title = stringResource(R.string.bot_advanced_model),
                                providers = remember(cat) { aidenBotModelPickerProviders(cat) },
                                selection = AidenModelRoute(current.customAccess.providerID, current.customAccess.modelID),
                                onSelect = { entry ->
                                    draft = current.copy(
                                        customAccess = current.customAccess.copy(
                                            providerID = entry.route.providerId,
                                            modelID = entry.route.modelId
                                        )
                                    )
                                }
                            )
```

Remove imports that become unused (`RadioButton`, `RadioButtonDefaults`, `AidenGroupCard`, `AidenConnectedColumn`, `Role`) only if nothing else in the file uses them.

- [ ] **Step 6: Memory and Advanced in the chat •••**

`strings.xml`, next to `bot_menu_files`:

```xml
    <string name="bot_menu_memory">Memory</string>
    <string name="bot_menu_advanced">Advanced</string>
```

`AidenBotChatHeader.kt`, in `AidenBotChatTopBar`: add the params after `onOpenFiles`:

```kotlin
    /** Null hides Memory (a Mac without `bot-memory-v1`). */
    onOpenMemory: (() -> Unit)? = null,
    /** Null hides Advanced (legacy chats). */
    onOpenAdvanced: (() -> Unit)? = null,
```

After the Files item:

```kotlin
                    if (onOpenMemory != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.bot_menu_memory)) },
                            leadingIcon = { Icon(Icons.Default.SdStorage, contentDescription = null) },
                            onClick = {
                                menuOpen = false
                                onOpenMemory()
                            }
                        )
                    }
                    if (onOpenAdvanced != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.bot_menu_advanced)) },
                            leadingIcon = { Icon(Icons.Default.Tune, contentDescription = null) },
                            onClick = {
                                menuOpen = false
                                onOpenAdvanced()
                            }
                        )
                    }
```

Import `androidx.compose.material.icons.filled.SdStorage` and `androidx.compose.material.icons.filled.Tune`. Use the SD-card icon for Memory per AGENTS.md.

`AidenBotSessionScreen.kt`, in the `AidenBotChatTopBar(…)` call:

```kotlin
                onOpenMemory = if (serverInfo?.features?.contains(AidenRemoteProtocol.BOT_MEMORY_FEATURE) == true) {
                    { onNavigateToBotMemory(botId) }
                } else null,
                onOpenAdvanced = ::openAdvanced,
```

Import `AidenRemoteProtocol` if needed.

- [ ] **Step 7: Run the tests**

```bash
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :app:testDebugUnitTest --console=plain
```
Expected: PASS for the whole unit suite, including `AidenBotModelChoiceTest` (4) and the existing Bot tests.

- [ ] **Step 8: Look at it on the emulator**

Per `.memory/android-m3-expressive.md`, verify on a headless AVD, not the owner's phone: New Bot shows the AI model field; Advanced shows the field instead of radio rows; ••• lists Memory and Advanced. Take a screenshot for the PR.

- [ ] **Step 9: Commit**

```bash
git add android/app/src/main android/app/src/test/java/sbtbiswas/AidenOnTheGo/features/bots/AidenBotModelChoiceTest.kt
git commit -m "Android Bots: choose the AI model in New Bot and Advanced; Memory and Advanced in •••"
```

---

### Task 8: Docs, memory and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md` (§10), `.memory/bots-rework-ui.md`, `docs/plans/README.md`

- [ ] **Step 1: Record the deviation in the spec**

In §10, replace "It opens the shared `ModelPicker`, through a small adapter from `BotCapabilityCatalog`." with:

> It opens `BotModelPicker` (`renderer/main/bots/bot-model-picker.tsx`), a Bot-specific searchable popover built from the same `Popover`/`Command` primitives as the composer picker. The composer's `ModelPicker` needs real provider ids for its icons, model info and Pad, and Bot catalog ids are deliberately opaque, so it can't be reused. Provider logos fall back to initials until the catalog carries a non-secret icon slug.

- [ ] **Step 2: Update project memory**

In `.memory/bots-rework-ui.md`:
- Replace the follow-up "Android Advanced still lists models as radio rows…" with "Android Advanced and New Bot use `AidenModelPickerField` via `aidenBotModelPickerProviders` (2026-10-14)."
- Add to Key files: `bot-model-choice.ts`, `bot-model-picker.tsx`, `AidenBotModelChoice.kt`, and `AidenBotModelRow`/`AidenBotModelListView` (in `AidenBotAdvancedView.swift`).
- Add to Known follow-ups: "Bot model pickers show provider initials: the Bot catalog's provider ids are opaque; add a non-secret icon slug to `BotProviderOption` (desktop IPC and Remote) to show logos."
- Note the menu order: Profile, Files, Memory, Advanced, Delete Bot.

- [ ] **Step 3: Add the index row**

In `docs/plans/README.md` under "Active and partial", after the Bot memory entry:

```markdown
- [Bot chat activity, Bots sidebar and side panel](../superpowers/specs/2026-10-14-bot-chat-activity-design.md) — Active (2026-10-14). Five stacked slices: A quick fixes ([plan](../superpowers/plans/2026-10-14-bot-chat-activity-a-quick-fixes.md): model choice in New Bot on desktop/iOS/Android, Advanced and Memory in every ••• menu, Advanced model control fix), B quiet status line + per-Bot Chat activity setting, C1 workbench shell extraction, C2 Bots-only sidebar + Bot side panel (stacked on C1), D phones (Remote revision 30, `bot-activity-v1`). B–D plans are written before each starts.
```

- [ ] **Step 4: Run every affected suite**

```bash
npx tsc --noEmit
npm run lint
npm run test:bots
npm run test:ci-policy
```
Expected: all PASS. Plus the iOS (Task 6 Step 8) and Android (Task 7 Step 7) commands, if not already run after the last change.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md .memory/bots-rework-ui.md docs/plans/README.md
git commit -m "Docs: slice A plan status, Bot model picker deviation, project memory"
```
