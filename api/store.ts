import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class DomainError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

type Input = Record<string, unknown>;
export type Item = {
  id: number; sku: string; name: string; category: string; grower: string;
  onHand: number; reserved: number; reorderPoint: number; unitCost: number; available: number;
};
export type Order = {
  id: number; reference: string; customer: string; status: 'draft' | 'reserved' | 'shipped' | 'cancelled';
  createdAt: string; updatedAt: string; lines: { itemId: number; name: string; sku: string; quantity: number }[];
};

function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('A JSON object is required.');
  return value as Input;
}
function text(value: unknown, field: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new DomainError(`${field} must contain 1–${max} characters.`);
  }
  return value.trim();
}
function integer(value: unknown, field: string, min = 0, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

/** Synchronous SQLite transactions serialize stock transitions across all callers. */
export class InventoryStore {
  private db: DatabaseSync;
  constructor(path = ':memory:', seed = false) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
        category TEXT NOT NULL, grower TEXT NOT NULL,
        on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
        reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= on_hand),
        reorder_point INTEGER NOT NULL CHECK(reorder_point >= 0),
        unit_cost INTEGER NOT NULL CHECK(unit_cost >= 0)
      );
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reserved','shipped','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS order_lines (
        order_id INTEGER NOT NULL REFERENCES orders(id), item_id INTEGER NOT NULL REFERENCES items(id),
        quantity INTEGER NOT NULL CHECK(quantity > 0), PRIMARY KEY(order_id,item_id)
      );
      CREATE TABLE IF NOT EXISTS movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id),
        order_id INTEGER REFERENCES orders(id), kind TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity > 0), note TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS movements_recent ON movements(id DESC);
    `);
    if (seed && Number((this.db.prepare('SELECT COUNT(*) AS count FROM items').get() as { count: number }).count) === 0) this.seed();
  }
  close() { this.db.close(); }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private movement(itemId: number, kind: string, quantity: number, note: string, orderId: number | null = null) {
    this.db.prepare('INSERT INTO movements(item_id,order_id,kind,quantity,note,created_at) VALUES(?,?,?,?,?,?)')
      .run(itemId, orderId, kind, quantity, note, new Date().toISOString());
  }
  items(search = ''): Item[] {
    // Escape LIKE metacharacters: search text is treated literally, never as SQL.
    const escaped = search.slice(0, 100).replace(/[\\%_]/g, '\\$&');
    return this.db.prepare(`SELECT id,sku,name,category,grower,on_hand AS onHand,reserved,
      reorder_point AS reorderPoint,unit_cost AS unitCost,on_hand-reserved AS available FROM items
      WHERE name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR grower LIKE ? ESCAPE '\\' ORDER BY name`)
      .all(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`) as unknown as Item[];
  }
  private item(id: number): Item {
    const result = this.items().find(item => item.id === id);
    if (!result) throw new DomainError('Stock item was not found.', 404);
    return result;
  }
  createItem(raw: unknown): Item {
    const input = object(raw);
    const sku = text(input.sku, 'SKU', 32).toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(sku)) throw new DomainError('SKU can contain letters, numbers, and hyphens.');
    const name = text(input.name, 'Name');
    const category = text(input.category, 'Category', 40);
    const grower = text(input.grower, 'Grower', 80);
    const reorder = integer(input.reorderPoint ?? 20, 'Reorder point');
    const cost = integer(input.unitCost ?? 0, 'Unit cost', 0, 100_000_000);
    const quantity = integer(input.quantity ?? 0, 'Opening quantity');
    return this.tx(() => {
      if (this.db.prepare('SELECT id FROM items WHERE sku=?').get(sku)) throw new DomainError('This SKU already exists.', 409);
      const result = this.db.prepare('INSERT INTO items(sku,name,category,grower,on_hand,reorder_point,unit_cost) VALUES(?,?,?,?,?,?,?)')
        .run(sku, name, category, grower, quantity, reorder, cost);
      const id = Number(result.lastInsertRowid);
      if (quantity) this.movement(id, 'received', quantity, 'Opening stock');
      return this.item(id);
    });
  }
  receive(id: number, raw: unknown): Item {
    const input = object(raw);
    const quantity = integer(input.quantity, 'Receipt quantity', 1);
    const note = text(input.note, 'Receipt reference', 140);
    return this.tx(() => {
      const item = this.item(id);
      if (item.onHand + quantity > 1_000_000) throw new DomainError('Receipt exceeds the item stock limit.');
      this.db.prepare('UPDATE items SET on_hand=on_hand+? WHERE id=?').run(quantity, id);
      this.movement(id, 'received', quantity, note);
      return this.item(id);
    });
  }
  orders(): Order[] {
    const rows = this.db.prepare('SELECT id,customer,status,created_at AS createdAt,updated_at AS updatedAt FROM orders ORDER BY id DESC').all() as unknown as Omit<Order, 'reference' | 'lines'>[];
    return rows.map(row => ({ ...row, reference: `SL-${1000 + row.id}`, lines: this.db.prepare(`SELECT l.item_id AS itemId,i.name,i.sku,l.quantity
      FROM order_lines l JOIN items i ON i.id=l.item_id WHERE l.order_id=? ORDER BY i.name`).all(row.id) as unknown as Order['lines'] }));
  }
  private order(id: number): Order {
    const order = this.orders().find(order => order.id === id);
    if (!order) throw new DomainError('Order was not found.', 404);
    return order;
  }
  createOrder(raw: unknown): Order {
    const input = object(raw);
    const customer = text(input.customer, 'Florist name', 80);
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 30) throw new DomainError('An order needs 1–30 lines.');
    const seen = new Set<number>();
    const lines = input.lines.map(rawLine => {
      const line = object(rawLine);
      const itemId = integer(line.itemId, 'Stock item', 1);
      if (seen.has(itemId)) throw new DomainError('Combine duplicate stock items into a single order line.');
      seen.add(itemId);
      return { itemId, quantity: integer(line.quantity, 'Line quantity', 1) };
    });
    return this.tx(() => {
      for (const line of lines) this.item(line.itemId);
      const now = new Date().toISOString();
      const id = Number(this.db.prepare('INSERT INTO orders(customer,created_at,updated_at) VALUES(?,?,?)').run(customer, now, now).lastInsertRowid);
      for (const line of lines) this.db.prepare('INSERT INTO order_lines VALUES(?,?,?)').run(id, line.itemId, line.quantity);
      return this.order(id);
    });
  }
  transition(id: number, action: string): Order {
    if (!['reserve', 'ship', 'cancel'].includes(action)) throw new DomainError('Unknown order action.', 404);
    return this.tx(() => {
      const order = this.order(id);
      const allowed = action === 'reserve' ? ['draft'] : action === 'ship' ? ['reserved'] : ['draft', 'reserved'];
      if (!allowed.includes(order.status)) throw new DomainError(`Cannot ${action} an order that is ${order.status}.`, 409);
      for (const line of order.lines) {
        if (action === 'reserve') {
          const update = this.db.prepare('UPDATE items SET reserved=reserved+? WHERE id=? AND on_hand-reserved>=?').run(line.quantity, line.itemId, line.quantity);
          if (Number(update.changes) !== 1) throw new DomainError(`Not enough available stems of ${line.name}. Receive stock or reduce the order.`, 409);
          this.movement(line.itemId, 'reserved', line.quantity, order.reference, id);
        } else if (action === 'ship') {
          const update = this.db.prepare('UPDATE items SET on_hand=on_hand-?,reserved=reserved-? WHERE id=? AND reserved>=? AND on_hand>=?')
            .run(line.quantity, line.quantity, line.itemId, line.quantity, line.quantity);
          if (Number(update.changes) !== 1) throw new DomainError('Stock changed; shipment was not applied.', 409);
          this.movement(line.itemId, 'shipped', line.quantity, order.reference, id);
        } else if (order.status === 'reserved') {
          this.db.prepare('UPDATE items SET reserved=reserved-? WHERE id=?').run(line.quantity, line.itemId);
          this.movement(line.itemId, 'released', line.quantity, `${order.reference} cancelled`, id);
        }
      }
      const status = action === 'reserve' ? 'reserved' : action === 'ship' ? 'shipped' : 'cancelled';
      this.db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id);
      return this.order(id);
    });
  }
  snapshot() {
    const items = this.items();
    const orders = this.orders();
    const movements = this.db.prepare(`SELECT m.id,m.kind,m.quantity,m.note,m.created_at AS createdAt,i.name AS itemName,i.sku
      FROM movements m JOIN items i ON i.id=m.item_id ORDER BY m.id DESC LIMIT 15`).all();
    return { items, orders, movements, metrics: {
      totalStems: items.reduce((sum, item) => sum + item.onHand, 0),
      availableStems: items.reduce((sum, item) => sum + item.available, 0),
      reservedStems: items.reduce((sum, item) => sum + item.reserved, 0),
      lowStock: items.filter(item => item.available <= item.reorderPoint).length,
      pendingOrders: orders.filter(order => ['draft', 'reserved'].includes(order.status)).length,
      inventoryValue: items.reduce((sum, item) => sum + item.onHand * item.unitCost, 0),
    } };
  }
  private seed() {
    const items = [
      { sku: 'RS-PEA-01', name: 'Peach garden rose', category: 'Focal flowers', grower: 'Morrow Fields', quantity: 240, reorderPoint: 60, unitCost: 145 },
      { sku: 'DA-WHT-02', name: 'White dahlia', category: 'Focal flowers', grower: 'Northbank Growers', quantity: 75, reorderPoint: 40, unitCost: 190 },
      { sku: 'TU-APR-03', name: 'Apricot tulip', category: 'Seasonal flowers', grower: 'Morrow Fields', quantity: 180, reorderPoint: 50, unitCost: 110 },
      { sku: 'EU-SIL-04', name: 'Silver dollar eucalyptus', category: 'Foliage', grower: 'Willow Cooperative', quantity: 320, reorderPoint: 80, unitCost: 65 },
      { sku: 'SN-BLU-05', name: 'Blue statice', category: 'Fillers', grower: 'Northbank Growers', quantity: 28, reorderPoint: 40, unitCost: 70 },
      { sku: 'LI-CRM-06', name: 'Cream lisianthus', category: 'Seasonal flowers', grower: 'Willow Cooperative', quantity: 90, reorderPoint: 30, unitCost: 160 },
    ].map(input => this.createItem(input));
    const held = this.createOrder({ customer: 'Juniper Floral Studio', lines: [{ itemId: items[0].id, quantity: 60 }, { itemId: items[3].id, quantity: 30 }] });
    this.transition(held.id, 'reserve');
    this.createOrder({ customer: 'Sunday Stem Shop', lines: [{ itemId: items[1].id, quantity: 40 }, { itemId: items[4].id, quantity: 20 }] });
    const shipped = this.createOrder({ customer: 'The Quiet Bouquet', lines: [{ itemId: items[2].id, quantity: 30 }] });
    this.transition(shipped.id, 'reserve'); this.transition(shipped.id, 'ship');
  }
}
