import React from "react";
import ReactDOM from "react-dom/client";
import "../styles.css";
import { applyCachedAppearance } from "../lib/appearance-runtime";
import { PillApp } from "./pill-app";

// The pill window is fully transparent; only the pill surface is painted.
document.documentElement.classList.add("aiden-pill-window");
applyCachedAppearance();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <PillApp />
  </React.StrictMode>,
);
