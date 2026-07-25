import React from "react";
import ReactDOM from "react-dom/client";
import "../styles.css";
import { applyCachedAppearance } from "../lib/appearance-runtime";
import { AssistantApp } from "./assistant-app";

// The window is transparent + vibrant; only the assistant surface is painted.
document.documentElement.classList.add("aiden-assistant-window");
applyCachedAppearance();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AssistantApp />
  </React.StrictMode>,
);
