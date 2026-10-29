// ⌘/ (and Help → Keyboard Shortcuts): every key Aiden understands, as set in
// Settings, plus the built-in ones.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Dialog, Input, Text } from "./ui";
import { cn } from "../lib/ui-utils";
import { Kbd } from "./ui-primitives";
import { useCommandHandler, useCommandSystem } from "../lib/command-system";
import { useAppCapabilities } from "../lib/app-capabilities";
import { shortcutSheet } from "../lib/shortcut-sheet";
import {
  COMMAND_IDS,
  detectedKeyboardPlatform,
  prettyAcceleratorForPlatform,
  type CommandId,
  type KeyboardPlatform,
} from "../shared/keybindings";

/** Keys as chips: a pair reads "F6 / ⇧F6", a run "⌘1 – ⌘9", another way "or ⌘G". */
export function KeyCombo({
  keys,
  alsoKeys,
  range = false,
  platform = detectedKeyboardPlatform(),
}: {
  keys: readonly string[];
  alsoKeys?: readonly string[];
  range?: boolean;
  platform?: KeyboardPlatform;
}) {
  const chips = (list: readonly string[], separator: string) =>
    list.map((key, index) => (
      <React.Fragment key={`${key}-${index}`}>
        {index > 0 ? <span aria-hidden="true">{separator}</span> : null}
        <Kbd className="text-primary">{prettyAcceleratorForPlatform(key, platform)}</Kbd>
      </React.Fragment>
    ));
  // Long combos wrap onto a second line rather than widen a narrow window.
  return (
    <span className="inline-flex max-w-[60%] flex-wrap items-center justify-end gap-1 text-mini text-tertiary">
      {chips(keys, range ? "–" : "/")}
      {alsoKeys?.length ? (
        <>
          <span>or</span>
          {chips(alsoKeys, "/")}
        </>
      ) : null}
    </span>
  );
}

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const headingId = React.useId();
  const navigate = useNavigate();
  const { binding } = useCommandSystem();
  const capabilities = useAppCapabilities();
  // Esc gives focus back to where ⌘/ was pressed, such as the message box.
  const returnTo = React.useRef<HTMLElement | null>(null);
  useCommandHandler("shortcuts.show", () => {
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setOpen(true);
  });

  const platform = detectedKeyboardPlatform();
  const sections = React.useMemo(() => {
    if (!open) return [];
    const bindings = Object.fromEntries(COMMAND_IDS.map((id) => [id, binding(id)])) as Record<
      CommandId,
      string | null
    >;
    return shortcutSheet(bindings, { capabilities, platform, query });
  }, [binding, capabilities, open, platform, query]);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="large"
      title="Keyboard shortcuts"
      description="Keys you set in Settings show here as you set them."
      cancelLabel="Close"
      returnFocus={() => returnTo.current}
      confirmLabel="Change keys…"
      onConfirm={() => {
        setOpen(false);
        void navigate({ to: "/settings", search: { section: "shortcut" } });
      }}
    >
      <label className="mb-4 flex h-9 items-center gap-2 rounded-control border border-field bg-background px-3 focus-within:bg-input">
        <Search aria-hidden="true" className="size-4 text-tertiary" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search keys…"
          aria-label="Search keyboard shortcuts"
          className="h-full border-0 bg-transparent px-0 hover:border-0 focus:border-0 focus:bg-transparent"
        />
      </label>
      {/* A steady height, so the dialog doesn't jump while the search narrows it. */}
      <div className="min-h-[min(52vh,26rem)]">
        {sections.length === 0 ? (
          <Text as="p" role="status" color="secondary" className="py-8 text-center">
            No keys match “{query.trim()}”.
          </Text>
        ) : (
          <div className={cn("grid gap-x-8 gap-y-5", sections.length > 1 && "sm:grid-cols-2")}>
            {sections.map((section, index) => (
              <section
                key={section.title}
                aria-labelledby={`${headingId}-${index}`}
                className="min-w-0"
              >
                <Text
                  as="h3"
                  id={`${headingId}-${index}`}
                  variant="small-strong"
                  color="secondary"
                  className="mb-1.5 block"
                >
                  {section.title}
                </Text>
                <ul className="flex flex-col">
                  {section.rows.map((row) => (
                    <li key={row.id} className="flex items-start justify-between gap-3 py-1.5">
                      <div className="min-w-0">
                        <Text as="p" variant="small">
                          {row.title}
                        </Text>
                        {row.description ? (
                          <p className="text-mini text-tertiary">{row.description}</p>
                        ) : null}
                      </div>
                      <KeyCombo
                        keys={row.keys}
                        alsoKeys={row.alsoKeys}
                        range={row.range}
                        platform={platform}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
