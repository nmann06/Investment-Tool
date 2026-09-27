const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

test('app and API stay public even with legacy production password settings', async (t) => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), RENDER: 'true', APP_PASSWORD: 'obsolete-test-password' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Server startup timed out')), 10000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(Error(`Server exited: ${code}`)); });
    server.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const route of ['/app', '/research.html', '/app.js', '/math.js', '/styles.css', '/sample-data.csv']) {
    const response = await fetch(base + route, { redirect: 'manual' });
    assert.equal(response.status, 200, route);
  }
  const status = await fetch(base + '/api/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).signOut, false);
  for (const route of ['/api/company?symbol=!', '/api/profile?symbol=!']) {
    assert.equal((await fetch(base + route)).status, 400, 'Public API reaches validation without a session');
  }
  assert.equal((await fetch(base + '/api/market', { method: 'POST' })).status, 405);
  for (const route of ['/login', '/logout']) {
    const response = await fetch(base + route, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/app');
  }
});
