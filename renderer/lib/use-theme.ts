import * as React from "react";

function applyTheme(shouldUseDarkColors: boolean): void {
  document.documentElement.classList.toggle("dark", shouldUseDarkColors);
  document.documentElement.style.colorScheme = shouldUseDarkColors ? "dark" : "light";
}

export function useTheme(): void {
  React.useEffect(() => {
    let active = true;
    void window.aidenAPI.nativeTheme.getInfo().then((info) => {
      if (active) applyTheme(info.shouldUseDarkColors);
    });
    const unsubscribe = window.aidenAPI.nativeTheme.onChanged((info) => applyTheme(info.shouldUseDarkColors));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
}
