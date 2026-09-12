/* global process, setTimeout */
const fs = require('node:fs');
process.parentPort.postMessage({ value: 6 * 7, pid: process.pid,
  context: fs.readFileSync('/proc/self/attr/current', 'utf8').trim() });
setTimeout(() => process.exit(0), 30000);
