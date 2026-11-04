// Builds samples/shop.sqlite: a small, realistic store database for the sample notebook.
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

const file = 'samples/shop.sqlite';
rmSync(file, { force: true });
const db = new DatabaseSync(file);

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

db.exec(`
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  city TEXT NOT NULL,
  signup_date DATE NOT NULL
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('placed','shipped','delivered','cancelled'))
);
CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(order_date);
`);

const first = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Liam', 'Emma', 'Noah', 'Olivia', 'Mateo', 'Sofia', 'Yuki', 'Hana', 'Lukas', 'Mia', 'Omar', 'Layla', 'Chen', 'Mei', 'Ivan', 'Elena', 'Kofi', 'Ama', 'Diego', 'Lucia'];
const last = ['Sharma', 'Patel', 'Iyer', 'Smith', 'Johnson', 'Garcia', 'Silva', 'Tanaka', 'Muller', 'Rossi', 'Khan', 'Wang', 'Ivanova', 'Mensah', 'Lopez', 'Brown', 'Kim', 'Nguyen'];
const places = [
  ['India', ['Mumbai', 'Bengaluru', 'Delhi', 'Pune', 'Kolkata']],
  ['United States', ['New York', 'Austin', 'Seattle', 'Chicago']],
  ['United Kingdom', ['London', 'Manchester', 'Leeds']],
  ['Germany', ['Berlin', 'Munich', 'Hamburg']],
  ['Japan', ['Tokyo', 'Osaka']],
  ['Brazil', ['São Paulo', 'Rio de Janeiro']],
  ['Canada', ['Toronto', 'Vancouver']],
];
const day = (start, span) => {
  const d = new Date(Date.UTC(2025, 0, 1) + (start + Math.floor(rand() * span)) * 86400000);
  return d.toISOString().slice(0, 10);
};

const insC = db.prepare('INSERT INTO customers VALUES (?,?,?,?,?,?)');
for (let i = 1; i <= 240; i++) {
  const f = pick(first), l = pick(last);
  const [country, cities] = rand() < 0.35 ? places[0] : pick(places);
  insC.run(i, `${f} ${l}`, `${f}.${l}${i}@example.com`.toLowerCase(), country, pick(cities), day(-400, 400));
}

const catalog = {
  Laptops: [['Air 13', 999], ['Pro 14', 1599], ['Studio 16', 2299], ['Book 15', 749]],
  Phones: [['Nova 8', 699], ['Nova 8 Max', 899], ['Lite 5', 299], ['Fold X', 1499]],
  Audio: [['Pods Mini', 89], ['Pods Pro', 199], ['Studio Headphones', 299], ['Soundbar 2', 349], ['Speaker Go', 59]],
  Accessories: [['USB-C Cable', 12], ['65W Charger', 39], ['Laptop Sleeve', 29], ['Wireless Mouse', 25], ['Mechanical Keyboard', 119], ['4K Webcam', 129]],
  Monitors: [['View 24', 189], ['View 27 QHD', 329], ['View 32 4K', 549]],
  Wearables: [['Band 3', 49], ['Watch S', 249], ['Watch Ultra', 499]],
};
const insP = db.prepare('INSERT INTO products VALUES (?,?,?,?,?)');
const products = [];
let pid = 1;
for (const [cat, items] of Object.entries(catalog)) {
  for (const [name, price] of items) {
    insP.run(pid, name, cat, price, int(0, 400));
    products.push({ id: pid, price, cat });
    pid++;
  }
}

const insO = db.prepare('INSERT INTO orders VALUES (?,?,?,?)');
const insI = db.prepare('INSERT INTO order_items VALUES (?,?,?,?)');
db.exec('BEGIN');
for (let o = 1; o <= 1800; o++) {
  // More orders later in the year, with a holiday bump.
  let d = Math.floor(Math.pow(rand(), 0.8) * 365);
  if (rand() < 0.12) d = int(320, 360);
  const date = day(d, 1);
  const status = d > 355 ? 'placed' : d > 345 ? pick(['placed', 'shipped']) : rand() < 0.06 ? 'cancelled' : 'delivered';
  insO.run(o, int(1, 240), date, status);
  const n = rand() < 0.6 ? 1 : rand() < 0.8 ? 2 : int(3, 4);
  const used = new Set();
  for (let k = 0; k < n; k++) {
    const p = rand() < 0.45 ? products.filter((x) => x.cat === 'Accessories' || x.cat === 'Audio')[int(0, 10)] : pick(products);
    if (used.has(p.id)) continue;
    used.add(p.id);
    const discount = rand() < 0.15 ? 0.9 : 1;
    insI.run(o, p.id, p.price < 60 ? int(1, 3) : 1, Math.round(p.price * discount * 100) / 100);
  }
}
db.exec('COMMIT');

db.exec(`
CREATE VIEW monthly_revenue AS
SELECT strftime('%Y-%m', o.order_date) AS month,
       COUNT(DISTINCT o.id) AS orders,
       ROUND(SUM(i.quantity * i.unit_price), 2) AS revenue
FROM orders o JOIN order_items i ON i.order_id = o.id
WHERE o.status <> 'cancelled'
GROUP BY 1
ORDER BY 1;
`);
db.exec('VACUUM');
const counts = ['customers', 'products', 'orders', 'order_items'].map((t) => `${t}=${db.prepare(`select count(*) n from ${t}`).get().n}`);
console.log('Built', file, counts.join(' '));
db.close();
