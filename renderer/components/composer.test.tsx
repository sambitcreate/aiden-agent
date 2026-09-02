import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("composer focus tints the whole shell, not only the textarea", () => {
  const composer = source("./composer.tsx");
  const styles = source("../styles.css");
  assert.match(composer, /composer-shell/u);
  assert.match(
    composer,
    /className="max-h-48 border-0 bg-transparent px-1\.5 outline-none hover:border-transparent focus:border-transparent focus:bg-transparent"/u,
  );
  assert.match(
    styles,
    /\.composer-shell:focus-within\s*\{[\s\S]*color-mix\(in srgb, var\(--surface-popover\) 98%, var\(--text-primary\)\)/u,
  );
  assert.match(
    styles,
    /:root :where\(input, textarea, \[contenteditable="true"\]\):focus,\s*:root :where\(input, textarea, \[contenteditable="true"\]\):focus-visible\s*\{\s*outline: none !important;\s*\}/u,
  );
});

test("composer context controls stay compact without exposing provider copy", () => {
  const composer = source("./composer.tsx");
  const modelPicker = source("./model-picker.tsx");

  assert.match(composer, /group\/access relative h-8 w-34/u);
  assert.match(composer, /role="radiogroup"\s*aria-label="Workspace access"/u);
  assert.match(composer, /absolute bottom-full left-0/u);
  assert.match(composer, /group-hover\/access:visible/u);
  assert.match(composer, /group-focus-within\/access:visible/u);
  assert.match(composer, /group-data-\[open=true\]\/access:visible/u);
  assert.match(composer, /bg-control\/80/u);
  assert.match(composer, /selected\s*\? "bg-popover shadow-control"/u);
  assert.doesNotMatch(composer, /group-hover\/access:max-h/u);
  assert.match(composer, /aria-disabled=\{disabled \|\| undefined\}/u);
  assert.doesNotMatch(composer, /group\/access[^\n]*disabled:opacity-45/u);
  assert.doesNotMatch(composer, /DropdownMenuCheckboxItem/u);
  assert.doesNotMatch(composer, /<DropdownMenuLabel>Workspace access/u);
  assert.match(modelPicker, /\? selected\.label\s*: hasUnavailableSelection/u);
  assert.match(modelPicker, /`Selected model: \$\{selected\.label\}\. Choose a model\.`/u);
  assert.doesNotMatch(modelPicker, /ChevronsUpDown/u);
  assert.doesNotMatch(modelPicker, /Selected model: \$\{selected\.label\} from/u);
  assert.doesNotMatch(modelPicker, /\$\{selected\.label\} · \$\{selected\.providerLabel\}/u);
});

test("Design placement moves the same composer into the conversation rail without workspace chrome", () => {
  const composer = source("./composer.tsx");
  const pane = source("../main/chat-pane.tsx");

  assert.match(composer, /placement\?: "chat" \| "design-conversation"/u);
  assert.match(composer, /placement = "chat"/u);
  assert.match(
    composer,
    /placement === "design-conversation"\s*\? "w-full px-3 pb-3 pt-2"\s*: "aiden-dock-inset chat-content-column pb-4 pt-3 sm:pb-5"/u,
  );
  assert.match(composer, /\{placement === "chat" \? \([\s\S]*<WorkspacePicker/u);
  assert.match(composer, /<Monitor[\s\S]{0,180}Local/u);
  assert.match(
    composer,
    /placement === "chat" \? \(\s*<div\s*className="composer-permission-control/u,
  );
  assert.match(
    composer,
    /voice\.recording \|\| voice\.transcribing \|\| attaching \|\| sending \|\| sessionCommandBusy/u,
  );
  assert.match(composer, /onVisibilityRequirementChange\?\.\(requiresVisibleComposer\)/u);
  assert.match(composer, /placement === "design-conversation" && "max-h-16 overflow-y-auto"/u);
  assert.match(composer, /placement === "design-conversation" && "max-h-20 overflow-y-auto"/u);

  assert.match(pane, /function ComposerPlacement\([\s\S]*createPortal\(children, host\)/u);
  assert.match(
    pane,
    /<ComposerPlacement design=\{presentation === "design"\} host=\{designComposerHost\}>/u,
  );
  assert.match(pane, /placement=\{presentation === "design" \? "design-conversation" : "chat"\}/u);
  assert.match(
    pane,
    /onVisibilityRequirementChange=\{\s*presentation === "design" \? setDesignComposerRequiresVisibility : undefined\s*\}/u,
  );
  assert.match(pane, /ref=\{setDesignComposerHost\}[\s\S]{0,180}Design prompt composer/u);
  assert.match(
    pane,
    /presentation === "design" \? \(\s*<div className="relative flex h-full[\s\S]*ref=\{setDesignComposerHost\}[\s\S]*chat\.isLoading \|\| providers\.isLoading[\s\S]*<DesignWorkspaceCanvas/u,
  );
  assert.match(
    pane,
    /aria-hidden=\{!designConversationOpen \|\| undefined\}[\s\S]{0,120}inert=\{!designConversationOpen \? true : undefined\}/u,
  );
});

test("composer routes Finder drops and raster paste through the fixed preload bridge", () => {
  const composer = source("./composer.tsx");
  const preload = source("../preload-attachments.ts");
  const ipc = source("../lib/ipc.ts");

  assert.match(composer, /onDragOver=\{handleDragOver\}/u);
  assert.match(composer, /onDrop=\{handleDrop\}/u);
  assert.match(composer, /onPaste=\{handlePaste\}/u);
  assert.match(composer, /attachmentOperationRef\.current \|\| attaching/u);
  assert.match(composer, /Wait for the current attachments to finish loading/u);
  assert.match(composer, /plannedBytes \+ file\.size > remainingInlineBytes/u);
  assert.match(ipc, /window\.aidenAPI\.attachments\.readDroppedFiles/u);
  assert.match(ipc, /window\.aidenAPI\.attachments\.readClipboardImages/u);
  assert.match(preload, /getPathForFile\(file: File\): string/u);
  assert.doesNotMatch(preload, /file\.path/u);
});

test("chat surfaces share the responsive centered chat-column contract", () => {
  const composer = source("./composer.tsx");
  const messages = source("./message-list.tsx");
  const chatPane = source("../main/chat-pane.tsx");
  const styles = source("../styles.css");

  for (const surface of [composer, messages, chatPane]) {
    assert.match(surface, /aiden-dock-inset chat-content-column/u);
    assert.doesNotMatch(surface, /max-w-3xl/u);
  }

  assert.match(styles, /--chat-content-max-width:\s*52rem;/u);
  assert.match(
    styles,
    /\.chat-content-column\s*\{[\s\S]*width:\s*100%;[\s\S]*max-width:\s*var\(--chat-content-max-width\);[\s\S]*margin-inline:\s*auto;/u,
  );
  assert.match(
    styles,
    /\.aiden-dock-inset\s*\{\s*padding-inline:\s*var\(--aiden-dock-gutter\);\s*\}/u,
  );
});

test("composer slash palette is an overlaid textarea-owned accessible listbox", () => {
  const composer = source("./composer.tsx");
  const palette = source("./composer-slash-palette.tsx");
  const styles = source("../styles.css");

  assert.match(composer, /aria-autocomplete=\{slashSession \? "list" : undefined\}/u);
  assert.match(
    composer,
    /aria-activedescendant=\{\s*slashSession \? effectiveActiveSlashId : undefined\s*\}/u,
  );
  assert.doesNotMatch(composer, /aria-expanded=/u);
  assert.match(composer, /if \(slashPaletteBlocked\) dismissSlash\(\)/u);
  assert.match(composer, /event\.key === "Escape"/u);
  assert.match(composer, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/u);
  assert.match(composer, /event\.key === "PageDown"/u);
  assert.match(composer, /event\.key === "Home"/u);
  assert.match(palette, /role="listbox"/u);
  assert.doesNotMatch(palette, /role="group"/u);
  assert.match(palette, /role="option"/u);
  assert.match(palette, /aria-live="polite"/u);
  assert.match(palette, /absolute inset-x-3 bottom-full/u);
  assert.match(palette, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(palette, /motion-reduce:animate-none/u);
  assert.match(palette, /max-\[520px\]:hidden/u);
  assert.match(palette, /flex min-h-10/u);
  assert.match(palette, /selected && available && "bg-control"/u);
  assert.match(palette, /result\.command\.title/u);
  assert.doesNotMatch(palette, /`\/\$\{result\.command\.name\}`/u);
  assert.doesNotMatch(palette, /`\/\$\{alias\}`/u);
  assert.match(palette, /const detail = unavailableReason \?\? description/u);
  assert.match(palette, /rounded-dialog border border-separator/u);
  assert.doesNotMatch(palette, /block truncate text-small text-secondary/u);
  assert.doesNotMatch(palette, /selected && available && "bg-list-selection"/u);
  assert.doesNotMatch(palette, /Commands and skills/u);
  assert.doesNotMatch(palette, /composer-slash-shortcuts/u);
  assert.doesNotMatch(palette, /rounded-md bg-control\/65 text-secondary/u);
  assert.doesNotMatch(palette, />Commands</u);
  assert.doesNotMatch(palette, />Skills</u);
  assert.match(palette, /mode === "command" \? "Slash commands" : "Skills"/u);
  assert.match(composer, /mode=\{slashSession\.kind\}/u);
  assert.match(composer, /result\.kind !== slashSession\.kind/u);
  assert.match(composer, /slashSession\?\.kind === "skill" && skillCatalog\.isError/u);
  assert.match(
    composer,
    /setAttaching\(false\);\s*requestAnimationFrame\(\(\) => inputRef\?\.current\?\.focus/u,
  );
  assert.match(palette, /data-presence=\{presenceState\}/u);
  assert.match(styles, /@keyframes aiden-slash-palette-in/u);
  assert.match(styles, /@keyframes aiden-slash-palette-out/u);
  assert.match(styles, /aiden-slash-palette-out 100ms ease-in/u);
  const attemptIndex = composer.indexOf("const attempted = attemptSlashCommandAction");
  const completionIndex = composer.indexOf(
    "const attempt = asyncAction ? await attempted.completion : attempted",
  );
  const handledIndex = composer.indexOf("if (!attempt.handled)");
  const commitIndex = composer.lastIndexOf("setText(nextText)");
  for (const index of [attemptIndex, completionIndex, handledIndex, commitIndex]) {
    assert.notEqual(index, -1, "The slash action commit contract must remain present.");
  }
  assert.ok(
    attemptIndex < completionIndex && completionIndex < handledIndex && handledIndex < commitIndex,
    "The draft token must only be consumed after successful sync or async action completion.",
  );
  assert.match(composer, /const attempt = asyncAction \? await attempted\.completion : attempted/u);
  assert.match(
    composer,
    /asyncAction &&[\s\S]{0,500}slashActionDraftCommitIsCurrent\(expectedCommit[\s\S]{0,500}slashActionCommitIsCurrent\(expectedCommit/u,
  );
  assert.match(composer, /React\.useLayoutEffect\(\(\) => \{[\s\S]*slashPaletteBlockedRef/u);
  assert.match(composer, /slashTabAcceptsSelection\([\s\S]*slashActionPendingRef\.current/u);
  assert.match(composer, /skillSelectionEnabled/u);
  assert.match(composer, /Remove \$\{selectedSkill\.invocation\.displayName\} skill from message/u);
  const optimisticClear = composer.indexOf('setText("");');
  const sendAwait = composer.indexOf("await onSend(");
  assert.ok(optimisticClear >= 0 && optimisticClear < sendAwait);
  assert.match(composer, /if \(sendPendingRef\.current\) return false;/u);
  assert.match(composer, /type: "send-started"/u);
  assert.match(composer, /failedSendDraft\(payload\.draftText, currentDraft\)/u);
  assert.match(composer, /failedSendAttachments\([\s\S]{0,160}payload\.attachments/u);
  assert.match(composer, /!isAppendReconciliationRequired\(error\)/u);
  assert.match(
    composer,
    /if \(result\.command\.action\.kind === "composer-instruction"\) return;/u,
  );
});

test("selected session slash commands dispatch through explicit Aiden-owned workflows", () => {
  const composer = source("./composer.tsx");
  const branchPicker = source("./git-branch-picker.tsx");
  const chatPane = source("../main/chat-pane.tsx");
  const ipc = source("../lib/ipc.ts");
  const mainHandlers = source("../../main/handlers/chats.ts");
  const platform = source("../../main/platform.ts");

  assert.match(composer, /title="Fork from a completed turn"/u);
  assert.match(
    composer,
    /Private reasoning, tool state, and subagent runtime records are omitted/u,
  );
  assert.match(composer, /title="Session details"/u);
  assert.match(composer, /Stored Aiden chat information/u);
  assert.match(composer, /title="Sign out of a provider"/u);
  assert.match(composer, /removes Aiden&apos;s encrypted \{logoutProvider\?\.label/u);
  assert.match(composer, /authenticatedProviders\.map\(\(provider\)/u);
  assert.match(composer, /openWorktreeOnMount=\{worktreeRequest > 0\}/u);
  assert.match(composer, /programmaticReturnFocusRef=\{inputRef\}/u);
  assert.match(composer, /readOnly=\{sessionCommandBusy\}/u);
  assert.match(composer, /role="status" aria-live="polite"/u);
  assert.match(branchPicker, /openManagedWorktree \? "worktree" : null/u);
  assert.match(chatPane, /chatsApi\.copyVisibleHistory\([\s\S]{0,100}throughAssistantMessageId/u);
  assert.match(chatPane, /logoutBuiltinProvider\(qc, providerId\)/u);
  assert.match(chatPane, /provider\.canLogout === true/u);
  assert.match(ipc, /"chats:export", \{ chatId \}/u);
  assert.doesNotMatch(ipc, /chats:export[\s\S]{0,120}(?:filePath|outputPath|targetPath)/u);
  assert.match(mainHandlers, /dialog\.showSaveDialog\(parent/u);
  assert.match(mainHandlers, /llmClient\.beginChatCopy\(parsed\.chatId\)/u);
  assert.match(mainHandlers, /llmClient\.beginChatExport\(chatId\)/u);
  assert.match(platform, /try \{[\s\S]{0,240}webContents\.send[\s\S]{0,240}catch \(error\)/u);
  assert.match(branchPicker, /openWorktreeOnMount[\s\S]{0,500}programmaticReturnFocusRef/u);
  assert.match(branchPicker, /programmaticOriginRef = React\.useRef\(openManagedWorktree\)/u);
  assert.match(branchPicker, /programmaticOriginRef\.current = false/u);
});

test("visualize preserves the slash draft when validation rejects the send", () => {
  const composer = source("./composer.tsx");
  assert.match(composer, /if \(!nextPrompt\) \{[\s\S]{0,180}return false;/u);
  assert.match(
    composer,
    /selectedSkillState && selectedSkillState\.state !== "valid"[\s\S]{0,180}return false;/u,
  );
  assert.match(
    composer,
    /return sendComposerPayload\(\{[\s\S]{0,260}draftText: text,[\s\S]{0,260}visualize: true/u,
  );
  assert.match(composer, /hasWorkspaceArtifactAccess: workspace\?\.permission !== "none"/u);
});

test("workspace picker closes and exposes a persistent reason when workspace changes are blocked", () => {
  const composer = source("./composer.tsx");
  const picker = source("./workspace-picker.tsx");
  assert.match(composer, /blockedReason=\{workspaceChangeBlockedReason\}/u);
  assert.match(composer, /key=\{workspaceChangeBlockedReason \? "blocked" : "available"\}/u);
  assert.match(composer, /Workspace unavailable: \$\{workspaceChangeBlockedReason\}/u);
  assert.match(picker, /open=\{blockedReason \? false : open\}/u);
  assert.match(picker, /aria-describedby/u);
  assert.match(picker, /className="sr-only" role="status"/u);
  assert.match(picker, /disabled=\{pending !== null \|\| Boolean\(blockedReason\)\}/u);
  assert.match(picker, /!pending && !blockedReason && setOpen\(nextOpen\)/u);
});

test("workspace access keyboard navigation moves focus without changing permission", () => {
  const composer = source("./composer.tsx");
  assert.match(
    composer,
    /event\.key === "Enter" \|\| event\.key === " "\) \{\s*event\.preventDefault\(\);\s*if \(value !== permission\) requestPermission\(value\);/u,
  );
  assert.match(composer, /radios\?\.\[nextIndex\]\?\.focus\(\)/u);
  assert.doesNotMatch(composer, /requestPermission\(nextPermission\)/u);
});
