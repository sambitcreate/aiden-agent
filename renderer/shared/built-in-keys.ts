// Keys that work everywhere and can't be changed in Settings: they don't use a
// modifier, or only act in one place (an approval card, Find in chat). The
// ⌘/ list and Settings → Keyboard shortcuts both show them from here; keep
// docs/keyboard.md in step.

export type BuiltInKeySection = "Moving around" | "In a chat";

export interface BuiltInKey {
  id: string;
  title: string;
  description: string;
  /** Accelerator strings, shown with `prettyAccelerator` in order (alternatives or a pair). */
  keys: readonly string[];
  /** Another way to do the same, shown after "or". */
  alsoKeys?: readonly string[];
  section: BuiltInKeySection;
}

export const BUILT_IN_KEYS: readonly BuiltInKey[] = [
  {
    id: "areas",
    title: "Next / previous area",
    description: "Sidebar, conversation, message box and side panel.",
    keys: ["F6", "Shift+F6"],
    section: "Moving around",
  },
  {
    id: "rows",
    title: "Move through the sidebar",
    description: "Chats or Bots; Home and End jump to the first and last.",
    keys: ["Up", "Down"],
    section: "Moving around",
  },
  {
    id: "folders",
    title: "Close / open a project folder",
    description: "In the sidebar; ← on a chat goes to its folder.",
    keys: ["Left", "Right"],
    section: "Moving around",
  },
  {
    id: "row-menu",
    title: "Open a row's or message's menu",
    description: "The same menu as a right-click. The Menu key works too.",
    keys: ["Shift+F10"],
    section: "Moving around",
  },
  {
    id: "dismiss",
    title: "Close a menu, dialog or Find",
    description: "Focus goes back to where it was. In the message box, Esc stops the reply.",
    keys: ["Escape"],
    section: "Moving around",
  },
  {
    id: "send",
    title: "Send / new line",
    description: "In the message box.",
    keys: ["Return", "Shift+Return"],
    section: "In a chat",
  },
  {
    id: "slash",
    title: "Slash commands",
    description: "Type / at the start of the message box.",
    keys: ["/"],
    section: "In a chat",
  },
  {
    id: "edit-last",
    title: "Fix and resend your last message",
    description: "In an empty message box, once it has a finished reply.",
    keys: ["Up"],
    section: "In a chat",
  },
  {
    id: "replies",
    title: "Previous / next reply",
    description: "From the conversation or an empty message box.",
    keys: ["Alt+Up", "Alt+Down"],
    section: "In a chat",
  },
  {
    id: "find-step",
    title: "Next / previous match",
    description: "While Find in chat is open.",
    keys: ["Return", "Shift+Return"],
    alsoKeys: ["Command+G", "Command+Shift+G"],
    section: "In a chat",
  },
  {
    id: "allow",
    title: "Allow once",
    description: "While an approval is waiting and the message box is empty.",
    keys: ["Command+Return"],
    section: "In a chat",
  },
  {
    id: "deny",
    title: "Deny",
    description: "Turn down the waiting approval, under the same conditions as Allow once.",
    keys: ["Command+Backspace"],
    section: "In a chat",
  },
];
