/* global process, setTimeout */
const fs = require('node:fs');
const ipc = require('./ipc-addon.node');
process.parentPort.postMessage({ value: 6 * 7, pid: process.pid,
  context: fs.readFileSync('/proc/self/attr/current', 'utf8').trim(),
  ipc: [JSON.parse(ipc.receive(false)), JSON.parse(ipc.receive(true))] });
setTimeout(() => process.exit(0), 30000);
