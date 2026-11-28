type NavigatorWithUserAgentData = Navigator & {
  readonly userAgentData?: {
    readonly platform?: string;
  };
};

export function isMacPlatform(platform?: string): boolean {
  const browser =
    typeof navigator === "undefined" ? undefined : (navigator as NavigatorWithUserAgentData);
  const value = platform ?? (browser?.userAgentData?.platform?.trim() || browser?.userAgent || "");
  return /Mac|iOS|iPhone|iPad|iPod/iu.test(value);
}
