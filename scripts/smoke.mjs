import assert from 'node:assert/strict';
const base = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
assert.ok(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD, 'Defina ADMIN_USER e ADMIN_PASSWORD');
const request = (path, options = {}) => fetch(new URL(path, base), {
  ...options, redirect: 'manual', signal: AbortSignal.timeout(5000)
});
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await request('/');
    await response.text();
    if (response.status === 200) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(ready, 'Aplicativo não inicializou em 60 tentativas');
const health = await request('/health');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok', database: 'connected' });
assert.equal((await request('/admin')).status, 303);
assert.equal((await request('/login')).status, 200);
const login = await request('/login', {
  method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD })
});
assert.equal(login.status, 303, 'Login falhou');
const cookie = login.headers.get('set-cookie');
assert.ok(cookie?.includes('HttpOnly') && cookie.includes('Secure'), 'Cookie de sessão ausente ou inseguro');
for (const path of ['/admin', '/admin/overview', '/admin/groups', '/admin/plan', '/admin/waha', '/admin/clicks', '/admin/settings', '/admin/diagnostics', '/admin/catalog-health']) {
  const response = await request(path, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(response.status, 200, `${path}: ${await response.text()}`);
}
console.log('Docker + PostgreSQL: catálogo, autenticação e nove páginas administrativas verificados.');
