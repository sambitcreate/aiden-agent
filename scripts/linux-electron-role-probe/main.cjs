/* global process, __dirname, setTimeout */
const { app, BrowserWindow, utilityProcess, net } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runtime = '/var/tmp/aiden-electron-role-probe-runtime';
app.setPath('userData', path.join(runtime, 'profile'));
const receipt = { scope: 'role-boundary-candidate', electron: process.versions.electron,
  mainPid: process.pid, mainContext: fs.readFileSync('/proc/self/attr/current', 'utf8').trim(),
  roleIsolationEstablished: false, computerUseEnabled: false, errors: [] };
function finish(code) {
  fs.writeFileSync(path.join(runtime, 'app.json'), JSON.stringify(receipt, null, 2));
  app.exit(code);
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 500, height: 220, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html,<title>Aiden isolated role probe</title><p id="result">Synthetic renderer</p>');
  receipt.renderer = await win.webContents.executeJavaScript("document.getElementById('result').textContent = 'Renderer computed ' + (19 + 23)");
  const server = http.createServer((_request, response) => response.end('synthetic-network-ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  receipt.network = await (await net.fetch(`http://127.0.0.1:${server.address().port}/`)).text();
  server.close();
  const worker = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], { stdio: 'ignore' });
  receipt.worker = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('exit', code => reject(new Error(`worker exited ${code}`)));
  });
  const shell = spawnSync('/bin/sh', ['-c', 'cat /proc/self/attr/current'], { encoding: 'utf8' });
  receipt.shell = { status: shell.status, stdout: shell.stdout, stderr: shell.stderr, error: shell.error?.code };
  const command = spawnSync('/usr/bin/true', [], { encoding: 'utf8' });
  receipt.command = { status: command.status, error: command.error?.code };
  receipt.metrics = app.getAppMetrics();
  fs.writeFileSync(path.join(runtime, 'ready'), 'ready');
  // Keep all Chromium roles observable by the independent root cgroup collector.
  setTimeout(() => finish(0), 15000);
}).catch(error => { receipt.errors.push(String(error)); finish(1); });
setTimeout(() => { receipt.errors.push('fixture timeout'); finish(2); }, 40000).unref();
