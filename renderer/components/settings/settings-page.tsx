import type { PropsWithChildren } from "react";

/** Shared Settings page hierarchy. FieldSet and Field supply its grouped cards and rows. */
export function SettingsPage({
  title,
  description,
  heading = true,
  children,
}: PropsWithChildren<{ title: string; description: string; heading?: boolean }>) {
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
