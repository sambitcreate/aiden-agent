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

export function LinksSettings() {
  const [value, setValue] = React.useState<BrowserLinkOpening | null>(null);

  React.useEffect(() => {
    let live = true;
    void browserApi
      .linkPreference()
      .then((next) => live && setValue(next))
      .catch(() => live && setValue("ask"));
    const off = browserApi.onEvent((event) => {
      if (event.type === "state" && event.state.defaults) setValue(event.state.defaults.linkOpening);
      else if (event.type === "link-preference") setValue(event.linkOpening);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const change = (next: BrowserLinkOpening) => {
    const previous = value;
    setValue(next);
    void browserApi.setLinkPreference(next).catch((error: unknown) => {
      setValue(previous);
      toast.error(error instanceof Error ? error.message : "Couldn't save this setting.");
    });
  };

  return (
    <FieldSet title="Links">
      <Field
        label="Open links in"
        description={`Local dev servers always open in Aiden. ${MOD}-click a link to open it in the other browser.`}
      >
        <Select
          value={value ?? undefined}
          onValueChange={(next) => change(next as BrowserLinkOpening)}
          disabled={value === null}
        >
          <SelectTrigger aria-label="Open links in">
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
    </FieldSet>
  );
}
