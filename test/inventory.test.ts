import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DomainError, InventoryStore } from '../api/store';

const input = { sku: 'ROSE-01', name: 'Test rose', category: 'Focal', grower: 'Demo Grower', quantity: 10, reorderPoint: 3, unitCost: 120 };
function fixture() {
  const store = new InventoryStore();
  const item = store.createItem(input);
  const order = (quantity: number, customer = 'Demo Florist') => store.createOrder({ customer, lines: [{ itemId: item.id, quantity }] });
  return { store, item, order };
}
const conflict = (error: unknown) => error instanceof DomainError && error.status === 409;

test('reserve holds available stock; ship decrements on-hand once', () => {
  const { store, item, order } = fixture();
  try {
    const created = order(4);
    store.transition(created.id, 'reserve');
    assert.deepEqual(store.items().map(row => [row.onHand, row.reserved, row.available]), [[10, 4, 6]]);
    assert.equal(store.transition(created.id, 'ship').status, 'shipped');
    assert.deepEqual(store.items().map(row => [row.onHand, row.reserved, row.available]), [[6, 0, 6]]);
    assert.throws(() => store.transition(created.id, 'ship'), conflict);
    assert.equal(store.items()[0].id, item.id);
    assert.equal(store.items()[0].onHand, 6);
  } finally { store.close(); }
});

test('a competing reservation cannot oversell available stock', () => {
  const { store, order } = fixture();
  try {
    store.transition(order(7).id, 'reserve');
    const second = order(4);
    assert.throws(() => store.transition(second.id, 'reserve'), conflict);
    assert.equal(store.orders().find(row => row.id === second.id)?.status, 'draft');
    assert.equal(store.items()[0].available, 3);
  } finally { store.close(); }
});

test('a failed multi-line reservation rolls back earlier stock and movement writes', () => {
  const { store, item } = fixture();
  try {
    const short = store.createItem({ ...input, sku: 'Z-LILY', name: 'Z lily', quantity: 1 });
    const order = store.createOrder({ customer: 'Demo', lines: [{ itemId: item.id, quantity: 5 }, { itemId: short.id, quantity: 2 }] });
    const before = store.snapshot().movements.length;
    assert.throws(() => store.transition(order.id, 'reserve'), conflict);
    assert.equal(store.items().every(row => row.reserved === 0), true);
    assert.equal(store.snapshot().movements.length, before);
    assert.equal(store.orders()[0].status, 'draft');
  } finally { store.close(); }
});

test('cancelling reserved order releases its holds without changing on-hand', () => {
  const { store, order } = fixture();
  try {
    const created = order(8);
    store.transition(created.id, 'reserve');
    store.transition(created.id, 'cancel');
    assert.deepEqual(store.items().map(row => [row.onHand, row.reserved, row.available]), [[10, 0, 10]]);
    assert.throws(() => store.transition(created.id, 'reserve'), conflict);
    assert.throws(() => store.transition(created.id, 'cancel'), conflict);
  } finally { store.close(); }
});

test('draft cancellation does not release another order reservation', () => {
  const { store, order } = fixture();
  try {
    store.transition(order(6).id, 'reserve');
    const draft = order(3);
    assert.throws(() => store.transition(draft.id, 'ship'), conflict);
    store.transition(draft.id, 'cancel');
    assert.equal(store.items()[0].reserved, 6);
  } finally { store.close(); }
});

test('receipt validates quantity and increases availability without changing holds', () => {
  const { store, item, order } = fixture();
  try {
    store.transition(order(8).id, 'reserve');
    store.receive(item.id, { quantity: 5, note: 'DEMO-PO-001' });
    assert.deepEqual(store.items().map(row => [row.onHand, row.reserved, row.available]), [[15, 8, 7]]);
    for (const quantity of [-1, 0, 0.5, '5', NaN, Infinity]) {
      assert.throws(() => store.receive(item.id, { quantity, note: 'Bad' }), DomainError);
    }
  } finally { store.close(); }
});

test('rejects duplicate SKU, duplicate order lines, missing items, and malformed orders', () => {
  const { store, item } = fixture();
  try {
    assert.throws(() => store.createItem({ ...input, sku: 'rose-01' }), conflict);
    assert.throws(() => store.createOrder({ customer: 'Demo', lines: [{ itemId: item.id, quantity: 2 }, { itemId: item.id, quantity: 3 }] }), DomainError);
    assert.throws(() => store.createOrder({ customer: 'Demo', lines: [{ itemId: 999, quantity: 1 }] }), DomainError);
    assert.throws(() => store.createOrder({ customer: '', lines: [] }), DomainError);
    assert.equal(store.orders().length, 0);
  } finally { store.close(); }
});

test('search treats SQL and LIKE syntax as literal text', () => {
  const { store } = fixture();
  try {
    assert.equal(store.items('rose').length, 1);
    assert.equal(store.items('Grower').length, 1);
    assert.equal(store.items("' OR 1=1 --").length, 0);
    assert.equal(store.items('%').length, 0);
    assert.equal(store.items('_').length, 0);
  } finally { store.close(); }
});

test('orders, inventory, and reservations persist after database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stocklane-test-'));
  const path = join(directory, 'inventory.db');
  let store = new InventoryStore(path);
  try {
    const item = store.createItem(input);
    const order = store.createOrder({ customer: 'Demo', lines: [{ itemId: item.id, quantity: 3 }] });
    store.transition(order.id, 'reserve');
    store.close(); store = new InventoryStore(path);
    assert.equal(store.items()[0].reserved, 3);
    assert.equal(store.orders()[0].status, 'reserved');
    store.transition(order.id, 'ship');
    assert.equal(store.items()[0].onHand, 7);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
