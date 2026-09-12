import * as React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <button type="button" aria-label="Save changes">
        <span data-testid="exact-child">Save</span>
      </button>
      <button type="button">
        <span>Unmapped child</span>
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
