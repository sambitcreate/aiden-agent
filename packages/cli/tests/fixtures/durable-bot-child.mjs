import { createDaemonChats, createCliBots } from "../../dist/parity-test-api.js";
const [profile, botId, requestId] = process.argv.slice(2);
const daemon = createDaemonChats(profile);
const host = await createCliBots(profile, daemon);
await host.durable.runtime.send(botId, { text: "Hold this turn open", requestId });
process.stdout.write("SENT\n");
setInterval(() => {}, 1000);
