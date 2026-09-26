export function desktopVersionRequested(
  argv: readonly string[],
  defaultApp: boolean,
): boolean {
  // Packaged Electron starts user arguments after argv[0]. Development
  // Electron reserves argv[1] for the application path.
  return argv.slice(defaultApp ? 2 : 1).includes("--version");
}
