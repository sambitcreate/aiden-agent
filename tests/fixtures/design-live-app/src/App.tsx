import { useEffect, useState } from "react";
import { Home } from "./Home";
import { Login } from "./Login";
import { Pricing } from "./Pricing";
import { Probe } from "./Probe";

/** No router: switch on the pathname and follow popstate. */
export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  if (path === "/pricing") return <Pricing />;
  if (path === "/probe") return <Probe />;
  if (path === "/login") return <Login />;
  return <Home />;
}
