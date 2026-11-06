import { createBotOpenWorkStore } from "../store.js";
const [profile, stage] = process.argv.slice(2);
const hold = () => new Promise<void>(() => { setInterval(() => {}, 1_000); });
const store = createBotOpenWorkStore({ profileDir: () => profile!, botExists: async () => true, ...(stage === "before" ? { beforePublish: async () => { process.send?.("ready"); await hold(); } } : {}) });
const snapshot = await store.snapshot("bot:work");
await store.mutate("bot:work", { action: "add", mutationId: "10000000-0000-4000-8000-000000000001", expectedRevision: snapshot.revision, title: "Keep this task across a crash" });
process.send?.("ready"); await hold();
