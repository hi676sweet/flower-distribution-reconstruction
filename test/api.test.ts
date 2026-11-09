import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../api/app';

test('HTTP contract covers validation, reservation conflict, shipment, and dashboard', async () => {
  const server = await createApp({ databasePath: ':memory:', seed: false, logger: false });
  try {
    await server.app.listen(0, '127.0.0.1');
    const base = await server.app.getUrl();
    const post = (url: string, body = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(base + '/api/health')).status, 200);
    const invalid = await post('/api/items', { name: 'Incomplete' });
    assert.equal(invalid.status, 400);
    const itemResponse = await post('/api/items', { sku: 'DEMO-1', name: 'Demo flower', grower: 'Demo Grower', category: 'Focal', quantity: 5, unitCost: 100 });
    assert.equal(itemResponse.status, 201);
    const item = await itemResponse.json() as { id: number };
    const orderResponse = await post('/api/orders', { customer: 'Demo Florist', lines: [{ itemId: item.id, quantity: 3 }] });
    const order = await orderResponse.json() as { id: number };
    assert.equal((await post(`/api/orders/${order.id}/reserve`)).status, 201);
    assert.equal((await post(`/api/orders/${order.id}/reserve`)).status, 409);
    assert.equal((await post(`/api/orders/${order.id}/ship`)).status, 201);
    assert.equal((await post(`/api/orders/${order.id}/cancel`)).status, 409);
    const snapshot = await (await fetch(base + '/api/dashboard')).json() as { metrics: { totalStems: number; reservedStems: number } };
    assert.equal(snapshot.metrics.totalStems, 2);
    assert.equal(snapshot.metrics.reservedStems, 0);
    assert.equal((await post('/api/items/not-an-id/receipts')).status, 400);
  } finally { await server.close(); }
});
