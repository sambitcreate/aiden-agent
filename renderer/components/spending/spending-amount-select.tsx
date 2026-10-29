import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui";
import { formatUsd, SPENDING_LIMIT_PRESETS_USD } from "../../shared/spending";

/** One dollar-limit picker: the presets, "No limit", and any other stored amount. Values are strings for the Select. */
export function SpendingAmountSelect({
  label,
  value,
  onChange,
  disabled,
  extraOptions = [],
}: {
  /** The accessible name of the trigger. */
  label: string;
  /** "none", a preset amount as text, or one of `extraOptions`. */
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  /** Choices before "No limit", such as "Use default". */
  extraOptions?: ReadonlyArray<{ value: string; label: string }>;
}) {
  const amounts: number[] = [...SPENDING_LIMIT_PRESETS_USD];
  const current = Number(value);
  // A stored amount that is not a preset (from another Mac) stays choosable.
  if (Number.isFinite(current) && current > 0 && !amounts.includes(current)) {
    amounts.push(current);
    amounts.sort((a, b) => a - b);
  }
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="justify-self-end sm:max-w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {extraOptions.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        <SelectItem value="none">No limit</SelectItem>
        {amounts.map((amount) => (
          <SelectItem key={amount} value={String(amount)}>
            {formatUsd(amount)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
