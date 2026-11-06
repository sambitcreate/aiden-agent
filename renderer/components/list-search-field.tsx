import { Search } from "lucide-react";

/** A list earns a search field once it holds more rows than this. */
export const LIST_SEARCH_THRESHOLD = 8;

/** The compact search field that sits in a list's header. */
export function ListSearchField({
  noun,
  value,
  onChange,
}: {
  noun: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex h-8 w-48 items-center gap-2 rounded-control border border-field bg-background px-2.5 focus-within:bg-input max-[640px]:w-full max-[640px]:order-last">
      <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
      <input
        aria-label={`Search ${noun}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search"
        className="h-full min-w-0 flex-1 bg-transparent text-regular text-primary outline-none placeholder:text-tertiary"
      />
    </label>
  );
}
