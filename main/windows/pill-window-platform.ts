export function shouldPositionDictationPill(
  platform: NodeJS.Platform = process.platform,
  sessionType: string | undefined = process.env.XDG_SESSION_TYPE,
): boolean {
  return !(platform === "linux" && sessionType?.toLocaleLowerCase("en-US") === "wayland");
}
