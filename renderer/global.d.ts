import type { AidenAPI } from "./preload";

declare global {
  interface Window {
    aidenAPI: AidenAPI;
  }
}

export {};
