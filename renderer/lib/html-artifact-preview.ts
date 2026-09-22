export function htmlArtifactThemeTokensFromDocument(): {
  colorScheme: "light" | "dark";
  canvas: string;
  foreground: string;
  secondary: string;
  accent: string;
} {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const hex = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback;
  };
  return {
    colorScheme: root.classList.contains("dark") ? "dark" : "light",
    canvas: hex("--surface-popover", "#f6f7f9"),
    foreground: hex("--text-primary", "#3d3f41"),
    secondary: hex("--text-secondary", "#6b6b68"),
    accent: hex("--accent", "#006ad6"),
  };
}
