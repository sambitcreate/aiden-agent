import * as React from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Text,
} from "../components/ui";
import type { ImageModelOption } from "../shared/images/port";
import type { ImageModelRef } from "../shared/images/schema";

const keyOf = (provider: string, model: string) => `${provider}\u0000${model}`;

export function ModelPicker({
  value,
  models,
  onChange,
}: {
  value?: ImageModelRef;
  models: readonly ImageModelOption[];
  onChange(model: ImageModelRef): void;
}) {
  if (models.length === 0) {
    return (
      <Text variant="small" color="secondary">
        Add an OpenRouter key in Settings → Providers to generate images.
      </Text>
    );
  }
  const current = value ? models.find((option) => option.provider === value.provider && option.model === value.id) : undefined;
  const groups = new Map<string, ImageModelOption[]>();
  for (const option of models) groups.set(option.providerLabel, [...(groups.get(option.providerLabel) ?? []), option]);
  const selectedKey = current ? keyOf(current.provider, current.model) : "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="small" variant="muted" className="nodrag max-w-full justify-start" aria-label="Image model">
          <span className="truncate">{current?.label ?? (value ? `${value.id} (unavailable)` : "Choose a Model")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={selectedKey}
          onValueChange={(next) => {
            const option = models.find((candidate) => keyOf(candidate.provider, candidate.model) === next);
            if (option) onChange({ provider: option.provider, id: option.model });
          }}
        >
          {[...groups].map(([providerLabel, options]) => (
            <React.Fragment key={providerLabel}>
              <DropdownMenuLabel>{providerLabel}</DropdownMenuLabel>
              {options.map((option) => (
                <DropdownMenuRadioItem key={keyOf(option.provider, option.model)} value={keyOf(option.provider, option.model)}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
