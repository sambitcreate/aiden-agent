// Small copy-to-clipboard button with a transient "copied" checkmark.
// Used by code blocks and message hover actions.

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@glaze/core/utils";

interface CopyButtonProps {
  /** Text placed on the clipboard when clicked. */
  text: string;
  /** Optional accessible label (defaults to "Copy"). */
  label?: string;
  className?: string;
}

export function CopyButton({ text, label = "Copy", className }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can reject if the document isn't focused; ignore silently.
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-tertiary",
        "transition-colors hover:bg-control hover:text-secondary active:bg-control",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-green" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
