// The values a `web_fetch` extract call read, under its activity line: each
// name and value with the page line it came from, so the owner can check a
// number against its source without opening the page. Guesses and values the
// page does not have are labelled as such, never shown as read.

import { Globe2 } from "lucide-react";
import { Badge } from "./ui";
import {
  WEB_EXTRACT_ERROR_MESSAGES,
  type WebExtractRecapFieldV1,
  type WebExtractRecapV1,
} from "../shared/web-extract";

/** A field name as people read it: `pro_monthly` → `pro monthly`. */
export function webExtractFieldLabel(name: string): string {
  return name.replace(/_+/gu, " ").trim() || name;
}

function FieldValue({ field }: { field: WebExtractRecapFieldV1 }) {
  if (field.status === "null") {
    return <span className="text-tertiary">Not on the page</span>;
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={field.status === "extracted" ? "break-words font-medium text-primary" : "break-words text-secondary"}>
        {field.value}
      </span>
      {field.status === "uncertain" ? <Badge color="warning">Guess</Badge> : null}
    </span>
  );
}

function FieldSource({ field }: { field: WebExtractRecapFieldV1 }) {
  if (field.status === "null") return null;
  if (field.sourceLine) {
    return (
      <q className="mt-0.5 block break-words text-small text-tertiary">
        {field.sourceLine}
      </q>
    );
  }
  return field.notFound ? (
    <span className="mt-0.5 block text-small text-tertiary">Not found on the page</span>
  ) : null;
}

export function WebExtractRecap({ recap }: { recap: WebExtractRecapV1 }) {
  const title = `Values read from ${recap.host}`;
  return (
    <section aria-label={title} className="web-extract-recap max-w-full select-text rounded-card bg-well px-3.5 py-3">
      <p className="flex min-w-0 items-center gap-1.5 text-small text-secondary">
        <Globe2 aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{recap.host}</span>
      </p>
      {recap.error ? (
        <p className="mt-1.5 text-small text-secondary">
          Couldn’t read the values: {WEB_EXTRACT_ERROR_MESSAGES[recap.error]}. The page was read instead.
        </p>
      ) : (
        <dl className="mt-2 grid gap-2.5">
          {recap.fields.map((field) => (
            <div key={field.name} className="grid min-w-0 gap-x-4 gap-y-0.5 min-[540px]:grid-cols-[minmax(6rem,0.32fr)_minmax(0,1fr)]">
              <dt className="break-words text-small text-secondary">{webExtractFieldLabel(field.name)}</dt>
              <dd className="min-w-0">
                <FieldValue field={field} />
                <FieldSource field={field} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {recap.cut ? (
        <p className="mt-2 text-small text-tertiary">Only the first part of the page was read.</p>
      ) : null}
    </section>
  );
}
