// Entry for component-sink.html, which only the Vite dev server serves.
import "../styles.css";
import { createRoot } from "react-dom/client";
import { installInputModality } from "../lib/input-modality";
import { ComponentSink } from "./component-sink";

installInputModality();
const root = document.getElementById("root");
if (root) createRoot(root).render(<ComponentSink />);
