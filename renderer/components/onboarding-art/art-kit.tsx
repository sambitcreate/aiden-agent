import * as React from "react";
import { ArrowUp, Mic, Plus, ShieldQuestion, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/ui-utils";
import type { KeyboardPlatform } from "../../shared/keybindings";

/**
 * Building blocks for the onboarding feature-tour art. Each vignette is a
 * stylized, cropped slice of a real Aiden surface: body text becomes `Bar`s and
 * only the words that carry meaning stay real. Styling lives in
 * `onboarding-art.css`; place parts with inline `left`/`top`/`width` styles.
 */

/** What a vignette may need to know about the machine it is shown on. */
export interface ArtProps {
  platform: KeyboardPlatform;
}

interface BoxProps {
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * A window or panel, absolutely placed and cropped by the tile. `raised` is for a
 * popover or card floating above another window: plain popover surface and
 * popover elevation instead of the tile's tinted surface.
 */
export function ArtWindow({ raised = false, className, style, children }: BoxProps & { raised?: boolean }) {
  return (
    <div className={cn("oa-window", className)} data-raised={raised || undefined} style={style}>
      {children}
    </div>
  );
}

/** A skeleton stand-in for a line of text. */
export function Bar({
  width,
  tone,
  className,
  style,
}: {
  width: number | string;
  tone?: "soft" | "ink";
  className?: string;
  style?: React.CSSProperties;
}) {
  return <i className={cn("oa-bar", className)} data-tone={tone} style={{ width, ...style }} />;
}

export function ArtIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon aria-hidden="true" className={cn("oa-icon", className)} strokeWidth={2} />;
}

export function ArtChip({
  icon,
  className,
  style,
  children,
}: BoxProps & { icon?: LucideIcon }) {
  return (
    <span className={cn("oa-chip", className)} style={style}>
      {icon ? <ArtIcon icon={icon} /> : null}
      {children}
    </span>
  );
}

export function ArtButton({
  variant,
  icon,
  className,
  style,
  children,
}: BoxProps & { variant: "primary" | "ghost"; icon?: LucideIcon }) {
  return (
    <span className={cn("oa-button", className)} data-variant={variant} style={style}>
      {icon ? <ArtIcon icon={icon} /> : null}
      {children}
    </span>
  );
}

export function TrafficLights({ className, style }: Pick<BoxProps, "className" | "style">) {
  return (
    <span className={cn("oa-lights", className)} style={style}>
      <i />
      <i />
      <i />
    </span>
  );
}

export function Radio({ checked = false }: { checked?: boolean }) {
  return <span className="oa-radio" data-checked={checked} />;
}

export function Toggle({ on = false }: { on?: boolean }) {
  return <span className="oa-toggle" data-on={on} />;
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <span className="oa-add">+{added}</span>
      <span className="oa-del">−{removed}</span>
    </>
  );
}

/** The chat composer, as it rests at the bottom of a workspace chat. */
export function ArtComposer({
  className,
  style,
  placeholder = "Let’s work on",
  permission = "Ask first",
  children,
}: BoxProps & { placeholder?: string; permission?: string }) {
  return (
    <div className={cn("oa-composer", className)} style={style}>
      <div className="oa-composer-text">
        {children ?? placeholder}
        <span className="oa-caret" />
      </div>
      <div className="oa-composer-bar">
        <ArtIcon icon={Plus} />
        <ArtChip icon={ShieldQuestion}>{permission}</ArtChip>
        <span className="oa-grow" />
        <ArtIcon icon={Mic} />
        <span className="oa-send">
          <ArtIcon icon={ArrowUp} />
        </span>
      </div>
    </div>
  );
}
