import { useEffect, useState, type ComponentType } from "react";

type RouteModule = { default: ComponentType<{ params: Record<string, string> }> };

// No router package: TanStack's flat-file rule over src/routes. `index` is
// the folder's own page, `.` separates segments and `$name` is a parameter.
// The glob picks up a file added while the app runs, through HMR.
const modules = import.meta.glob<RouteModule>("./routes/*.tsx", { eager: true });

const routes = Object.entries(modules).map(([file, module]) => {
  const name = file.slice("./routes/".length, -".tsx".length);
  const segments = name === "index" ? [] : name.split(".").filter((segment) => segment !== "index");
  return { segments, Page: module.default };
});

function match(pathname: string): { Page: RouteModule["default"]; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    route.segments.forEach((segment, at) => {
      if (segment.startsWith("$")) params[segment.slice(1)] = decodeURIComponent(parts[at]!);
      else if (segment !== parts[at]) matched = false;
    });
    if (matched) return { Page: route.Page, params };
  }
  return null;
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const found = match(path);
  if (!found) return <h1 id="not-found">Not found</h1>;
  return <found.Page params={found.params} />;
}
