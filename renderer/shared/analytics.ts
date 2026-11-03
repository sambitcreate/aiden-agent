// Renderer-facing shapes for usage-data consent and the "What's sent" list.

export interface AnalyticsStatusView {
  readonly enabled: boolean;
  /** DO_NOT_TRACK or AIDEN_ANALYTICS=0 overrides the setting. */
  readonly envDisabled: boolean;
  /** This build can send usage data at all. */
  readonly hasKey: boolean;
  /** Nothing is sent until the person has seen the notice. */
  readonly noticePending: boolean;
}

export type AnalyticsNoticeChoice = "ok" | "turn-off";

export interface AnalyticsPropertyView {
  readonly name: string;
  readonly kind: "enum" | "boolean" | "integer" | "id" | "version";
  readonly values?: readonly string[];
  readonly optional: boolean;
}

export interface AnalyticsEventView {
  readonly name: string;
  readonly properties: readonly AnalyticsPropertyView[];
}

export interface AnalyticsRegistryView {
  readonly events: readonly AnalyticsEventView[];
  /** Fields on a crash or error report, next to its sanitized stack. */
  readonly exceptionProperties: readonly AnalyticsPropertyView[];
  /** Attached to every event. */
  readonly superProperties: readonly AnalyticsPropertyView[];
}
