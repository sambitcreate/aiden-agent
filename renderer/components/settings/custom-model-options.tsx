import * as React from "react";
import { Button, Field, FieldSet, Input, Switch, Text } from "../ui";
import type { ModelInfo, ProviderModelMetadata } from "../../lib/types";
import type { CustomModelOptions } from "../../shared/custom-model-options";

export function CustomModelOptionsEditor({
  models,
  metadata,
  info,
  disabled,
  modelsStale,
  onChange,
  onAdd,
}: {
  models: string[];
  metadata: Record<string, ProviderModelMetadata>;
  info?: Record<string, ModelInfo>;
  disabled: boolean;
  modelsStale: boolean;
  onChange: (id: string, options: CustomModelOptions | undefined) => void;
  onAdd: (id: string) => void;
}) {
  const [modelId, setModelId] = React.useState("");
  return (
    <div className="grid min-w-0 gap-3">
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
        Set the capabilities your server supports. Changes apply when you save.
        Video records server support; Aiden chat currently accepts images and
        text only.
      </Text>
      {models.map((id) => {
        const overrides = metadata[id]?.overrides ?? {};
        const effective = {
          ...metadata[id],
          ...(info?.[id]?.detectedCapabilities ?? info?.[id]),
          ...overrides,
        };
        return (
          <details key={id} className="settings-card min-w-0 p-3">
            <summary className="cursor-pointer break-words text-small font-medium">
              {metadata[id]?.name ?? id}
            </summary>
            <FieldSet>
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
                    checked={effective[key] === true}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onChange(id, { ...overrides, [key]: checked })
                    }
                  />
                </Field>
              ))}
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
                    onChange={(event) =>
                      onChange(id, {
                        ...overrides,
                        [key]:
                          event.target.value === ""
                            ? undefined
                            : Number(event.target.value),
                      })
                    }
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
