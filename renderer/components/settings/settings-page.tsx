import * as React from "react";
import { settingsTabLabel, type SettingsPageEntry, type SettingsSection } from "../../lib/settings-section";
import { Tabs, tabIds } from "../ui-primitives";

/** The spot on the page to scroll into view, such as `links` on Appearance. A new `request` scrolls again. */
export const SettingsAnchorContext = React.createContext<{ section: SettingsSection; request: number } | null>(null);

/** Shared Settings page hierarchy. FieldSet and Field supply its grouped cards and rows. */
export function SettingsPage({
  title,
  description,
  heading = true,
  children,
}: React.PropsWithChildren<{ title: string; description: string; heading?: boolean }>) {
  return (
    <div className="settings-page">
      {heading ? (
        <header className="settings-page-heading">
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
      ) : null}
      {children}
    </div>
  );
}

/** A merged page's tab strip and selected panel. A page with one tab renders only its content. */
export function SettingsPageTabs({
  page,
  section,
  onSelect,
  children,
}: React.PropsWithChildren<{
  page: SettingsPageEntry;
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}>) {
  const idBase = React.useId();
  if (page.tabs.length < 2) return children;
  const ids = tabIds(idBase, section);
  return (
    <>
      <Tabs
        className="mb-7"
        aria-label={page.title}
        idBase={idBase}
        value={section}
        onValueChange={onSelect}
        items={page.tabs.map((tab) => ({ value: tab, label: settingsTabLabel(tab) }))}
      />
      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
        {children}
      </div>
    </>
  );
}
