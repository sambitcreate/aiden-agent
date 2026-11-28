# Design app

Aiden made this folder so you can design screens live on its canvas. It's a small Vite and React app: each file in `src/routes/` is a page (`settings.tsx` is `/settings`), `DESIGN.md` is its design system, and `src/theme.css` holds that design system's tokens as CSS variables. `aiden.mock.json` lists the folders of your own project it imports components from, and the stubs that stand in for desktop-only APIs.

Nothing outside this folder depends on it, so it's safe to delete. To run it yourself, run `npm ci` and then `npm run dev` here.
