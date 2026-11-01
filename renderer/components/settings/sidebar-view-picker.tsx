import { useSidebarView } from "../../lib/use-sidebar-view";
import type { SidebarView } from "../../lib/sidebar-organization";
import { handleRadioNavigation } from "./radio-navigation";

/** The Organize menu's three views, in its order, named for what each lists. */
const SIDEBAR_VIEW_OPTIONS: ReadonlyArray<{ value: SidebarView; label: string; beta?: boolean }> = [
  { value: "projects", label: "By workspace" },
  { value: "recent", label: "Recent only" },
  { value: "inbox", label: "Inbox", beta: true },
];

/** A miniature sidebar for each view: grouped rows, one flat list, or sections led by a waiting row. */
function SidebarViewPreview({ view }: { view: SidebarView }) {
  return (
    <span className="appearance-width-preview appearance-sidebar-preview" data-sidebar-view={view} aria-hidden="true">
      <span className="appearance-sidebar-preview-column">
        {view === "projects" ? (
          <>
            <b />
            <i data-indent="" />
            <i data-indent="" />
            <b />
            <i data-indent="" />
          </>
        ) : view === "recent" ? (
          <>
            <i />
            <i />
            <i />
            <i />
            <i />
          </>
        ) : (
          <>
            <b />
            <i data-waiting="" />
            <b />
            <i />
            <i />
          </>
        )}
      </span>
    </span>
  );
}

/**
 * Settings → Appearance → Sidebar. The same stored view the sidebar's
 * Organize menu switches, so each follows the other at once.
 */
export function SidebarViewPicker({ labelledBy }: { labelledBy: string }) {
  const { view, setView } = useSidebarView();
  return (
    <div className="appearance-width-picker appearance-sidebar-picker" role="radiogroup" aria-labelledby={labelledBy}>
      {SIDEBAR_VIEW_OPTIONS.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={view === option.value}
          aria-label={option.beta ? `${option.label} (Beta)` : undefined}
          tabIndex={view === option.value ? 0 : -1}
          className="appearance-width-option"
          onClick={() => setView(option.value)}
          onKeyDown={(event) => handleRadioNavigation(event, index, SIDEBAR_VIEW_OPTIONS, setView)}
        >
          <SidebarViewPreview view={option.value} />
          <span className="appearance-width-option-label appearance-sidebar-option-label">
            {option.label}
            {option.beta ? <span className="appearance-sidebar-beta">Beta</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
