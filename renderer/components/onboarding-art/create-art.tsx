import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FilePen,
  FileText,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Globe,
  ListPlus,
  MessageCirclePlus,
  MousePointer2,
  Plus,
  RotateCw,
  Save,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Upload,
  X,
} from "lucide-react";
import { AidenActivityMark } from "../aiden-activity-mark";
import {
  ArtButton,
  ArtChip,
  ArtComposer,
  ArtIcon,
  ArtWindow,
  Bar,
  DiffStat,
  TrafficLights,
} from "./art-kit";

/* Art for the "Build in your workspace" tiles. */

export function WorkspaceAgentArt() {
  return (
    <>
      <ArtWindow className="oa-ws-window" style={{ left: 150, top: 18, width: 252, height: 262 }}>
        <div className="oa-ws-sidebar">
          <TrafficLights style={{ marginBottom: 4 }} />
          <div className="oa-ws-search">
            <ArtIcon icon={Search} />
            <Bar width="60%" tone="soft" />
          </div>
          <div className="oa-ws-chat oa-selected">
            <Bar width="72%" />
          </div>
          <div className="oa-ws-chat">
            <Bar width="56%" tone="soft" />
          </div>
          <div className="oa-ws-chat">
            <Bar width="66%" tone="soft" />
          </div>
          <div className="oa-ws-chat">
            <Bar width="48%" tone="soft" />
          </div>
        </div>
        <div className="oa-ws-main">
          <div className="oa-ws-bubble">
            <Bar width="100%" />
            <Bar width="62%" />
          </div>
          <div className="oa-ws-reply">
            <Bar width="92%" className="oa-anim-type" />
            <Bar width="100%" className="oa-anim-type" style={{ animationDelay: "0.18s" }} />
            <Bar width="70%" className="oa-anim-type" style={{ animationDelay: "0.36s" }} />
          </div>
          <div className="oa-ws-tool oa-anim-pop" style={{ animationDelay: "0.9s" }}>
            <ArtIcon icon={FilePen} />
            <span className="oa-strong">Edited</span>
            <span className="oa-mono">onboarding.tsx</span>
            <DiffStat added={12} removed={3} />
          </div>
          <div className="oa-ws-reply">
            <Bar width="84%" className="oa-anim-type" style={{ animationDelay: "1.5s" }} />
            <Bar width="46%" className="oa-anim-type" style={{ animationDelay: "1.68s" }} />
          </div>
          <ArtComposer style={{ left: 9, right: 9, top: 150 }} />
        </div>
      </ArtWindow>
      <ArtWindow raised className="oa-ws-queued oa-anim-float" style={{ left: 16, top: 62, width: 150 }}>
        <div className="oa-ws-queued-head">
          <ArtIcon icon={ListPlus} />
          Queued
          <span className="oa-grow" />
          <span style={{ color: "var(--text-tertiary)", fontWeight: 500 }}>2</span>
        </div>
        <Bar width="92%" />
        <Bar width="60%" />
        <div className="oa-row" style={{ marginTop: 2 }}>
          <ArtChip>Steer</ArtChip>
          <ArtChip>Edit</ArtChip>
        </div>
      </ArtWindow>
      <ArtChip icon={FileText} className="oa-ws-agents" style={{ left: 22, top: 26 }}>
        AGENTS.md
        <span className="oa-add">
          <ArtIcon icon={Check} />
        </span>
      </ArtChip>
    </>
  );
}

export function ReviewDiffsArt() {
  return (
    <ArtWindow style={{ left: 12, top: 10, width: 194, height: 250 }}>
      <div className="oa-diff-head oa-separator-bottom">
        <ArtIcon icon={File} />
        <span className="oa-mono">app.tsx</span>
        <span className="oa-grow" />
        <DiffStat added={12} removed={3} />
      </div>
      <div className="oa-diff-line">
        <i className="oa-diff-gutter" />
        <Bar width="70%" tone="soft" />
      </div>
      <div className="oa-diff-line" data-kind="del">
        <i className="oa-diff-gutter" />
        <span className="oa-diff-sign">−</span>
        <Bar width="58%" />
      </div>
      <div className="oa-diff-line" data-kind="del">
        <i className="oa-diff-gutter" />
        <span className="oa-diff-sign">−</span>
        <Bar width="44%" />
      </div>
      <div className="oa-diff-line oa-anim-pop" data-kind="add" style={{ animationDelay: "0.3s" }}>
        <i className="oa-diff-gutter" />
        <span className="oa-diff-sign">+</span>
        <Bar width="76%" />
      </div>
      <div className="oa-diff-line oa-anim-pop" data-kind="add" style={{ animationDelay: "0.55s" }}>
        <i className="oa-diff-gutter" />
        <span className="oa-diff-sign">+</span>
        <Bar width="52%" />
      </div>
      {["64%", "48%", "72%", "38%", "58%", "66%", "44%", "70%", "52%", "60%", "36%", "62%", "50%", "68%", "42%"].map(
        (width, index) => (
          <div key={index} className="oa-diff-line">
            <i className="oa-diff-gutter" />
            <Bar width={width} tone="soft" />
          </div>
        ),
      )}
    </ArtWindow>
  );
}

export function TerminalArt() {
  return (
    <ArtWindow style={{ left: 12, top: 10, width: 200, height: 250 }}>
      <div className="oa-term-tabs oa-separator-bottom">
        <span className="oa-term-tab oa-selected">
          <ArtIcon icon={SquareTerminal} />
          zsh
        </span>
        <span className="oa-term-tab">npm</span>
        <span className="oa-grow" />
        <ArtIcon icon={Plus} />
      </div>
      <div className="oa-term-body">
        <div className="oa-term-pane">
          <div>
            <span className="oa-term-prompt">❯</span> npm test
          </div>
          <div className="oa-add" style={{ fontWeight: 500 }}>✓ 128 passed</div>
          <div style={{ color: "var(--text-tertiary)" }}>2 skipped · 3.1s</div>
          <div>
            <span className="oa-term-prompt">❯</span> git status
          </div>
          <div style={{ color: "var(--text-tertiary)" }}>On branch feature/art</div>
          <div style={{ color: "var(--text-tertiary)" }}>nothing to commit</div>
          <div>
            <span className="oa-term-prompt">❯</span> npm run build
          </div>
          <div className="oa-add" style={{ fontWeight: 500 }}>✓ built in 4.2s</div>
          <div>
            <span className="oa-term-prompt">❯</span> <i className="oa-term-cursor oa-anim-blink" />
          </div>
        </div>
        <div className="oa-term-pane oa-separator-left" data-split="">
          <Bar width="80%" tone="soft" />
          <Bar width="56%" tone="soft" />
          <Bar width="70%" tone="soft" />
          {["40%", "66%", "52%", "74%", "34%", "58%", "46%", "62%"].map((width, index) => (
            <Bar key={index} width={width} tone="soft" />
          ))}
        </div>
      </div>
    </ArtWindow>
  );
}

export function GitWorkflowsArt() {
  return (
    <>
      <svg
        aria-hidden="true"
        className="oa-git-graph"
        viewBox="0 0 108 54"
        style={{ left: 10, top: 12, width: 108, height: 54 }}
      >
        <path d="M4 42H104" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <path d="M38 42C52 42 50 14 64 14H100" stroke="var(--accent)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        {[14, 38, 80].map((cx) => (
          <circle key={cx} cx={cx} cy="42" r="3.4" fill="var(--oa-surface)" stroke="currentColor" strokeWidth="1.5" />
        ))}
        <circle cx="68" cy="14" r="3.4" fill="var(--oa-surface)" stroke="var(--accent)" strokeWidth="1.5" />
        <circle className="oa-anim-pulse" cx="94" cy="14" r="5.5" fill="var(--surface-list-selection)" />
        <circle cx="94" cy="14" r="3.4" fill="var(--accent)" />
      </svg>
      <ArtWindow className="oa-stack" style={{ left: 126, top: 10, width: 168, padding: 7, gap: 6 }}>
        <span className="oa-git-branch">
          <ArtIcon icon={GitBranch} />
          feature/art
        </span>
        <div className="oa-git-commit oa-anim-pop" data-head="" style={{ animationDelay: "0.4s" }}>
          <i className="oa-git-dot" />
          <Bar width="52%" />
          <span className="oa-git-hash">a1f3c9</span>
        </div>
        <div className="oa-git-commit">
          <i className="oa-git-dot" />
          <Bar width="64%" tone="soft" />
          <span className="oa-git-hash">7be210</span>
        </div>
        <div className="oa-row" style={{ gap: 5, marginTop: 1 }}>
          <ArtButton variant="ghost" icon={Upload}>
            Push
          </ArtButton>
          <ArtButton variant="primary" icon={GitPullRequest} className="oa-anim-press" style={{ animationDelay: "0.4s" }}>
            Open PR
          </ArtButton>
        </div>
      </ArtWindow>
    </>
  );
}


export function ComputerUseArt() {
  return (
    <>
      <ArtWindow className="oa-cu-window" style={{ left: 10, top: 10, width: 200, height: 250 }}>
        <div className="oa-cu-toolbar oa-separator-bottom">
          <TrafficLights />
          <Bar width={34} tone="ink" style={{ marginLeft: 6 }} />
          <span className="oa-grow" />
          <span className="oa-cu-tool" />
          <span className="oa-cu-export">
            <ArtIcon icon={Upload} />
            Export
          </span>
        </div>
        <div className="oa-cu-body">
          <div className="oa-cu-sidebar">
            <span className="oa-cu-thumb oa-selected" />
            <span className="oa-cu-thumb" />
            <span className="oa-cu-thumb" />
            <span className="oa-cu-thumb" />
          </div>
          <div className="oa-cu-canvas">
            <div className="oa-cu-slide">
              <Bar width="62%" tone="ink" />
              <Bar width="44%" />
              <Bar width="52%" tone="soft" />
            </div>
            <div className="oa-cu-notes">
              <Bar width="86%" tone="soft" />
              <Bar width="64%" tone="soft" />
              <Bar width="78%" tone="soft" />
              <Bar width="40%" tone="soft" />
            </div>
          </div>
        </div>
      </ArtWindow>
      <span className="oa-cu-pointer oa-anim-float" style={{ left: 156, top: 26 }}>
        <MousePointer2 aria-hidden="true" />
      </span>
      <ArtWindow raised className="oa-cu-approval" style={{ left: 8, top: 112, width: 176 }}>
        <div className="oa-row" style={{ gap: 5, alignItems: "flex-start" }}>
          <span className="oa-cu-shield">
            <ArtIcon icon={ShieldQuestion} />
          </span>
          <span className="oa-stack" style={{ gap: 3, flex: 1, paddingTop: 1 }}>
            <span className="oa-strong">Computer Use needs approval</span>
            <Bar width="80%" tone="soft" />
          </span>
        </div>
        <div className="oa-cu-summary oa-mono">click element “Export”</div>
        <div className="oa-row" style={{ justifyContent: "flex-end", gap: 5 }}>
          <ArtButton variant="ghost">Deny</ArtButton>
          <ArtButton variant="primary" className="oa-anim-press" style={{ animationDelay: "0.6s" }}>
            Allow once
          </ArtButton>
        </div>
      </ArtWindow>
    </>
  );
}

export function NativeSubagentsArt() {
  return (
    <ArtWindow className="oa-sub-window" style={{ left: 10, top: 10, width: 200, height: 250 }}>
      <div className="oa-sub-heading">Active · 2</div>
      <div className="oa-sub-row oa-selected">
        <span className="oa-sub-twisty">
          <ArtIcon icon={ChevronDown} />
        </span>
        <AidenActivityMark mark="quad-shuffle" size={10} className="oa-sub-mark" />
        <span className="oa-sub-text">
          <Bar width="70%" tone="ink" />
          <span>Implementer</span>
        </span>
        <span className="oa-sub-state">Working</span>
      </div>
      <div className="oa-sub-row" data-level="2" data-dim="">
        <span className="oa-sub-twisty" />
        <AidenActivityMark mark="bounce" size={10} active={false} className="oa-sub-mark" />
        <span className="oa-sub-text">
          <Bar width="58%" tone="ink" />
          <span>Scout</span>
        </span>
        <span className="oa-sub-state">Queued</span>
      </div>
      <div className="oa-sub-heading">Done · 3</div>
      <div className="oa-sub-row">
        <span className="oa-sub-twisty" />
        <span className="oa-sub-done">
          <ArtIcon icon={Check} />
        </span>
        <span className="oa-sub-text">
          <Bar width="64%" tone="ink" />
          <span>Reviewer</span>
        </span>
        <span className="oa-sub-state">Finished</span>
      </div>
      <div className="oa-sub-row">
        <span className="oa-sub-twisty" />
        <span className="oa-sub-done">
          <ArtIcon icon={Check} />
        </span>
        <span className="oa-sub-text">
          <Bar width="52%" tone="ink" />
          <span>Planner</span>
        </span>
        <span className="oa-sub-state">Finished</span>
      </div>
      <div className="oa-sub-row">
        <span className="oa-sub-twisty" />
        <span className="oa-sub-done">
          <ArtIcon icon={Check} />
        </span>
        <span className="oa-sub-text">
          <Bar width="46%" tone="ink" />
          <span>Scout</span>
        </span>
        <span className="oa-sub-state">Finished</span>
      </div>
    </ArtWindow>
  );
}

export function BrowserArt() {
  return (
    <ArtWindow className="oa-br-window" style={{ left: 10, top: 10, width: 181, height: 250 }}>
      <div className="oa-br-tabs">
        <span className="oa-br-tab oa-selected">
          <ArtIcon icon={Globe} />
          <Bar width={30} tone="ink" />
          <ArtIcon icon={X} />
        </span>
        <span className="oa-br-tab">
          <ArtIcon icon={Globe} />
          <Bar width={24} tone="soft" />
        </span>
        <ArtIcon icon={Plus} />
      </div>
      <div className="oa-br-chrome oa-separator-bottom">
        <ArtIcon icon={ArrowLeft} />
        <ArtIcon icon={ArrowRight} />
        <ArtIcon icon={RotateCw} />
        <span className="oa-br-address">
          <span className="oa-mono">example.com/pricing</span>
        </span>
        <span className="oa-br-annotate">
          <ArtIcon icon={MessageCirclePlus} />
        </span>
      </div>
      <div className="oa-br-page">
        <Bar width="46%" tone="ink" style={{ height: 6 }} />
        <Bar width="72%" tone="soft" />
        <div className="oa-br-cards">
          <div className="oa-br-card">
            <Bar width="60%" />
            <Bar width="80%" tone="soft" />
            <Bar width="50%" tone="soft" />
          </div>
          <div className="oa-br-card" data-selected="">
            <span className="oa-br-number">1</span>
            <Bar width="60%" />
            <Bar width="80%" tone="soft" />
            <Bar width="50%" tone="soft" />
          </div>
        </div>
        <Bar width="84%" tone="soft" />
        <Bar width="66%" tone="soft" />
        <Bar width="76%" tone="soft" />
        <div className="oa-br-cards">
          <div className="oa-br-card" data-short="">
            <Bar width="54%" />
            <Bar width="76%" tone="soft" />
          </div>
          <div className="oa-br-card" data-short="">
            <Bar width="48%" />
            <Bar width="70%" tone="soft" />
          </div>
        </div>
      </div>
      <ArtButton
        variant="primary"
        icon={MessageCirclePlus}
        className="oa-br-add oa-anim-pop"
        style={{ left: 104, top: 124, animationDelay: "0.5s" }}
      >
        Add to chat
      </ArtButton>
    </ArtWindow>
  );
}

const CODE_LINES: readonly (readonly [string, number][])[] = [
  [["keyword", 16], ["variable", 22], ["string", 34]],
  [["keyword", 16], ["variable", 18], ["string", 40]],
  [],
  [["keyword", 22], ["title", 30], ["variable", 14]],
  [["comment", 46]],
  [["keyword", 14], ["variable", 20], ["number", 8]],
  [["variable", 26], ["string", 24]],
  [["keyword", 18], ["variable", 30]],
  [],
  [["keyword", 22], ["title", 26]],
  [["variable", 18], ["number", 10], ["string", 20]],
  [["comment", 38]],
  [["keyword", 14], ["variable", 28]],
  [["variable", 22], ["string", 30]],
  [["keyword", 16], ["title", 24]],
  [],
  [["keyword", 20], ["variable", 24], ["string", 22]],
  [["variable", 30], ["number", 8]],
  [["comment", 42]],
  [["keyword", 14], ["title", 28]],
];
const INDENTS = [0, 0, 0, 0, 7, 7, 7, 14, 0, 7, 14, 14, 7, 14, 0, 0, 0, 7, 7, 0];

export function FilesEditorArt() {
  return (
    <ArtWindow className="oa-files-window" style={{ left: 6, top: 10, width: 182, height: 250 }}>
      <div className="oa-files-tree">
        <div className="oa-files-search">
          <ArtIcon icon={Search} />
          <Bar width="56%" tone="soft" />
        </div>
        <div className="oa-files-row">
          <ArtIcon icon={ChevronDown} />
          <ArtIcon icon={FolderOpen} />
          <Bar width={20} />
        </div>
        <div className="oa-files-row" data-depth="1">
          <ArtIcon icon={ChevronRight} />
          <ArtIcon icon={Folder} />
          <Bar width={18} tone="soft" />
        </div>
        <div className="oa-files-row oa-selected" data-depth="1">
          <ArtIcon icon={File} />
          <span className="oa-files-name">app.tsx</span>
        </div>
        <div className="oa-files-row" data-depth="1">
          <span className="oa-files-spacer" />
          <ArtIcon icon={File} />
          <Bar width={16} tone="soft" />
        </div>
        <div className="oa-files-row">
          <ArtIcon icon={ChevronRight} />
          <ArtIcon icon={Folder} />
          <Bar width={14} tone="soft" />
        </div>
        <div className="oa-files-row">
          <span className="oa-files-spacer" />
          <ArtIcon icon={File} />
          <Bar width={22} tone="soft" />
        </div>
      </div>
      <div className="oa-files-editor oa-separator-left">
        <div className="oa-files-head oa-separator-bottom">
          <ArtIcon icon={FileCode2} />
          <span className="oa-mono oa-strong">app.tsx</span>
          <span className="oa-grow" />
          <span className="oa-files-status">Edited</span>
          <ArtButton variant="ghost" icon={Save}>
            Save
          </ArtButton>
        </div>
        <div className="oa-files-code">
          {CODE_LINES.map((tokens, index) => (
            <div key={index} className="oa-files-line">
              <span className="oa-files-number">{index + 1}</span>
              <span className="oa-row" style={{ gap: 3, paddingLeft: INDENTS[index] }}>
                {tokens.map(([kind, width], token) => (
                  <i key={token} className="oa-files-token" style={{ width, background: `var(--syntax-${kind})` }} />
                ))}
                {index === 6 ? <span className="oa-caret" /> : null}
              </span>
            </div>
          ))}
        </div>
      </div>
    </ArtWindow>
  );
}

export function WorkspacesArt() {
  return (
    <>
    <div className="oa-stack" style={{ position: "absolute", left: 12, top: 12, gap: 5, justifyItems: "start" }}>
      <ArtChip icon={GitBranch}>Isolated worktree</ArtChip>
      <ArtChip icon={Folder}>Scratch space</ArtChip>
    </div>
    <ArtWindow className="oa-wsp-window" style={{ left: 128, top: 8, width: 172, height: 130 }}>
      <div className="oa-wsp-heading">Workspaces</div>
      <div className="oa-wsp-row">
        <ArtIcon icon={ChevronDown} />
        <ArtIcon icon={FolderGit2} />
        <span className="oa-strong">aiden-macos</span>
      </div>
      <div className="oa-wsp-chat oa-selected">
        <Bar width="62%" tone="ink" />
      </div>
      <div className="oa-wsp-chat">
        <Bar width="48%" tone="soft" />
      </div>
      <div className="oa-wsp-row oa-anim-pop" data-two-line="" style={{ animationDelay: "0.4s" }}>
        <ArtIcon icon={ChevronRight} />
        <ArtIcon icon={FolderGit2} />
        <span className="oa-stack" style={{ gap: 2 }}>
          <span className="oa-strong">aiden-macos</span>
          <span className="oa-wsp-branch">
            <ArtIcon icon={GitBranch} />
            <span className="oa-mono">feature/art</span>
          </span>
        </span>
      </div>
      <div className="oa-wsp-row" data-two-line="">
        <ArtIcon icon={ChevronRight} />
        <ArtIcon icon={FolderGit2} />
        <span className="oa-stack" style={{ gap: 2 }}>
          <span className="oa-strong">calm-moon-sail</span>
          <span className="oa-wsp-branch oa-mono">~/aiden</span>
        </span>
      </div>
    </ArtWindow>
    </>
  );
}
