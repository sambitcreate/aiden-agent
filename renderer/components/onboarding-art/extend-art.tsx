import {
  ArrowUp,
  Check,
  ChevronDown,
  Eye,
  FileText,
  FolderGit2,
  Globe,
  ImagePlus,
  Lock,
  Mic,
  Pin,
  Plug,
  Plus,
  Search,
  ShieldQuestion,
  SlidersHorizontal,
  SquareTerminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { AidenIcon } from "../aiden-icon";
import { ProviderIcon } from "../provider-icon";
import { McpPresetIcon } from "../settings/mcp-preset-icons";
import {
  ArtButton,
  ArtChip,
  ArtComposer,
  ArtIcon,
  ArtWindow,
  Bar,
  Toggle,
} from "./art-kit";

/* Art for the "Choose and extend" tiles. */

/** Five stops; the thumb rests on the third (home), so the fill runs to it. */
const SLIDER_STOPS = 5;
const SLIDER_ON = 2;

/**
 * The composer's model popover with the Agent Slider on top: the stop's name
 * and model over the track, its accent fill, stop dots and white thumb, and
 * the "Other models…" row under it.
 */
export function AgentSliderArt() {
  const fraction = SLIDER_ON / (SLIDER_STOPS - 1);
  return (
    <>
      <ArtWindow
        raised
        className="oa-slider-popover oa-anim-float"
        style={{ left: 14, top: 16, width: 168 }}
      >
        <div className="oa-slider-head">
          <ArtIcon icon={Zap} />
          <span className="oa-slider-name oa-anim-pop">Balanced</span>
          <Bar width="58%" tone="soft" className="oa-slider-detail" />
        </div>
        <div className="oa-slider-track">
          <i
            className="oa-slider-fill"
            style={{ width: `calc(14px + (100% - 14px) * ${fraction})` }}
          />
          {Array.from({ length: SLIDER_STOPS }, (_, index) => (
            <i
              key={index}
              className="oa-slider-dot"
              data-lit={index <= SLIDER_ON || undefined}
              style={{ left: `calc(7px + (100% - 14px) * ${index / (SLIDER_STOPS - 1)})` }}
            />
          ))}
          <i
            className="oa-slider-thumb"
            style={{ left: `calc(1px + (100% - 14px) * ${fraction})` }}
          />
        </div>
        <div className="oa-slider-row" data-first="">
          <ArtIcon icon={Search} />
          <Bar width="46%" />
        </div>
        <div className="oa-slider-row">
          <ArtIcon icon={SlidersHorizontal} />
          <Bar width="54%" tone="soft" />
        </div>
      </ArtWindow>
      <div className="oa-stack" style={{ position: "absolute", left: 22, top: 150, width: 150 }}>
        <Bar width="92%" tone="soft" className="oa-anim-type" />
        <Bar width="74%" tone="soft" className="oa-anim-type" style={{ animationDelay: "0.5s" }} />
        <Bar width="84%" tone="soft" className="oa-anim-type" style={{ animationDelay: "1s" }} />
      </div>
    </>
  );
}

/** Rows of the composer's model picker (List view), in its real row anatomy. */
const PICKER_MODELS = [
  { provider: "openai", label: "OpenAI", name: "62%", sub: "30%" },
  {
    provider: "anthropic",
    label: "Anthropic",
    model: "claude",
    name: "70%",
    sub: "38%",
    selected: true,
  },
  {
    provider: "google",
    label: "Google",
    name: "56%",
    sub: "32%",
    pinned: true,
  },
  { provider: "openrouter", label: "OpenRouter", name: "66%", sub: "42%" },
  {
    provider: "ollama",
    label: "Ollama",
    name: "48%",
    sub: "26%",
    format: "GGUF",
  },
  {
    provider: "lmstudio",
    label: "LM Studio",
    name: "58%",
    sub: "36%",
    format: "MLX",
  },
] as const;

export function ModelFreedomArt() {
  return (
    <>
      <ArtWindow
        raised
        className="oa-models-details"
        style={{ left: 14, top: 22, width: 126 }}
      >
        <div className="oa-row" style={{ alignItems: "flex-start", gap: 5 }}>
          <ProviderIcon
            providerId="anthropic"
            providerLabel="Anthropic"
            modelId="claude"
            className="oa-models-mark"
          />
          <span className="oa-stack" style={{ flex: 1, gap: 3 }}>
            <Bar width="78%" tone="ink" />
            <Bar width="46%" tone="soft" />
          </span>
        </div>
        <span className="oa-models-caps">Reasoning · Tools · Vision</span>
        <div className="oa-models-facts oa-stack">
          {[
            ["40%", "28%"],
            ["32%", "36%"],
            ["46%", "22%"],
          ].map(([label, value]) => (
            <div
              key={label}
              className="oa-row"
              style={{ justifyContent: "space-between" }}
            >
              <Bar width={label} tone="soft" />
              <Bar width={value} />
            </div>
          ))}
        </div>
      </ArtWindow>
      <ArtChip
        className="oa-models-local oa-anim-float"
        style={{ left: 16, top: 120 }}
      >
        <ProviderIcon
          providerId="ollama"
          providerLabel="Ollama"
          className="oa-models-chip-mark"
        />
        Ollama
        <span className="oa-models-via">on Tailscale</span>
        <ArtIcon icon={Lock} />
      </ArtChip>

      <div
        className="oa-composer oa-models-composer"
        style={{ left: 152, top: 206, width: 230 }}
      >
        <div className="oa-composer-bar" style={{ top: 8, bottom: "auto" }}>
          <ArtIcon icon={Plus} />
          <span className="oa-models-trigger">
            <ProviderIcon
              providerId="anthropic"
              providerLabel="Anthropic"
              modelId="claude"
              className="oa-models-chip-mark"
            />
            <Bar width={44} tone="ink" />
            <ArtIcon icon={ChevronDown} />
          </span>
          <span className="oa-grow" />
          <ArtIcon icon={Mic} />
          <span className="oa-send">
            <ArtIcon icon={ArrowUp} />
          </span>
        </div>
      </div>
      <ArtWindow
        raised
        className="oa-models-picker"
        style={{ left: 160, top: 8, width: 212 }}
      >
        <div className="oa-models-filter oa-separator-bottom">
          <ArtIcon icon={Search} />
          Filter models…
        </div>
        {PICKER_MODELS.map((model) => (
          <div
            key={model.provider}
            className={
              "oa-models-row" + ("selected" in model ? " oa-selected" : "")
            }
          >
            <ProviderIcon
              providerId={model.provider}
              providerLabel={model.label}
              modelId={"model" in model ? model.model : undefined}
              className="oa-models-mark"
            />
            <span className="oa-stack oa-grow" style={{ gap: 3 }}>
              <Bar
                width={model.name}
                tone={"selected" in model ? "ink" : undefined}
              />
              <Bar width={model.sub} tone="soft" />
            </span>
            {"format" in model ? (
              <span className="oa-models-format">{model.format}</span>
            ) : null}
            {"selected" in model ? (
              <ArtIcon icon={Check} className="oa-models-check" />
            ) : null}
            {"pinned" in model ? (
              <ArtIcon icon={Pin} className="oa-models-pin" />
            ) : null}
          </div>
        ))}
      </ArtWindow>
    </>
  );
}

/** One line of a codemode script, as [text, syntax token] runs. */
type CodeRun = readonly [
  string,
  "keyword" | "variable" | "title" | "string" | "plain",
];
const TOOL_SCRIPT: readonly (readonly CodeRun[])[] = [
  [
    ["const ", "keyword"],
    ["hits", "variable"],
    [" = ", "plain"],
    ["await ", "keyword"],
    ["tools.", "plain"],
    ["grep", "title"],
    ["(q)", "plain"],
  ],
  [
    ["for ", "keyword"],
    ["(", "plain"],
    ["const ", "keyword"],
    ["h ", "variable"],
    ["of ", "keyword"],
    ["hits", "variable"],
    [")", "plain"],
  ],
  [
    ["  await ", "keyword"],
    ["tools.", "plain"],
    ["slack_post", "title"],
    ["(h)", "plain"],
  ],
  [
    ["text", "title"],
    ["(", "plain"],
    ["`${", "string"],
    ["hits.length", "variable"],
    ["} posted`", "string"],
    [")", "plain"],
  ],
];

export function ToolScriptsArt() {
  return (
    <>
      <ArtWindow
        className="oa-script-window"
        style={{ left: 12, top: 10, width: 178 }}
      >
        <div className="oa-script-head oa-separator-bottom">
          <ArtIcon icon={SquareTerminal} />
          <span className="oa-strong">Codemode</span>
          <span className="oa-grow" />
          <span className="oa-mono" style={{ color: "var(--text-tertiary)" }}>
            js
          </span>
        </div>
        <div className="oa-script-code oa-mono">
          {TOOL_SCRIPT.map((line, index) => (
            <div
              key={index}
              className="oa-anim-type"
              style={{ animationDelay: `${index * 0.35}s` }}
            >
              {line.map(([text, token], run) => (
                <span key={run} data-token={token}>
                  {text}
                </span>
              ))}
            </div>
          ))}
        </div>
      </ArtWindow>
      <div
        className="oa-row"
        style={{ position: "absolute", left: 14, top: 100, gap: 4 }}
      >
        <ArtChip className="oa-anim-pop" style={{ animationDelay: "1.6s" }}>
          <span className="oa-add" style={{ display: "contents" }}>
            <ArtIcon icon={Check} />
          </span>
          3 tool calls
        </ArtChip>
        <ArtChip icon={ShieldQuestion}>Ask first</ArtChip>
      </div>
      <div
        className="oa-stack"
        style={{ position: "absolute", left: 16, top: 126, width: 160, gap: 5 }}
      >
        <Bar width="92%" />
        <Bar width="74%" />
        <Bar width="84%" tone="soft" />
        <Bar width="60%" tone="soft" />
        <Bar width="78%" tone="soft" />
        <Bar width="52%" tone="soft" />
        <Bar width="70%" tone="soft" />
        <Bar width="44%" tone="soft" />
      </div>
    </>
  );
}

/** A tiny landscape thumbnail drawn with shapes: sun and two mountains. */
function Landscape({ variant = 0 }: { variant?: 0 | 1 }) {
  return (
    <svg
      aria-hidden="true"
      className="oa-vision-thumb"
      viewBox="0 0 28 28"
      data-variant={variant}
    >
      <rect width="28" height="28" className="oa-vision-sky" />
      <circle cx={variant ? 8 : 20} cy="9" r="3.4" className="oa-vision-sun" />
      <path
        d={
          variant
            ? "M-2 28L9 13L17 22L22 16L30 28Z"
            : "M-2 28L8 15L15 23L20 17L30 28Z"
        }
        className="oa-vision-far"
      />
      <path
        d={variant ? "M-2 28L14 19L30 28Z" : "M4 28L17 18L30 28Z"}
        className="oa-vision-near"
      />
    </svg>
  );
}

export function AttachmentsVisionArt() {
  return (
    <>
      <ArtComposer
        style={{ left: 10, top: 10, width: 178, height: 84 }}
        placeholder=""
      >
        <span className="oa-vision-attachments">
          <span className="oa-vision-chip">
            <Landscape />
            <span className="oa-mono">trail.png</span>
            <ArtIcon icon={X} />
          </span>
          <span
            className="oa-vision-chip oa-anim-pop"
            style={{ animationDelay: "0.3s" }}
          >
            <Landscape variant={1} />
            <ArtIcon icon={X} />
          </span>
        </span>
        <span style={{ color: "var(--text-primary)" }}>
          Where was this taken?
        </span>
      </ArtComposer>
      <div
        className="oa-stack"
        style={{ position: "absolute", left: 14, top: 102, width: 168, gap: 5 }}
      >
        <ArtChip icon={Eye} style={{ justifySelf: "start" }}>
          Vision
        </ArtChip>
        <Bar
          width="94%"
          className="oa-anim-type"
          style={{ animationDelay: "0.6s" }}
        />
        <Bar
          width="72%"
          className="oa-anim-type"
          style={{ animationDelay: "0.8s" }}
        />
      </div>
      <ArtWindow
        raised
        className="oa-vision-approve"
        style={{ left: 12, top: 148, width: 172 }}
      >
        <ArtIcon icon={ImagePlus} />
        <span className="oa-strong">Edit image</span>
        <span className="oa-grow" />
        <ArtButton variant="ghost">Deny</ArtButton>
        <ArtButton variant="primary">Allow</ArtButton>
      </ArtWindow>
      <div
        className="oa-stack"
        style={{ position: "absolute", left: 14, top: 184, width: 168, gap: 5 }}
      >
        <Bar width="88%" tone="soft" />
        <Bar width="64%" tone="soft" />
        <Bar width="78%" tone="soft" />
        <Bar width="50%" tone="soft" />
      </div>
    </>
  );
}

const WEB_SOURCES = [
  { domain: "nps.gov", title: "52%" },
  { domain: "arxiv.org", title: "40%" },
  { domain: "nature.com", title: "44%" },
] as const;

export function WebSearchArt() {
  return (
    <>
      <div className="oa-web-line" style={{ left: 14, top: 12, width: 168 }}>
        <ArtIcon icon={Globe} />
        <span className="oa-strong">Searched the web</span>
        <span className="oa-grow" />
        <span className="oa-web-count">3 sources</span>
      </div>
      <ArtWindow
        className="oa-web-sources"
        style={{ left: 10, top: 30, width: 176 }}
      >
        {WEB_SOURCES.map(({ domain, title }, index) => (
          <div
            key={domain}
            className="oa-web-source oa-anim-pop"
            style={{ animationDelay: `${0.3 + index * 0.25}s` }}
          >
            <i className="oa-web-favicon" data-index={index} />
            <Bar width={title} tone="ink" />
            <span className="oa-grow" />
            <span className="oa-mono oa-web-domain">{domain}</span>
          </div>
        ))}
      </ArtWindow>
      <div
        className="oa-stack"
        style={{ position: "absolute", left: 14, top: 98, width: 166, gap: 5 }}
      >
        <Bar width="96%" />
        <Bar width="82%" />
        <Bar width="64%" />
      </div>
      <ArtWindow
        raised
        className="oa-web-setting"
        style={{ left: 14, top: 128, width: 166 }}
      >
        <ArtIcon icon={Globe} />
        <span className="oa-strong">Exa</span>
        <Bar width={40} tone="soft" />
        <span className="oa-grow" />
        <Toggle on />
      </ArtWindow>
      <div
        className="oa-stack"
        style={{ position: "absolute", left: 14, top: 166, width: 166, gap: 5 }}
      >
        <Bar width="88%" tone="soft" />
        <Bar width="70%" tone="soft" />
        <Bar width="80%" tone="soft" />
        <Bar width="54%" tone="soft" />
      </div>
    </>
  );
}

const SKILL_ROWS = [
  { name: "$release-notes", source: "Workspace", detail: "66%" },
  { name: "$review-pr", source: "Global", detail: "54%" },
  { name: "$repo-map", source: "Global", detail: "60%" },
] as const;

export function ReusableSkillsArt() {
  return (
    <>
      <div
        className="oa-stack"
        style={{
          position: "absolute",
          left: 12,
          top: 12,
          gap: 5,
          justifyItems: "start",
        }}
      >
        <ArtChip icon={FolderGit2}>
          <span className="oa-mono">.agents/skills</span>
        </ArtChip>
        <ArtChip icon={Zap}>Auto or $</ArtChip>
      </div>
      <ArtWindow
        raised
        className="oa-skill-palette"
        style={{ left: 122, top: 6, width: 178 }}
      >
        {SKILL_ROWS.map(({ name, source, detail }, index) => (
          <div
            key={name}
            className={"oa-skill-row" + (index === 0 ? " oa-selected" : "")}
          >
            <AidenIcon aria-hidden="true" className="oa-skill-icon" />
            <span className="oa-skill-name">{name}</span>
            <span className="oa-skill-source">{source}</span>
            <span
              className="oa-grow"
              style={{ display: "flex", justifyContent: "flex-end" }}
            >
              <Bar width={detail} tone="soft" />
            </span>
          </div>
        ))}
      </ArtWindow>
      <ArtComposer style={{ left: 128, top: 82, width: 154 }}>
        <span style={{ color: "var(--text-primary)" }}>$re</span>
      </ArtComposer>
    </>
  );
}

const MCP_SERVICES = [
  { id: "linear", name: "Linear", tools: 23, resources: 6, enabled: true },
  { id: "github", name: "GitHub", tools: 41, resources: 12, enabled: true },
  { id: "notion", name: "Notion", tools: 14, resources: 0, enabled: false },
] as const;

export function McpConnectorsArt() {
  return (
    <>
      <div
        className="oa-stack"
        style={{
          position: "absolute",
          left: 12,
          top: 12,
          gap: 5,
          justifyItems: "start",
        }}
      >
        <ArtChip icon={Plug}>Local or hosted</ArtChip>
        <ArtChip icon={Lock}>OAuth sign-in</ArtChip>
      </div>
      <ArtWindow
        className="oa-mcp-card"
        style={{ left: 120, top: 8, width: 166 }}
      >
        {MCP_SERVICES.map(({ id, name, tools, resources, enabled }, index) => (
          <div
            key={id}
            className={"oa-mcp-row" + (index > 0 ? " oa-mcp-divided" : "")}
          >
            <span className="oa-mcp-avatar">
              <McpPresetIcon
                presetId={id}
                name={name}
                className="oa-mcp-logo"
              />
            </span>
            <span className="oa-stack oa-grow" style={{ gap: 3 }}>
              <span className="oa-row" style={{ gap: 4 }}>
                <span className="oa-strong">{name}</span>
                <span
                  className={
                    "oa-mcp-status" + (index === 1 ? " oa-anim-pop" : "")
                  }
                  data-on={enabled || undefined}
                  style={index === 1 ? { animationDelay: "0.4s" } : undefined}
                >
                  {enabled ? <ArtIcon icon={Check} /> : null}
                  {enabled ? "Connected" : "Off"}
                </span>
              </span>
              <span className="oa-row oa-mcp-meta" style={{ gap: 6 }}>
                <span className="oa-row" style={{ gap: 2 }}>
                  <ArtIcon icon={Wrench} />
                  {tools}
                </span>
                {resources ? (
                  <span className="oa-row" style={{ gap: 2 }}>
                    <ArtIcon icon={FileText} />
                    {resources}
                  </span>
                ) : null}
              </span>
            </span>
            <Toggle on={enabled} />
          </div>
        ))}
      </ArtWindow>
    </>
  );
}
