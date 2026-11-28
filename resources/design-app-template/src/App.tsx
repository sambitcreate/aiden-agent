import { useEffect, useState, type ComponentType } from "react";
import { routePath } from "./aiden/route-path";

type RouteModule = { default: ComponentType };

// Each file in src/routes is a page, by TanStack's flat-file rule (route-path.ts).
// The glob picks up a new route file while the app runs, through HMR.
const modules = import.meta.glob<RouteModule>(["./routes/**/*.tsx", "./routes/**/*.jsx"], { eager: true });

// Keyed by the path as the browser spells it (`/with space` is `/with%20space`), so a page's URL finds it.
const urlPath = (route: string): string => new URL(route, "http://design-app.invalid").pathname;

const pages = new Map<string, RouteModule["default"]>();
for (const [file, module] of Object.entries(modules)) {
  const route = routePath(file.slice("./routes/".length));
  if (route !== null && !pages.has(urlPath(route))) pages.set(urlPath(route), module.default);
}

function pageFor(pathname: string): RouteModule["default"] | undefined {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  return pages.get(trimmed || "/");
}

export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    // Same-origin links navigate in place, so the canvas frame keeps its page.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target || link.origin !== location.origin) return;
      event.preventDefault();
      navigate(`${link.pathname}${link.search}`);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  const Page = pageFor(path);
  if (!Page) return <p className="not-found">No page at {path}</p>;
  return <Page />;
}
