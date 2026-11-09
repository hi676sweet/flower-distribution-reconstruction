const assert = require('node:assert/strict');
const { createApp } = require('../dist/api/app.js');

async function smoke() {
  const server = await createApp({ databasePath: ':memory:', seed: true, logger: false });
  try {
    await server.app.listen(0, '127.0.0.1');
    const base = await server.app.getUrl();
    const home = await fetch(base);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Stocklane/);
    const script = html.match(/src="(\/assets\/[^\"]+\.js)"/);
    assert.ok(script, 'Built entry JavaScript is linked from index.html');
    assert.equal((await fetch(base + script[1])).status, 200);
    const dashboard = await (await fetch(base + '/api/dashboard')).json();
    assert.equal(dashboard.items.length, 6);
    assert.equal(dashboard.orders.length, 3);
    assert.ok(dashboard.metrics.availableStems < dashboard.metrics.totalStems);
    console.log('Production smoke passed: frontend HTML/JS, seeded SQLite, and dashboard API.');
  } finally { await server.close(); }
}
smoke().catch(error => { console.error(error); process.exitCode = 1; });
