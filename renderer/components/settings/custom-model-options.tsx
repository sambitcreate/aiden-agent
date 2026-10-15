import * as React from "react";
import {
  Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem,
  Field, FieldSet, Input, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Switch, Text,
} from "../ui";
import type { ModelInfo, ProviderModelMetadata } from "../../lib/types";
import { customModelThinkingLevels, type CustomModelOptions } from "../../shared/custom-model-options";
import { GENERATION_THINKING_LEVELS, type GenerationThinkingLevel } from "../../shared/generation-thinking";

const effortLabels: Record<GenerationThinkingLevel, string> = {
  off: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

export function CustomModelOptionsEditor({
  models,
  metadata,
  info,
  disabled,
  modelsStale,
  supportsEffortControl = true,
  onChange,
  onAdd,
}: {
  models: string[];
  metadata: Record<string, ProviderModelMetadata>;
  info?: Record<string, ModelInfo>;
  disabled: boolean;
  modelsStale: boolean;
  supportsEffortControl?: boolean;
  onChange: (id: string, options: CustomModelOptions | undefined) => void;
  onAdd: (id: string) => void;
}) {
  const [modelId, setModelId] = React.useState("");
  return (
    <div className="grid min-w-0 gap-4">
      <Field
        label="Add model ID"
        description="Enter the exact model ID if it is missing from discovery."
      >
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label="Model ID"
            value={modelId}
            maxLength={256}
            disabled={disabled}
            onChange={(event) => setModelId(event.target.value)}
          />
          <Button
            size="small"
            disabled={
              disabled ||
              !modelId.trim() ||
              (!modelsStale && models.includes(modelId.trim()))
            }
            onClick={() => {
              onAdd(modelId.trim());
              setModelId("");
            }}
          >
            Add
          </Button>
        </div>
      </Field>
      <Text variant="small" color="tertiary" as="p">
        Enable only the capabilities your server supports. Image and reasoning
        controls apply to this connection, not a similarly named public model.
        Changes apply when you save.
      </Text>
      {models.map((id) => {
        const overrides = metadata[id]?.overrides ?? {};
        const effortLevels = customModelThinkingLevels(overrides) ?? [];
        const effective = {
          ...metadata[id],
          ...(info?.[id]?.detectedCapabilities ?? info?.[id]),
          ...overrides,
        };
        return (
          <details key={id} className="settings-card min-w-0 rounded-card bg-well">
            <summary className="cursor-pointer break-words px-4 py-3 text-small-strong text-primary">
              {metadata[id]?.name ?? info?.[id]?.name ?? id}
              <Text as="span" variant="small" color="tertiary" className="mt-1 block font-normal">
                {effective.vision === true && overrides.maxImages !== 0 ? "Images enabled" : "Text only"}
                {effective.reasoning === true ? " · Reasoning" : ""}
                {overrides.contextLength ? ` · ${new Intl.NumberFormat().format(overrides.contextLength)} tokens` : ""}
              </Text>
            </summary>
            <FieldSet className="mb-0">
              {(
                [
                  ["vision", "Vision"],
                  ["reasoning", "Reasoning"],
                  ["toolCall", "Tool calling"],
                  ["openWeights", "Open weights"],
                  ["video", "Video support (server)"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Switch
                    aria-label={`${id}: ${label}`}
                    checked={effective[key] === true && (key !== "vision" || overrides.maxImages !== 0)}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      const next = { ...overrides, [key]: checked };
                      if (key === "vision" && checked && next.maxImages === 0) delete next.maxImages;
                      if (key === "reasoning" && !checked) {
                        delete next.effortControl;
                        delete next.effortLevels;
                      }
                      onChange(id, next);
                    }}
                  />
                </Field>
              ))}
              <Field
                label="Effort request format"
                description="Choose how your server accepts reasoning effort, then select its supported levels below."
              >
                <Select
                  value={overrides.effortControl ?? "none"}
                  disabled={disabled || !supportsEffortControl}
                  onValueChange={(value) => {
                    const next = { ...overrides };
                    if (value === "none") { delete next.effortControl; delete next.effortLevels; }
                    else if (value === "openai" || value === "glm") {
                      next.effortControl = value;
                      next.reasoning = true;
                    }
                    onChange(id, next);
                  }}
                >
                  <SelectTrigger aria-label={`${id}: Effort request format`}>
                    <SelectValue>{overrides.effortControl === "glm" ? "GLM / vLLM" : overrides.effortControl === "openai" ? "OpenAI-compatible" : "Not configured"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not configured</SelectItem>
                    <SelectItem value="openai">OpenAI-compatible</SelectItem>
                    <SelectItem value="glm">GLM / vLLM</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Supported effort levels"
                description="Select all levels this model supports. None disables thinking. Clear every choice to hide the composer selector."
              >
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="small"
                      aria-label={`${id}: Supported effort levels`}
                      disabled={disabled || !supportsEffortControl || !overrides.effortControl}
                      className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
                    >
                      {effortLevels.length ? effortLevels.map((level) => effortLabels[level]).join(", ") : "Select levels"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {GENERATION_THINKING_LEVELS.map((level) => (
                      <DropdownMenuCheckboxItem
                        key={level}
                        checked={effortLevels.includes(level)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) => onChange(id, {
                          ...overrides,
                          effortLevels: GENERATION_THINKING_LEVELS.filter((candidate) =>
                            candidate === level ? checked === true : effortLevels.includes(candidate)),
                        })}
                      >
                        {effortLabels[level]}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </Field>
              {(
                [
                  ["contextLength", "Context length (tokens)"],
                  ["outputLimit", "Maximum output tokens"],
                  ["maxImages", "Maximum images per message"],
                ] as const
              ).map(([key, label]) => (
                <Field
                  key={key}
                  label={label}
                  description={
                    key === "maxImages"
                      ? "Blank uses Aiden's attachment limit. Zero disables images."
                      : "Leave blank to use detected limits."
                  }
                >
                  <Input
                    type="number"
                    aria-label={`${id}: ${label}`}
                    min={key === "maxImages" ? 0 : 1}
                    step={1}
                    disabled={disabled}
                    value={overrides[key] ?? ""}
                    placeholder={effective[key]?.toString() ?? "Automatic"}
                    onChange={(event) => {
                      const next = { ...overrides };
                      if (event.target.value === "") delete next[key];
                      else next[key] = Number(event.target.value);
                      onChange(id, next);
                    }}
                  />
                </Field>
              ))}
              <Button
                size="small"
                variant="transparent"
                disabled={disabled || !metadata[id]?.overrides}
                onClick={() => onChange(id, undefined)}
              >
                Use detected capabilities
              </Button>
            </FieldSet>
          </details>
        );
      })}
    </div>
  );
}
