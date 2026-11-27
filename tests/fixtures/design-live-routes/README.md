# Design live routes fixture

A Vite + React 19 app for the Phase 3b routes E2E (`tests/e2e/design-live-routes.spec.ts`). Like `design-live-app`, it has no lockfile and no install: tests copy it to a temp folder and symlink `node_modules` to the repo root's.

`package.json` declares `@tanstack/router-plugin` without installing it, so design mode detects `tanstack-router` and lists routes with TanStack's flat-file rule over `src/routes/`. No router runs: `src/App.tsx` maps `location.pathname` onto `import.meta.glob("./routes/*.tsx")` with the same rule, so a route file written while the app runs is served through HMR.

- `src/routes/index.tsx` → `/`: "Routes home" and `<Banner />` (`src/components/Banner.tsx`, "Spring sale").
- `src/routes/pricing.tsx` → `/pricing`: `<h1>Pricing</h1>`.
- `src/routes/blog.$slug.tsx` → `/blog/[slug]`: the slug as its heading.
- `.aiden/canvas.json` fills `/blog/[slug]` with `hello-world`.
