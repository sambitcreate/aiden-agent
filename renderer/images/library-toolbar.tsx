import { Search } from "lucide-react";
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui";
import type { FacetOption, LibraryFilters, LibrarySort } from "./library-core";

/** Select values can't be empty; facet keys are workflow UUIDs, ":deleted" or "provider::model", so "*" never collides. */
const ALL = "*";

function FacetSelect({
  label,
  allLabel,
  value,
  options,
  total,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | null;
  options: readonly FacetOption[];
  total: number;
  onChange(value: string | null): void;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
      <SelectTrigger aria-label={label} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{`${allLabel} (${total})`}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.key} value={option.key}>{`${option.label} (${option.count})`}</SelectItem>
        ))}
        {/* A choice whose images are all gone stays selectable, so the trigger still names it. */}
        {value !== null && !options.some((option) => option.key === value) ? <SelectItem value={value}>No longer available (0)</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}

/** Search, the workflow and model filters, and the sort for All Images. */
export function LibraryToolbar({
  filters,
  onFiltersChange,
  facets,
}: {
  filters: LibraryFilters;
  onFiltersChange(filters: LibraryFilters): void;
  facets: { workflows: FacetOption[]; models: FacetOption[]; workflowTotal: number; modelTotal: number };
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative block min-w-48 flex-1">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
        <Input
          type="search"
          value={filters.query}
          onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !filters.query) return;
            event.preventDefault();
            onFiltersChange({ ...filters, query: "" });
          }}
          placeholder="Search prompts, models and workflows"
          aria-label="Search images"
          className="pl-8"
        />
      </label>
      <FacetSelect
        label="Workflow"
        allLabel="All Workflows"
        value={filters.workflow}
        options={facets.workflows}
        total={facets.workflowTotal}
        onChange={(workflow) => onFiltersChange({ ...filters, workflow })}
      />
      <FacetSelect
        label="Model"
        allLabel="All Models"
        value={filters.model}
        options={facets.models}
        total={facets.modelTotal}
        onChange={(model) => onFiltersChange({ ...filters, model })}
      />
      <Select value={filters.sort} onValueChange={(sort) => onFiltersChange({ ...filters, sort: sort as LibrarySort })}>
        <SelectTrigger aria-label="Sort" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="newest">Newest First</SelectItem>
          <SelectItem value="oldest">Oldest First</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
