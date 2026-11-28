// The design app's home page: the design system's tokens from theme.css.
// Add a page by adding a file next to this one (settings.tsx is /settings).

const colors = ["background", "surface", "text", "muted", "border", "primary"];
const sizes = [
  { name: "Heading", size: 32, weight: 600 },
  { name: "Body", size: 16, weight: 400 },
  { name: "Small", size: 13, weight: 400 },
];

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--spacing-xl) var(--spacing-lg)" }}>
      <h1 style={{ fontSize: 32, fontWeight: 600, lineHeight: 1.2, margin: 0 }}>Design app</h1>
      <p style={{ color: "var(--color-muted)", marginTop: "var(--spacing-sm)" }}>
        Pages live in src/routes. Tokens come from DESIGN.md through src/theme.css.
      </p>
      <section aria-label="Colors" style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)", marginTop: "var(--spacing-xl)" }}>
        {colors.map((name) => (
          <figure key={name} style={{ margin: 0, width: 96 }}>
            <div
              style={{
                height: 64,
                borderRadius: "var(--rounded-md)",
                background: `var(--color-${name})`,
                boxShadow: "inset 0 0 0 1px var(--color-border)",
              }}
            />
            <figcaption style={{ fontSize: 13, marginTop: "var(--spacing-xs)" }}>{name}</figcaption>
          </figure>
        ))}
      </section>
      <section aria-label="Type scale" style={{ marginTop: "var(--spacing-xl)" }}>
        {sizes.map((step) => (
          <p key={step.name} style={{ fontSize: step.size, fontWeight: step.weight, margin: "var(--spacing-sm) 0" }}>
            {step.name} · {step.size}px
          </p>
        ))}
      </section>
    </main>
  );
}
