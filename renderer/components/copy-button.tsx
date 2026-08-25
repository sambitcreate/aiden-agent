// Small copy-to-clipboard button with a transient "copied" checkmark.
// Used by code blocks and message hover actions.

import * as React from "react";
import { Check, CircleAlert, Copy } from "lucide-react";
import { cn } from "../lib/ui-utils";

// Keep server markup warning-free while using a synchronous committed effect in
// the browser, before a stale clipboard continuation can publish its result.
const useCommittedLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

interface CopyButtonProps {
  /** Text placed on the clipboard when clicked. */
  text: string;
  /** Optional accessible label (defaults to "Copy"). */
  label?: string;
  className?: string;
}

export function CopyButton({ text, label = "Copy", className }: CopyButtonProps) {
  const [status, setStatus] = React.useState<"idle" | "copied" | "error">("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(true);
  const requestVersionRef = React.useRef(0);
  const latestTextRef = React.useRef(text);

  const clearStatusTimer = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useCommittedLayoutEffect(() => {
    if (latestTextRef.current === text) return;
    latestTextRef.current = text;
    requestVersionRef.current += 1;
    clearStatusTimer();
    setStatus("idle");
  }, [clearStatusTimer, text]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
      clearStatusTimer();
    };
  }, [clearStatusTimer]);

  const onCopy = React.useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const requestedText = text;
    clearStatusTimer();
    setStatus("idle");
    try {
      await navigator.clipboard.writeText(requestedText);
      if (
        !mountedRef.current ||
        requestVersionRef.current !== requestVersion ||
        latestTextRef.current !== requestedText
      ) {
        return;
      }
      setStatus("copied");
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!mountedRef.current || requestVersionRef.current !== requestVersion) return;
        setStatus("idle");
      }, 1500);
    } catch {
      if (
        !mountedRef.current ||
        requestVersionRef.current !== requestVersion ||
        latestTextRef.current !== requestedText
      ) {
        return;
      }
      setStatus("error");
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!mountedRef.current || requestVersionRef.current !== requestVersion) return;
        setStatus("idle");
      }, 2500);
    }
  }, [clearStatusTimer, text]);

  const title =
    status === "copied" ? "Copied" : status === "error" ? "Copy failed — try again" : label;
  const announcement =
    status === "copied"
      ? "Copied to clipboard."
      : status === "error"
        ? "Copy failed. Try again."
        : "";

  return (
    <>
      <button
        type="button"
        onClick={onCopy}
        aria-label={label}
        title={title}
        data-copy-status={status}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-tertiary outline-none",
          "transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none",
          className,
        )}
      >
        {status === "copied" ? (
          <Check aria-hidden="true" className="size-3.5 text-green" />
        ) : status === "error" ? (
          <CircleAlert aria-hidden="true" className="size-3.5 text-red" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-copy-announcement={status}
      >
        {announcement}
      </span>
    </>
  );
}
