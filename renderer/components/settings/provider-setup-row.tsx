// One provider row in a settings card: logo tile, name with a status badge,
// one subtitle line, and a single trailing Set up / Manage action. Shared by
// Settings → Providers and Settings → Image Generation so both read the same.

import * as React from "react";
import { Button, Text } from "../ui";

export function ProviderSetupRow({
  icon,
  name,
  badge,
  subtitle,
  actionLabel,
  actionAriaLabel,
  actionRef,
  onAction,
}: {
  /** The provider mark, sized `size-4.5`. */
  icon: React.ReactNode;
  name: React.ReactNode;
  badge?: React.ReactNode;
  subtitle: React.ReactNode;
  actionLabel: string;
  actionAriaLabel?: string;
  actionRef?: React.Ref<HTMLButtonElement>;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-well text-secondary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Text variant="strong" truncate>
            {name}
          </Text>
          {badge}
        </div>
        <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
          {subtitle}
        </Text>
      </div>
      <Button ref={actionRef} variant="filled" size="small" aria-label={actionAriaLabel} onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
