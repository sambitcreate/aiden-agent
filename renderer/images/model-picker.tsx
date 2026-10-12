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
import { ImageModelLogo } from "../components/image-model-logo";
import type { ImageModelOption } from "../shared/images/port";
import type { ImageModelRef } from "../shared/images/schema";

const keyOf = (provider: string, model: string) => `${provider}\u0000${model}`;

function OptionLogo({ option }: { option: ImageModelOption }) {
  return (
    <ImageModelLogo
      maker={option.maker}
      providerId={option.provider}
      modelId={option.model}
      label={option.label}
      className="size-3.5 text-secondary"
    />
  );
}

export function ModelPicker({
  value,
  models,
  onChange,
  onOpenSettings,
}: {
  value?: ImageModelRef;
  models: readonly ImageModelOption[];
  onChange(model: ImageModelRef): void;
  /** Opens Settings → Image Generation from the empty state. */
  onOpenSettings?: () => void;
}) {
  if (models.length === 0) {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <Text variant="small" color="secondary">
          Add an image key in Settings → Image Generation.
        </Text>
        {onOpenSettings ? (
          <Button size="small" variant="muted" className="nodrag" onClick={onOpenSettings}>
            Open Image Generation
          </Button>
        ) : null}
      </div>
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
          {current ? <OptionLogo option={current} /> : null}
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
                  <OptionLogo option={option} />
                  <span className="min-w-0 truncate">{option.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
