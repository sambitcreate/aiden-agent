import {
  Bot,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Ellipsis,
  Folder,
  Keyboard,
  Link2,
  Lock,
  MessageSquare,
  Mic,
  Mic2,
  Monitor,
  Moon,
  MousePointer2,
  OctagonAlert,
  Play,
  Search,
  Send,
  Settings,
  ShieldCheck,
  ShieldQuestion,
  Square,
  Sun,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { AidenActivityMark } from "../aiden-activity-mark";
import { AvatarFace } from "../bot-avatar";
import { ProviderIcon } from "../provider-icon";
import { THEME_PRESETS, type ThemePresetId } from "../../shared/appearance";
import { COMMAND_BY_ID, prettyAcceleratorForPlatform, type CommandId } from "../../shared/keybindings";
import {
  ArtButton,
  ArtChip,
  ArtIcon,
  ArtWindow,
  Bar,
  Radio,
  Toggle,
  TrafficLights,
  type ArtProps,
} from "./art-kit";

/* Art for the "Automate and stay in control" tiles. */

/** The composer's workspace access menu, in its real order and icon colours. */
const ACCESS_LEVELS = [
  { label: "Full access", icon: OctagonAlert, color: "var(--support-warning)", detail: "60%" },
  { label: "Ask first", icon: ShieldQuestion, color: "var(--text-secondary)", detail: "84%" },
  { label: "No access", icon: Lock, color: "var(--text-tertiary)", detail: "70%" },
] as const;

export function PermissionsArt() {
  return (
    <>
      <div className="oa-stack" style={{ position: "absolute", left: 12, top: 12, gap: 5, justifyItems: "start" }}>
        <ArtChip icon={Folder}>
          <span className="oa-mono">aiden-macos</span>
        </ArtChip>
        <ArtChip icon={Lock}>Keys encrypted</ArtChip>
      </div>
      <ArtWindow raised className="oa-perm-menu" style={{ left: 132, top: 9, width: 172 }}>
        <div className="oa-perm-selection">
          <Radio checked />
        </div>
        {ACCESS_LEVELS.map(({ label, icon, color, detail }) => (
          <div key={label} className="oa-perm-row">
            <Radio />
            <span style={{ color, display: "contents" }}>
              <ArtIcon icon={icon} />
            </span>
            <span className="oa-perm-label">
              <b>{label}</b>
              <Bar width={detail} tone="soft" />
            </span>
          </div>
        ))}
      </ArtWindow>
    </>
  );
}


/** Live's floating HUD over a shared window, waiting on a one-action voice approval. */
export function AidenLiveArt() {
  return (
    <>
      <ArtWindow className="oa-live-screen" style={{ left: 14, top: 18, width: 186, height: 170 }}>
        <div className="oa-live-screen-bar oa-separator-bottom">
          <TrafficLights />
          <Bar width={46} tone="soft" />
        </div>
        <div className="oa-live-screen-body">
          <div className="oa-stack" style={{ gap: 5 }}>
            <Bar width="70%" tone="soft" />
            <Bar width="52%" tone="soft" />
            <Bar width="62%" tone="soft" />
            <Bar width="44%" tone="soft" />
            <Bar width="58%" tone="soft" />
          </div>
          <div className="oa-stack" style={{ gap: 5 }}>
            <Bar width="86%" />
            <Bar width="100%" tone="soft" />
            <Bar width="74%" tone="soft" />
            <Bar width="90%" tone="soft" />
            <Bar width="62%" tone="soft" />
            <span className="oa-live-target">
              <Bar width={30} tone="ink" />
            </span>
          </div>
        </div>
        <span className="oa-live-cursor">
          <ArtIcon icon={MousePointer2} />
        </span>
      </ArtWindow>
      <ArtChip icon={Monitor} className="oa-live-sharing" style={{ left: 24, top: 160 }}>
        Sharing screen
      </ArtChip>
      <ArtWindow raised className="oa-live-hud" style={{ left: 178, top: 26, width: 200 }}>
        <div className="oa-live-head">
          <span className="oa-live-mark">
            <AidenActivityMark mark="glance" size={20} />
          </span>
          <span className="oa-stack" style={{ gap: 3, flex: 1 }}>
            <span className="oa-row">
              <span className="oa-strong">Live</span>
              <span className="oa-live-badge">Approval needed</span>
            </span>
            <span style={{ color: "var(--text-tertiary)" }}>Google Gemini</span>
          </span>
          <span className="oa-live-stop">
            <ArtIcon icon={Square} />
          </span>
        </div>
        <div className="oa-live-captions">
          <div className="oa-row">
            <b>You</b>
            <Bar width="46%" tone="soft" />
            <span className="oa-live-level">
              {[0, 0.25, 0.1, 0.4, 0.18].map((delay) => (
                <i key={delay} className="oa-anim-bars" style={{ animationDelay: `${delay}s` }} />
              ))}
            </span>
          </div>
          <div className="oa-row">
            <b>Aiden</b>
            <Bar width="62%" tone="soft" />
          </div>
        </div>
        <div className="oa-live-approval">
          <div className="oa-row" style={{ gap: 5 }}>
            <span className="oa-live-approval-icon">
              <ArtIcon icon={Mic2} />
            </span>
            <span className="oa-strong">Voice approval required</span>
          </div>
          <div className="oa-stack" style={{ gap: 4, margin: "7px 0 8px" }}>
            <Bar width="88%" />
            <Bar width="70%" tone="soft" />
            <Bar width="48%" tone="soft" />
          </div>
          {/* Live approvals are spoken, not clicked. */}
          <div className="oa-live-say">
            Say <span className="oa-live-word">“Allow once”</span> or <span className="oa-live-word">“Deny.”</span>
          </div>
        </div>
      </ArtWindow>
    </>
  );
}

/** A Bot's single chat: name pill header, one exchange, and its weekly routine. */
export function BotsArt() {
  return (
    <>
      <ArtWindow style={{ left: 12, top: 10, width: 172, height: 250 }}>
        <div className="oa-bots-head oa-separator-bottom">
          <ArtIcon icon={ChevronLeft} />
          <span className="oa-bots-name">
            <span className="oa-bots-avatar">
              <AvatarFace avatar={{ version: 1, shape: "drop", color: "peach" }} />
            </span>
            Meal Planner
          </span>
          <span className="oa-grow" />
          <ArtIcon icon={Ellipsis} />
        </div>
        <div className="oa-bots-body">
          <div className="oa-bots-bubble">
            <Bar width="100%" />
          </div>
          <div className="oa-stack" style={{ gap: 4, width: "84%", marginTop: 7 }}>
            <Bar width="96%" tone="soft" className="oa-anim-type" />
            <Bar width="62%" tone="soft" className="oa-anim-type" style={{ animationDelay: "0.2s" }} />
          </div>
        </div>
      </ArtWindow>
      <ArtChip icon={CalendarClock} className="oa-bots-routine" style={{ left: 20, top: 86 }}>
        Every Sunday at 9:00 AM
      </ArtChip>
    </>
  );
}

const SCHEDULED_TASKS = [
  { name: "58%", cadence: "Every day at 9:00 AM", on: true },
  { name: "46%", cadence: "Weekdays at 5:00 PM", on: false },
  { name: "64%", cadence: "Every hour", on: true },
  { name: "52%", cadence: "Every 30 minutes", on: true },
  { name: "40%", cadence: "Every Monday at 10:00 AM", on: false },
] as const;

/** The scheduled-tasks list with one task open on its access and actions. */
export function ScheduledAutomationsArt() {
  const [first, ...rest] = SCHEDULED_TASKS;
  return (
    <ArtWindow className="oa-sched" style={{ left: 10, top: 10, width: 171, height: "calc(100% + 20px)", minHeight: 260 }}>
      <div className="oa-sched-title">
        <ArtIcon icon={CalendarClock} />
        Scheduled tasks
      </div>
      <div className="oa-sched-list">
        <div className="oa-sched-open oa-selected">
          <div className="oa-sched-row">
            <i className="oa-sched-dot" data-on="" />
            <span className="oa-sched-text">
              <Bar width={first.name} tone="ink" />
              <span>{first.cadence}</span>
            </span>
            <Toggle on />
          </div>
          <div className="oa-sched-detail">
            <div className="oa-sched-field">
              <ArtIcon icon={ShieldCheck} />
              <span>Access</span>
              <b>Read-only</b>
            </div>
            <div className="oa-sched-field">
              <ArtIcon icon={Folder} />
              <span>Workspace</span>
              <Bar width={40} />
            </div>
            <div className="oa-row" style={{ gap: 4, marginTop: 3 }}>
              <ArtButton variant="ghost" icon={Play} className="oa-anim-press" style={{ animationDelay: "0.6s" }}>
                Run now
              </ArtButton>
              <ArtButton variant="ghost">Pause</ArtButton>
            </div>
          </div>
        </div>
        {rest.map((task) => (
          <div key={task.cadence} className="oa-sched-row">
            <i className="oa-sched-dot" data-on={task.on || undefined} />
            <span className="oa-sched-text">
              <Bar width={task.name} />
              <span>{task.on ? task.cadence : "Paused"}</span>
            </span>
            <Toggle on={task.on} />
          </div>
        ))}
      </div>
    </ArtWindow>
  );
}

/** Dictating into the composer, with the system-wide pill and its on-device engine. */
export function VoiceDictationArt() {
  return (
    <>
      <div className="oa-composer oa-voice-composer" style={{ left: 12, top: 10, width: 170 }}>
        <div className="oa-row" style={{ gap: 3, flexWrap: "wrap", rowGap: 4 }}>
          <Bar width={44} tone="ink" className="oa-anim-type" />
          <Bar width={30} tone="ink" className="oa-anim-type" style={{ animationDelay: "0.3s" }} />
          <Bar width={38} tone="ink" className="oa-anim-type" style={{ animationDelay: "0.6s" }} />
          <Bar width={26} tone="soft" className="oa-anim-type" style={{ animationDelay: "0.9s" }} />
        </div>
        <div className="oa-composer-bar">
          <ArtChip icon={Cpu}>On-device</ArtChip>
          <span className="oa-grow" />
          <span className="oa-voice-mic">
            <ArtIcon icon={Mic} />
          </span>
        </div>
      </div>
      <ArtWindow raised className="oa-voice-pill" style={{ left: 30, top: 76 }}>
        <i className="oa-voice-rec" />
        <span className="oa-voice-wave">
          {[0, 0.3, 0.12, 0.45, 0.2, 0.36, 0.06, 0.28].map((delay) => (
            <i key={delay} className="oa-anim-bars" style={{ animationDelay: `${delay}s` }} />
          ))}
        </span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>0:04</span>
        <ArtIcon icon={X} />
      </ArtWindow>
    </>
  );
}

const PALETTE_COMMANDS: ReadonlyArray<{ title: string; icon: LucideIcon; command?: CommandId }> = [
  { title: "New chat", icon: MessageSquare, command: "chat.new" },
  { title: "Search chats", icon: MessageSquare, command: "chat.search" },
  { title: "Toggle terminal", icon: Wrench, command: "terminal.toggle" },
  { title: "Change model", icon: Search },
  { title: "Open Settings", icon: Settings, command: "settings.open" },
];

/** A command's default shortcut as this platform's palette prints it. */
function shortcut(command: CommandId, platform: ArtProps["platform"]): string {
  return prettyAcceleratorForPlatform(COMMAND_BY_ID[command].defaultBinding, platform);
}

/** The command palette, root mode, with the first command selected. */
export function CommandPaletteArt({ platform }: ArtProps) {
  return (
    <ArtWindow raised className="oa-cmd" style={{ left: 12, top: 10, width: 170 }}>
      <div className="oa-cmd-crumb">
        <span className="oa-cmd-key-badge">
          <ArtIcon icon={Keyboard} />
        </span>
        <span className="oa-strong" style={{ fontWeight: 600 }}>
          Commands
        </span>
        <span className="oa-grow" />
        <kbd className="oa-cmd-kbd">{shortcut("commandPalette.toggle", platform)}</kbd>
      </div>
      <div className="oa-cmd-search">
        <ArtIcon icon={Search} />
        <Bar width="62%" tone="soft" />
        <i className="oa-caret" />
      </div>
      <div className="oa-cmd-list">
        {PALETTE_COMMANDS.map(({ title, icon, command }, index) => (
          <div key={title} className={`oa-cmd-row${index === 0 ? " oa-selected" : ""}`}>
            <ArtIcon icon={icon} />
            <span className="oa-grow">{title}</span>
            {command ? (
              <span className="oa-cmd-shortcut">{shortcut(command, platform)}</span>
            ) : (
              <ArtIcon icon={ChevronRight} />
            )}
          </div>
        ))}
      </div>
    </ArtWindow>
  );
}

const VOICE_NOTE_BARS = [3, 6, 9, 5, 8, 11, 7, 4, 8, 6, 10, 5, 3, 6, 4];

/** A paired messenger chat with Aiden, in Aiden's own tokens. */
export function TelegramArt() {
  return (
    <ArtWindow className="oa-tg" style={{ left: 12, top: 10, width: 172, height: 250 }}>
      <div className="oa-tg-head oa-separator-bottom">
        <span className="oa-tg-avatar">
          <ArtIcon icon={Bot} />
        </span>
        <span className="oa-strong">Aiden</span>
        <span className="oa-grow" />
        <ArtChip icon={Link2}>Paired</ArtChip>
      </div>
      <div className="oa-tg-body">
        <div className="oa-tg-bubble">
          <Bar width={96} tone="soft" />
          <Bar width={62} tone="soft" />
        </div>
        <div className="oa-tg-bubble oa-tg-voice oa-anim-pop" data-out="" style={{ animationDelay: "0.6s" }}>
          <span className="oa-tg-play">
            <ArtIcon icon={Play} />
          </span>
          <svg aria-hidden="true" viewBox="0 0 60 12" width="60" height="12">
            {VOICE_NOTE_BARS.map((height, index) => (
              <rect key={index} x={index * 4} y={6 - height / 2} width="2" height={height} rx="1" />
            ))}
          </svg>
          <span>0:07</span>
        </div>
        <div className="oa-tg-input">
          <Bar width="58%" tone="soft" />
          <span className="oa-grow" />
          <span className="oa-send">
            <ArtIcon icon={Send} />
          </span>
        </div>
      </div>
    </ArtWindow>
  );
}

/** QR modules for the pairing card: a stylised, static code with three finder corners. */
const PAIRING_QR = [
  "1110101",
  "1010010",
  "1110111",
  "0001010",
  "1011101",
  "0100110",
  "1101011",
];

/** A paired phone beside the desktop's one-time pairing code. */
export function AidenOnTheGoArt() {
  return (
    <>
      <div className="oa-otg-phone" style={{ left: 12, top: 10, width: 62, height: 150 }}>
        <i className="oa-otg-notch" />
        <div className="oa-otg-screen">
          <div className="oa-ws-bubble" style={{ width: "74%", padding: "4px 5px", gap: 3 }}>
            <Bar width="100%" />
            <Bar width="56%" />
          </div>
          <div className="oa-stack" style={{ gap: 3, marginTop: 7 }}>
            <Bar width="92%" tone="soft" />
            <Bar width="100%" tone="soft" />
            <Bar width="70%" tone="soft" />
            <Bar width="84%" tone="soft" />
          </div>
        </div>
      </div>
      <ArtWindow raised className="oa-otg-card" style={{ left: 82, top: 18, width: 100 }}>
        <div className="oa-row" style={{ gap: 6 }}>
          <svg aria-hidden="true" className="oa-otg-qr" viewBox="0 0 7 7" width="26" height="26" shapeRendering="crispEdges">
            {PAIRING_QR.flatMap((row, y) =>
              [...row].map((cell, x) => (cell === "1" ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" /> : null)),
            )}
          </svg>
          <span className="oa-stack" style={{ gap: 4, flex: 1 }}>
            <Bar width="92%" tone="ink" />
            <Bar width="64%" tone="soft" />
          </span>
        </div>
        <span className="oa-otg-label">Enter this code instead</span>
        <div className="oa-otg-code">
          {["7K3Q", "M9TX", "4F2B"].map((group) => (
            <span key={group}>{group}</span>
          ))}
        </div>
        <span className="oa-otg-label" style={{ marginTop: 5 }}>
          Expires in 4:52
        </span>
      </ArtWindow>
    </>
  );
}

/** Heatmap intensity (0–4) for the activity grid: seven days down, weeks across. */
const ACTIVITY_LEVELS =
  "01201300214031002431" +
  "12030421032410213042" +
  "02413204130421043012" +
  "13024012403120134201" +
  "20134210230413201324" +
  "01203100120310021201" +
  "00102001010200100100";

const TOKEN_MIX = [
  { label: "Input", share: 46 },
  { label: "Output", share: 28 },
  { label: "Cached", share: 26 },
] as const;

/** The private usage profile: model activity, token mix, and the top model. */
export function UsageProfileArt() {
  return (
    <ArtWindow className="oa-usage" style={{ left: 12, top: 10, width: 200, height: 250 }}>
      <div className="oa-row">
        <span className="oa-strong">Model activity</span>
        <ArtChip icon={Lock} style={{ marginLeft: 6 }}>
          On-device
        </ArtChip>
      </div>
      <div className="oa-usage-split">
        <div className="oa-usage-heatmap">
          {Array.from({ length: 7 * 12 }, (_, index) => {
            const row = index % 7;
            const week = Math.floor(index / 7);
            return <i key={index} data-level={ACTIVITY_LEVELS[row * 20 + week]} />;
          })}
        </div>
        <div className="oa-usage-mix">
          <span>Token mix</span>
          <span className="oa-usage-mix-bar">
            {TOKEN_MIX.map(({ label, share }, index) => (
              <i key={label} data-index={index} style={{ width: `${share}%` }} />
            ))}
          </span>
          {TOKEN_MIX.map(({ label, share }, index) => (
            <span key={label} className="oa-row" style={{ gap: 3 }}>
              <i className="oa-usage-dot" data-index={index} />
              <Bar width={22} tone="soft" />
              <span className="oa-grow" />
              <span className="oa-usage-pct">{share}%</span>
            </span>
          ))}
        </div>
      </div>
      <div className="oa-usage-models">
        {[
          { id: "anthropic", label: "Anthropic", share: "86%" },
          { id: "openai", label: "OpenAI", share: "54%" },
        ].map((model) => (
          <span key={model.id} className="oa-row" style={{ gap: 5 }}>
            <ProviderIcon providerId={model.id} providerLabel={model.label} className="oa-usage-provider" />
            <Bar width={40} />
            <span className="oa-usage-meter">
              <i style={{ width: model.share }} />
            </span>
          </span>
        ))}
      </div>
    </ArtWindow>
  );
}

/** The presets that paint the theme tiles, each in its signature scheme (as Appearance shows them). */
const THEME_TILES: ReadonlyArray<{ id: ThemePresetId; scheme: "light" | "dark" }> = [
  { id: "aiden", scheme: "light" },
  { id: "berry", scheme: "light" },
  { id: "moss", scheme: "light" },
  { id: "paper", scheme: "light" },
  { id: "dusk", scheme: "dark" },
  { id: "midnight", scheme: "dark" },
];

const AIDEN_PRESET = THEME_PRESETS.find((preset) => preset.id === "aiden")!;

const APPEARANCE_MODES: ReadonlyArray<{ label: string; icon: LucideIcon; schemes: ReadonlyArray<"light" | "dark"> }> = [
  { label: "System", icon: Monitor, schemes: ["light", "dark"] },
  { label: "Light", icon: Sun, schemes: ["light"] },
  { label: "Dark", icon: Moon, schemes: ["dark"] },
];

/** Appearance settings: the System / Light / Dark picker and the preset theme tiles. */
export function ThemesArt() {
  return (
    <>
      <div className="oa-themes-modes" style={{ left: 10, top: 12, width: 132 }}>
        {APPEARANCE_MODES.map(({ label, icon, schemes }, index) => (
          <span key={label} className="oa-themes-mode">
            <span className="oa-themes-mode-preview">
              {schemes.map((scheme) => {
                const palette = AIDEN_PRESET[scheme];
                return (
                  <span key={scheme} style={{ background: palette.raised }}>
                    <i style={{ background: palette.sidebar }} />
                    <b style={{ background: palette.secondary }} />
                  </span>
                );
              })}
            </span>
            <span className={`oa-themes-label${index === 0 ? " oa-selected" : ""}`}>
              <ArtIcon icon={icon} />
              {label}
            </span>
          </span>
        ))}
      </div>
      <div className="oa-themes-grid" style={{ left: 154, top: 12, width: 126 }}>
        {THEME_TILES.map(({ id, scheme }) => {
          const preset = THEME_PRESETS.find((entry) => entry.id === id)!;
          const palette = preset[scheme];
          const selected = id === "aiden";
          return (
            <span key={id} className="oa-themes-tile">
              <span className="oa-themes-swatch" style={{ background: palette.canvas, color: palette.foreground }}>
                Aa
                <i style={{ background: palette.accent }} />
                {selected ? (
                  <span className="oa-themes-check oa-anim-pop">
                    <ArtIcon icon={Check} />
                  </span>
                ) : null}
              </span>
              <span className={`oa-themes-label${selected ? " oa-selected" : ""}`}>{preset.label}</span>
            </span>
          );
        })}
      </div>
    </>
  );
}
