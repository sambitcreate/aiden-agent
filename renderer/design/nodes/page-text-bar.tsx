// The bar above a page while the person edits words inside it: text style,
// bold, italic, underline, a link, a bulleted list, alignment, Comment and
// Done. Its buttons never take the focus, so the page keeps its selection;
// the page's bridge carries out each command.

import { NodeToolbar, Position } from "@xyflow/react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  ChevronDown,
  Italic,
  Link,
  List,
  MessageCircle,
  Underline,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui";
import type { DesignTextCommand } from "../../shared/design-canvas/bridge-messages";
import { linkFromInput } from "../../shared/design-canvas/rich-text";

const STYLES = [
  { value: "p", label: "Paragraph" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
] as const;

const ALIGNS: readonly { value: "left" | "center" | "right"; label: string; Icon: LucideIcon }[] = [
  { value: "left", label: "Align left", Icon: AlignLeft },
  { value: "center", label: "Align centre", Icon: AlignCenter },
  { value: "right", label: "Align right", Icon: AlignRight },
];

const MOD = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";

const keepFocus = (event: React.MouseEvent) => event.preventDefault();

export function PageTextBar({
  tag,
  onCommand,
  onDone,
  onComment,
}: {
  /** The edited element's tag, for the text style menu. */
  tag: string;
  onCommand(command: DesignTextCommand, value?: string): void;
  onDone(): void;
  onComment(): void;
}) {
  const [style, setStyle] = React.useState(tag);
  React.useEffect(() => setStyle(tag), [tag]);
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [link, setLink] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const shown = STYLES.find((entry) => entry.value === style)?.label ?? "Text";
  const mark = (label: string, key: string, command: DesignTextCommand, Icon: LucideIcon) => (
    <Button
      variant="transparent"
      iconOnly
      aria-label={label}
      title={key ? `${label} (${MOD}${key})` : label}
      onMouseDown={keepFocus}
      onClick={() => onCommand(command)}
    >
      <Icon />
    </Button>
  );
  return (
    <NodeToolbar isVisible position={Position.Top} align="start" offset={10} className="nodrag nopan nowheel">
      <div role="toolbar" aria-label="Page text formatting" className="flex items-center gap-0.5 rounded-button bg-popover p-1 shadow-control">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="transparent" size="small" aria-label={`Text style: ${shown}`} title="Text style" className="gap-0.5 px-1.5" onMouseDown={keepFocus}>
              {shown}
              <ChevronDown aria-hidden className="size-3 text-secondary" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
            <DropdownMenuRadioGroup
              value={style}
              onValueChange={(value) => {
                setStyle(value);
                onCommand("block", value);
              }}
            >
              {STYLES.map((entry) => (
                <DropdownMenuRadioItem key={entry.value} value={entry.value}>
                  {entry.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        {mark("Bold", "B", "bold", Bold)}
        {mark("Italic", "I", "italic", Italic)}
        {mark("Underline", "U", "underline", Underline)}
        <Popover
          open={linkOpen}
          onOpenChange={(open) => {
            setLinkOpen(open);
            if (open) {
              setLink("");
              setInvalid(false);
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="transparent" iconOnly aria-label="Link" title="Link" onMouseDown={keepFocus}>
              <Link />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2" aria-label="Link" onCloseAutoFocus={(event) => event.preventDefault()}>
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const href = linkFromInput(link);
                if (!href) {
                  setInvalid(true);
                  return;
                }
                onCommand("link", href);
                setLinkOpen(false);
              }}
            >
              <Input
                autoFocus
                aria-label="Link address"
                aria-invalid={invalid || undefined}
                placeholder="https://example.com"
                value={link}
                onChange={(event) => {
                  setLink(event.target.value);
                  setInvalid(false);
                }}
              />
              {invalid ? <p className="px-1 text-secondary">Use a web or email address.</p> : null}
              <div className="flex justify-end gap-1">
                <Button
                  type="button"
                  variant="transparent"
                  size="small"
                  onClick={() => {
                    onCommand("unlink");
                    setLinkOpen(false);
                  }}
                >
                  Remove link
                </Button>
                <Button type="submit" size="small">
                  Add link
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
        {mark("Bulleted list", "", "insertUnorderedList", List)}
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        {ALIGNS.map(({ value, label, Icon }) => (
          <Button key={value} variant="transparent" iconOnly aria-label={label} title={label} onMouseDown={keepFocus} onClick={() => onCommand("align", value)}>
            <Icon />
          </Button>
        ))}
        <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-separator" />
        <Button variant="transparent" iconOnly aria-label="Comment on this text" title="Comment" onMouseDown={keepFocus} onClick={onComment}>
          <MessageCircle />
        </Button>
        <Button variant="transparent" size="small" className="gap-1 px-1.5" title="Done (Return)" onMouseDown={keepFocus} onClick={onDone}>
          <Check aria-hidden />
          Done
        </Button>
      </div>
    </NodeToolbar>
  );
}
