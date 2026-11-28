import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("api", {
  version: () => "1.0.0",
});
