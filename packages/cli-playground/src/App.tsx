import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DialRoot, useDialKitController } from "dialkit";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Columns2,
  Copy,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  DIALS,
  DIRECTIONS,
  FONTS,
  exportBrief,
  loadSaved,
  themeTokens,
  type Look,
  type SavedLook,
} from "./model";

const SCENARIOS = [
  "Conversation",
  "Tools & diff",
  "Approval",
  "Startup",
] as const;
type Scenario = (typeof SCENARIOS)[number];
function Diff({ mode }: { mode: string }) {
  return (
    <section className={`diff diff-${mode}`} aria-label="Example file changes">
      <header>
        <span>SessionList.tsx</span>
        <span className="success">
          +3 <span className="muted">−1</span>
        </span>
      </header>
      {mode === "summary" ? (
        <p>1 file changed · 3 additions · 1 removal</p>
      ) : (
        <div className="patch">
          <div className="removed">− gap: 8,</div>
          <div className="added">
            + gap: 12,
            <br />+ padding: 16,
            <br />+ alignItems: 'center',
          </div>
        </div>
      )}
    </section>
  );
}
function Preview({
  look,
  scenario,
  playing,
  tick,
  label,
}: {
  look: Look;
  scenario: Scenario;
  playing: boolean;
  tick: number;
  label: string;
}) {
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState("");
  const [decision, setDecision] = useState("");
  const arrangement = look.layout.arrangement;
  const style = {
    ...themeTokens(look),
    "--terminal-font": FONTS[look.typography.font],
    "--terminal-size": `${look.typography.size}px`,
    "--terminal-line": look.typography.lineHeight,
    "--terminal-padding": `${look.layout.padding}px`,
    "--terminal-gap": `${look.layout.gap}px`,
    "--motion-duration": `${2 / look.motion.speed}s`,
  } as CSSProperties;
  const activity = (
    <div className="activity">
      {look.details.activity === "detailed" ? (
        <>
          <div>
            ✓ Read <span>renderer/SessionList.tsx</span>
          </div>
          <div>
            ✓ Inspect <span>shared/appearance.ts</span>
          </div>
          <div>
            ✓ Check <span>12 tests passed</span>
          </div>
        </>
      ) : (
        <div>✓ Explored 2 files · checked 12 tests</div>
      )}
    </div>
  );
  return (
    <article
      className={`terminal arrangement-${arrangement}`}
      style={style}
      data-layout={arrangement}
      data-motion={
        look.motion.reduced || !playing ? "none" : look.motion.animation
      }
      aria-label={`${label} terminal preview`}
    >
      {look.layout.chrome && (
        <header className="window-chrome">
          <span className="window-dots">
            <i />
            <i />
            <i />
          </span>
          <span>aiden — ~/projects/studio</span>
          <span>⌘ 1</span>
        </header>
      )}
      <div className="terminal-body">
        {(arrangement === "rail" || arrangement === "agents") && (
          <aside className="terminal-rail">
            <small>{arrangement === "agents" ? "TEAM" : "PROJECT"}</small>
            {(arrangement === "agents"
              ? [
                  "● Scout · complete",
                  "● Planner · complete",
                  "◌ Reviewer · ready",
                ]
              : [
                  "⌂ studio",
                  "  renderer/",
                  "  SessionList.tsx",
                  "  appearance.ts",
                  "  package.json",
                ]
            ).map((item) => (
              <div key={item}>{item}</div>
            ))}
          </aside>
        )}
        <div className="terminal-content">
          {arrangement === "dashboard" && (
            <div className="meters">
              <div>
                <small>MODEL</small>
                <strong>Configured model</strong>
              </div>
              <div>
                <small>CONTEXT</small>
                <strong>
                  24% <meter min="0" max="100" value="24" />
                </strong>
              </div>
              {look.details.usage && (
                <div>
                  <small>TOKENS</small>
                  <strong>8.2k / 32k</strong>
                </div>
              )}
            </div>
          )}
          {scenario === "Startup" ? (
            <div className="startup">
              <pre>{"   ▄▀█ █ █▀▄ █▀▀ █▄░█\n   █▀█ █ █▄▀ ██▄ █░▀█"}</pre>
              <p>Your workspace. Your pace.</p>
              <div className="activity">
                ✓ Workspace ready
                <br />✓ Local configuration loaded
                <br />
                <span className="cursor">›</span> What are we building today?
              </div>
            </div>
          ) : (
            <>
              <div className="conversation">
                <div className="entry user-entry">
                  <small>
                    {arrangement === "journal" ? "01 / YOU" : "YOU"}
                    {look.details.timestamps && " · 10:42:01"}
                  </small>
                  <p>Make the session list easier to scan.</p>
                </div>
                <div className="entry assistant-entry">
                  <small>
                    {arrangement === "journal" ? "02 / AIDEN" : "AIDEN"}
                    {look.details.timestamps && " · 10:42:03"}{" "}
                    <span className="live-dot" />
                  </small>
                  <p>
                    I’ll give each session a little more space and align the
                    metadata, keeping the existing theme.
                  </p>
                  {look.details.activity !== "hidden" && activity}
                </div>
              </div>
              {scenario === "Approval" ? (
                <section className="approval">
                  <small>PERMISSION REQUEST · DEMO</small>
                  <p>Run the focused session-list tests?</p>
                  <code>npm run test -- SessionList</code>
                  {decision ? (
                    <p role="status">{decision} — preview only.</p>
                  ) : (
                    <div className="button-row">
                      <button
                        type="button"
                        onClick={() => setDecision("Allowed once")}
                      >
                        Allow once
                      </button>
                      <button
                        type="button"
                        onClick={() => setDecision("Denied")}
                      >
                        Deny
                      </button>
                    </div>
                  )}
                </section>
              ) : (
                <div className="result">
                  <Diff mode={look.details.diff} />
                  {scenario === "Conversation" && (
                    <p className="answer">
                      The rows now have more breathing room. Titles and
                      timestamps line up, and all 12 focused tests pass.
                    </p>
                  )}
                </div>
              )}
              {arrangement === "log" && (
                <div className="event-log">
                  10:42:04 read SessionList.tsx
                  <br />
                  10:42:05 patch +3 −1
                  <br />
                  10:42:06 test 12 passed
                </div>
              )}
              {sent && (
                <div className="entry demo-reply">
                  <small>YOU</small>
                  <p>{sent}</p>
                  <small>AIDEN · SIMULATED</small>
                  <p>
                    That’s a useful refinement. Try the dials on the right to
                    see how it feels.
                  </p>
                </div>
              )}
            </>
          )}
          <footer className="terminal-footer">
            <div className="progress-label">
              <span className="cursor">
                {playing ? ["◐", "◓", "◑", "◒"][tick % 4] : "✓"}
              </span>{" "}
              {playing ? "Previewing session" : "Preview paused"}
              <span>{look.details.usage && "8.2k tokens"}</span>
            </div>
            <form
              className="prompt"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim()) {
                  setSent(draft.trim());
                  setDraft("");
                }
              }}
            >
              <span>{look.details.prompt}</span>
              <input
                aria-label={`${label} demo prompt`}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Try a follow-up…"
                maxLength={500}
              />
              <button
                type="submit"
                aria-label={`Send ${label} demo prompt`}
                disabled={!draft.trim()}
              >
                <ArrowUpRight size={16} />
              </button>
            </form>
            {look.details.context && (
              <div className="context-line">
                studio <span>·</span> main <span>·</span> read & write{" "}
                <span className="right">local preview</span>
              </div>
            )}
          </footer>
        </div>
      </div>
    </article>
  );
}
export function App() {
  const dial = useDialKitController("CLI appearance", DIALS, {
    id: "aiden-cli-studio",
    persist: true,
  });
  const values: Look = dial.values;
  const [directionId, setDirectionId] = useState(() => {
    try {
      const id = localStorage.getItem("aiden-cli-studio:v1:direction");
      return DIRECTIONS.some((item) => item.id === id) ? id! : "quiet";
    } catch {
      return "quiet";
    }
  });
  const direction =
    DIRECTIONS.find((item) => item.id === directionId) ?? DIRECTIONS[0];
  const [scenario, setScenario] = useState<Scenario>("Conversation");
  const [compare, setCompare] = useState(false);
  const [baseline, setBaseline] = useState("quiet");
  const [playing, setPlaying] = useState(true);
  const [tick, setTick] = useState(0);
  const [replay, setReplay] = useState(0);
  const [saved, setSaved] = useState(loadSaved);
  const [notes, setNotes] = useState(() => {
    try {
      return (localStorage.getItem("aiden-cli-studio:v1:notes") ?? "").slice(
        0,
        2000,
      );
    } catch {
      return "";
    }
  });
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!playing || values.motion.reduced) return;
    const timer = window.setInterval(
      () => setTick((value) => value + 1),
      800 / values.motion.speed,
    );
    return () => window.clearInterval(timer);
  }, [playing, values.motion.speed, values.motion.reduced]);
  useEffect(() => {
    try {
      localStorage.setItem("aiden-cli-studio:v1:direction", directionId);
      localStorage.setItem("aiden-cli-studio:v1:notes", notes);
    } catch {
      /* Saving/exporting reports unavailable storage separately. */
    }
  }, [directionId, notes]);
  function choose(id: string) {
    const next = DIRECTIONS.find((item) => item.id === id) ?? DIRECTIONS[0];
    setDirectionId(id);
    dial.setValues(next.look);
    setReplay((value) => value + 1);
  }
  function persist(next: SavedLook[]) {
    try {
      localStorage.setItem("aiden-cli-studio:v1:saved", JSON.stringify(next));
      setSaved(next);
      return true;
    } catch {
      setNotice("Storage is unavailable. Export a brief to keep this look.");
      return false;
    }
  }
  function download() {
    const blob = new Blob(
      [JSON.stringify(exportBrief(direction, values, notes), null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `aiden-${direction.id}-design-brief.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Design brief exported. Ready to share when you choose.");
  }
  const modified = JSON.stringify(values) !== JSON.stringify(direction.look);
  return (
    <div
      className="studio"
      style={themeTokens(DIRECTIONS[0].look) as CSSProperties}
    >
      <header className="topbar">
        <a className="brand" href="#studio">
          <Terminal size={23} />
          <strong>aiden</strong>
          <span>/</span>
          <span>design studio</span>
        </a>
        <span className="prototype-label">CLI EXPLORATIONS / 01</span>
        <div className="button-row">
          <button
            type="button"
            aria-pressed={compare}
            onClick={() => setCompare((value) => !value)}
          >
            <Columns2 size={16} />
            Compare
          </button>
          <button
            type="button"
            onClick={() => {
              setName(`${direction.name}${modified ? " — custom" : ""}`);
              dialog.current?.showModal();
            }}
          >
            <Plus size={16} />
            Save look
          </button>
          <button type="button" className="primary" onClick={download}>
            <ArrowDownToLine size={16} />
            Export brief
          </button>
        </div>
      </header>
      <div className="workspace" id="studio">
        <nav className="directions" aria-label="Design directions">
          <div className="eyebrow">
            THE COLLECTION <span>10</span>
          </div>
          {DIRECTIONS.map((item, index) => (
            <button
              type="button"
              className="direction"
              key={item.id}
              aria-pressed={direction.id === item.id}
              onClick={() => choose(item.id)}
            >
              <span className="direction-number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>{item.tagline}</small>
              </span>
              {direction.id === item.id && <span className="selection-dot" />}
            </button>
          ))}
          <div className="saved-heading eyebrow">
            SAVED LOOKS <span>{saved.length}</span>
          </div>
          {saved.length === 0 ? (
            <p className="empty">
              Find something you like?
              <br />
              Save it to revisit later.
            </p>
          ) : (
            saved.map((item) => (
              <div className="saved-row" key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setDirectionId(item.directionId);
                    dial.setValues(item.look);
                    setNotes(item.notes);
                  }}
                >
                  {item.name}
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${item.name}`}
                  onClick={() =>
                    persist(saved.filter((row) => row.id !== item.id))
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
          <div className="nav-foot">
            <span className="status-dot" /> Local design playground
            <br />
            <span>Changes stay here until you choose.</span>
          </div>
        </nav>
        <main>
          <div className="intro">
            <div>
              <div className="eyebrow">
                {String(DIRECTIONS.indexOf(direction) + 1).padStart(2, "0")} /{" "}
                {direction.category}
              </div>
              <h1>
                {direction.name}
                <span>.</span>
              </h1>
              <p>{direction.description}</p>
            </div>
            <div className="intro-mark" aria-hidden="true">
              {direction.look.details.prompt}
            </div>
          </div>
          <div className="preview-toolbar">
            <div className="scenario-tabs" aria-label="Preview scenario">
              {SCENARIOS.map((item) => (
                <button
                  type="button"
                  key={item}
                  aria-pressed={scenario === item}
                  onClick={() => {
                    setScenario(item);
                    setReplay((value) => value + 1);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="button-row">
              <button
                type="button"
                className="icon-button"
                aria-label={playing ? "Pause preview" : "Play preview"}
                onClick={() => setPlaying((value) => !value)}
              >
                {playing ? <Pause size={15} /> : <Play size={15} />}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Replay preview"
                onClick={() => {
                  setReplay((value) => value + 1);
                  setTick(0);
                  setPlaying(true);
                }}
              >
                <RotateCcw size={15} />
              </button>
            </div>
          </div>
          <div className={`preview-grid ${compare ? "comparing" : ""}`}>
            {compare && (
              <div className="preview-column">
                <label className="preview-label">
                  BASELINE
                  <select
                    aria-label="Comparison baseline"
                    value={baseline}
                    onChange={(event) => setBaseline(event.target.value)}
                  >
                    {DIRECTIONS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Preview
                  key={`baseline-${baseline}-${replay}`}
                  label="Baseline"
                  look={
                    (
                      DIRECTIONS.find((item) => item.id === baseline) ??
                      DIRECTIONS[0]
                    ).look
                  }
                  scenario={scenario}
                  playing={playing}
                  tick={tick}
                />
              </div>
            )}
            <div className="preview-column">
              <div className="preview-label">
                <span>
                  {direction.name.toUpperCase()} {modified && <em>Modified</em>}
                </span>
                <span>INTERACTIVE PREVIEW</span>
              </div>
              <Preview
                key={`current-${replay}`}
                label="Current"
                look={values}
                scenario={scenario}
                playing={playing}
                tick={tick}
              />
            </div>
          </div>
          <div className="below-preview">
            <section>
              <div className="eyebrow">WHAT MAKES IT DIFFERENT</div>
              {direction.changes.map((change, index) => (
                <p key={change}>
                  <span className="muted">0{index + 1}</span>
                  {change}
                </p>
              ))}
            </section>
            <section>
              <label className="eyebrow" htmlFor="notes">
                YOUR CUSTOMIZATION NOTES
              </label>
              <textarea
                id="notes"
                value={notes}
                maxLength={2000}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Keep this spacing, try a quieter prompt…"
              />
              <small>Included in saved looks and your exported brief.</small>
            </section>
          </div>
          <p className="implementation-note">
            A working visual sketch of the CLI. Fonts and line height belong to
            your terminal settings; layouts need CLI implementation. All
            sessions here are simulated.
          </p>
        </main>
        <aside className="controls">
          <header>
            <SlidersHorizontal size={17} />
            <strong>Dial it in</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Reset current direction"
              onClick={() => dial.setValues(direction.look)}
            >
              <RotateCcw size={14} />
            </button>
          </header>
          <p>Start with a direction. Make it yours.</p>
          <DialRoot mode="inline" theme="dark" productionEnabled />
          <div className="control-footer">
            <Copy size={14} />
            <span>
              DialKit presets store control values.
              <br />
              Save look also keeps your notes.
            </span>
          </div>
        </aside>
      </div>
      <div className="notice" role="status">
        {notice && (
          <>
            <Check size={14} />
            {notice}
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={() => setNotice("")}
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
      <dialog ref={dialog} aria-labelledby="save-title">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (saved.length >= 30) {
              setNotice(
                "You have 30 saved looks. Delete one or export this brief.",
              );
              dialog.current?.close();
              return;
            }
            if (
              persist([
                ...saved,
                {
                  id: crypto.randomUUID(),
                  name: name.trim(),
                  directionId,
                  look: structuredClone(values),
                  notes,
                },
              ])
            )
              dialog.current?.close();
          }}
        >
          <header>
            <h2 id="save-title">Save this look</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close save dialog"
              onClick={() => dialog.current?.close()}
            >
              <X size={18} />
            </button>
          </header>
          <p>Keep your dials and notes together, on this browser.</p>
          <label htmlFor="look-name">Look name</label>
          <input
            id="look-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
          />
          <button type="submit" className="primary" disabled={!name.trim()}>
            Save look
          </button>
        </form>
      </dialog>
    </div>
  );
}
