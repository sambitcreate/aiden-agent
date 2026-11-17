// Loaded with `node --import`: records every module the process evaluates.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    appendFileSync(process.env.AIDEN_TEST_LOAD_TRACE, `${url}\n`);
    return nextLoad(url, context);
  },
});
