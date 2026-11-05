import * as React from "react";
import { browserApi } from "../../lib/ipc";
import type { BrowserLinkOpening } from "../../shared/browser";
import { isMacPlatform } from "../../lib/ghostty-terminal/host-platform";
import { Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from "../ui";

const LABELS: Record<BrowserLinkOpening, string> = {
  ask: "Ask each time",
  browser: "Aiden browser",
  external: "System browser",
};
const MOD = isMacPlatform() ? "⌘" : "Ctrl";

export function LinksSettings({ embedded = false }: { embedded?: boolean }) {
  const [value, setValue] = React.useState<BrowserLinkOpening | null>(null);
  const revision = React.useRef(0);

  React.useEffect(() => {
    let live = true;
    const reading = revision.current;
    void browserApi
      .linkPreference()
      .then((next) => live && reading === revision.current && setValue(next))
      .catch(() => live && reading === revision.current && setValue("ask"));
    const off = browserApi.onEvent((event) => {
      const next = event.type === "state" ? event.state.defaults?.linkOpening
        : event.type === "link-preference" ? event.linkOpening : undefined;
      if (next !== undefined) {
        revision.current += 1;
        setValue(next);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const change = (next: BrowserLinkOpening) => {
    const previous = value;
    const writing = ++revision.current;
    setValue(next);
    void browserApi.setLinkPreference(next).catch((error: unknown) => {
      if (writing !== revision.current) return;
      setValue(previous);
      toast.error(error instanceof Error ? error.message : "Couldn't save this setting.");
    });
  };

  const field = (
      <Field
        label={embedded ? "Open chat links in" : "Open links in"}
        description={`Local dev servers always open in Aiden. ${MOD}-click a link to open it in the other browser.`}
      >
        <Select
          value={value ?? undefined}
          onValueChange={(next) => change(next as BrowserLinkOpening)}
          disabled={value === null}
        >
          <SelectTrigger size="small" aria-label={embedded ? "Open chat links in" : "Open links in"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(LABELS) as BrowserLinkOpening[]).map((key) => (
              <SelectItem key={key} value={key}>
                {LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
  );
  return embedded ? field : <FieldSet>{field}</FieldSet>;
}
