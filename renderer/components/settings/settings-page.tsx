import * as React from "react";
import { settingsTabFor, settingsTabLabel, type SettingsPageEntry, type SettingsSection } from "../../lib/settings-section";
import { Text } from "../ui";
import { Tabs, tabIds } from "../ui-primitives";

/** The spot on the page to scroll into view, such as `links` on Appearance or `bots` on Approvals. A new `request` scrolls again. */
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

/** Shared heading layout for settings destinations that render their own title, hint, or trailing actions. */
export function SettingsPageHeading({
  as: Wrapper = "div",
  title,
  description,
  descriptionAs = "span",
  descriptionVariant = "small",
  hint,
  hintContainerAs: HintContainer = "span",
  hintGap = "gap-1.5",
  actions,
}: {
  as?: "header" | "div";
  title: string;
  description: React.ReactNode;
  descriptionAs?: "p" | "span";
  descriptionVariant?: "small" | "regular";
  hint?: React.ReactNode;
  hintContainerAs?: "span" | "div";
  hintGap?: "gap-1" | "gap-1.5";
  actions?: React.ReactNode;
}) {
  const heading = (
    <Text as="h1" variant="heading1">
      {title}
    </Text>
  );
  return (
    <Wrapper className="settings-page-heading flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        {hint ? (
          <HintContainer className={`flex items-center ${hintGap}`}>
            {heading}
            {hint}
          </HintContainer>
        ) : (
          heading
        )}
        <Text as={descriptionAs} variant={descriptionVariant} color="secondary" className="mt-0.5 block">
          {description}
        </Text>
      </div>
      {actions}
    </Wrapper>
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
  // An anchor (Bot messaging on Approvals) shows the tab that holds it.
  const tab = settingsTabFor(page, section);
  const ids = tabIds(idBase, tab);
  return (
    <>
      <Tabs
        className="mb-7"
        aria-label={page.title}
        idBase={idBase}
        value={tab}
        onValueChange={onSelect}
        items={page.tabs.map((tab) => ({ value: tab, label: settingsTabLabel(tab) }))}
      />
      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
        {children}
      </div>
    </>
  );
}
