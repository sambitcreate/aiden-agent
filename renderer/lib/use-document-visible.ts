import * as React from "react";

/** Whether the window is on screen; live streams run only while visible. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = React.useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
