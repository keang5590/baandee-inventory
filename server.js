// server.js
// -----------------------------------------------------------------------
// เว็บเซิร์ฟเวอร์หลัก: Express รับ request, คุยกับฐานข้อมูล PostgreSQL (db/init.js)
// แล้วส่งข้อมูลกลับเป็น JSON ให้หน้าเว็บ (public/app.js) เอาไปแสดงผล
// -----------------------------------------------------------------------
require('dotenv').config(); // โหลดค่าจากไฟล์ .env ถ้ามี (ไม่มีก็ข้ามเฉยๆ ไม่ error) — ใช้ตอน dev ในเครื่อง
const express = require('express');
const path = require('path');
const { pool, initDb } = require('./db/init.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// ปิดการแคชไฟล์หน้าเว็บ (HTML/CSS/JS) ไว้ก่อน เพื่อไม่ให้เบราว์เซอร์ค้างเวอร์ชันเก่า
// ไว้ตอนแก้โค้ดแล้ว refresh หน้าเว็บแล้วเห็นการเปลี่ยนแปลงทันที (สำคัญมากตอนกำลังเรียนรู้/แก้บั๊ก)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// helper ครอบ error ของ route แบบ async ให้ตอบกลับเป็น JSON เสมอ
// (แทนการเขียน try/catch ซ้ำๆ ในทุก endpoint)
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ========================= CATEGORIES (หมวดอุปกรณ์) =========================
app.get('/api/categories', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY id');
  res.json(rows);
}));

// ========================= EQUIPMENT (อุปกรณ์ / สต็อก) =========================
app.get('/api/equipment', wrap(async (req, res) => {
  const { q, category_id, status } = req.query;
  let sql = `
    SELECT e.*, c.name AS category_name, c.icon AS category_icon
    FROM equipment e
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE 1=1
  `;
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    sql += ` AND (e.name ILIKE $${params.length} OR e.code ILIKE $${params.length})`;
  }
  if (category_id) {
    params.push(category_id);
    sql += ` AND e.category_id = $${params.length}`;
  }
  if (status) {
    params.push(status);
    sql += ` AND e.status = $${params.length}`;
  }
  sql += ' ORDER BY e.stock_qty DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

app.post('/api/equipment', wrap(async (req, res) => {
  const { code, name, category_id, stock_qty, status, image_url } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'ต้องระบุ code และ name' });
  const { rows } = await pool.query(
    `INSERT INTO equipment (code, name, category_id, stock_qty, status, image_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [code, name, category_id || null, stock_qty || 0, status || 'available', image_url || null]
  );
  res.status(201).json({ id: rows[0].id });
}));

app.patch('/api/equipment/:id', wrap(async (req, res) => {
  const fields = ['code', 'name', 'category_id', 'stock_qty', 'status', 'image_url'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      params.push(req.body[f]);
      updates.push(`${f} = $${params.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' });
  params.push(req.params.id);
  await pool.query(`UPDATE equipment SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
  res.json({ ok: true });
}));

app.delete('/api/equipment/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM equipment WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ========================= EVENTS (งานออกบูธ) =========================
app.get('/api/events', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events ORDER BY id DESC');
  res.json(rows);
}));

app.post('/api/events', wrap(async (req, res) => {
  const { name, location, start_date, end_date } = req.body;
  if (!name) return res.status(400).json({ error: 'ต้องระบุชื่องาน' });
  const { rows } = await pool.query(
    `INSERT INTO events (name, location, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, location || null, start_date || null, end_date || null]
  );
  res.status(201).json({ id: rows[0].id });
}));

// ========================= BOOKINGS (การจองอุปกรณ์) =========================
app.get('/api/bookings', wrap(async (req, res) => {
  const { rows: bookings } = await pool.query(`
    SELECT b.*, ev.name AS event_name, ev.location AS event_location
    FROM bookings b
    LEFT JOIN events ev ON ev.id = b.event_id
    ORDER BY b.id DESC
  `);
  for (const b of bookings) {
    const { rows: items } = await pool.query(
      `SELECT bi.*, e.name AS equipment_name, e.code AS equipment_code
       FROM booking_items bi
       JOIN equipment e ON e.id = bi.equipment_id
       WHERE bi.booking_id = $1`,
      [b.id]
    );
    b.items = items;
  }
  res.json(bookings);
}));

app.post('/api/bookings', wrap(async (req, res) => {
  const { event_id, created_by, items } = req.body; // items: [{equipment_id, qty}]
  if (!items || !items.length) return res.status(400).json({ error: 'ต้องเลือกอุปกรณ์อย่างน้อย 1 รายการ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO bookings (event_id, created_by, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [event_id || null, created_by || null]
    );
    const bookingId = rows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO booking_items (booking_id, equipment_id, qty) VALUES ($1, $2, $3)`,
        [bookingId, item.equipment_id, item.qty || 1]
      );
      await client.query(
        `UPDATE equipment SET status = 'reserved' WHERE id = $1 AND stock_qty <= $2`,
        [item.equipment_id, item.qty || 1]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ id: bookingId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.patch('/api/bookings/:id', wrap(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  }
  await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, req.params.id]);
  res.json({ ok: true });
}));

// ========================= EXPENSE CATEGORIES (หมวดค่าใช้จ่าย) =========================
app.get('/api/expense-categories', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM expense_categories ORDER BY id');
  res.json(rows);
}));

app.post('/api/expense-categories', wrap(async (req, res) => {
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อหมวดค่าใช้จ่าย' });
  const { rows } = await pool.query(
    'INSERT INTO expense_categories (name, icon) VALUES ($1, $2) RETURNING id',
    [name, icon || '💰']
  );
  res.status(201).json({ id: rows[0].id });
}));

app.delete('/api/expense-categories/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM expense_categories WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ========================= EXPENSES (รายการค่าใช้จ่าย) =========================
app.get('/api/expenses', wrap(async (req, res) => {
  const { event_id, category_id } = req.query;
  let sql = `
    SELECT x.*, c.name AS category_name, c.icon AS category_icon,
           ev.name AS event_name, e.name AS equipment_name
    FROM expenses x
    JOIN expense_categories c ON c.id = x.category_id
    LEFT JOIN events ev ON ev.id = x.event_id
    LEFT JOIN equipment e ON e.id = x.equipment_id
    WHERE 1=1
  `;
  const params = [];
  if (event_id) { params.push(event_id); sql += ` AND x.event_id = $${params.length}`; }
  if (category_id) { params.push(category_id); sql += ` AND x.category_id = $${params.length}`; }
  sql += ' ORDER BY x.expense_date DESC, x.id DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

app.post('/api/expenses', wrap(async (req, res) => {
  const { category_id, event_id, equipment_id, description, amount, expense_date } = req.body;
  if (!category_id || !amount) return res.status(400).json({ error: 'ต้องระบุหมวดหมู่และจำนวนเงิน' });
  const { rows } = await pool.query(
    `INSERT INTO expenses (category_id, event_id, equipment_id, description, amount, expense_date)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE)) RETURNING id`,
    [category_id, event_id || null, equipment_id || null, description || null, amount, expense_date || null]
  );
  res.status(201).json({ id: rows[0].id });
}));

app.delete('/api/expenses/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// สรุปยอดค่าใช้จ่ายแยกตามหมวด (ใช้วาดการ์ดสรุปในแท็บหมวดค่าใช้จ่าย)
app.get('/api/expenses/summary', wrap(async (req, res) => {
  const { event_id } = req.query;
  const params = [];
  let joinCondition = 'x.category_id = c.id';
  if (event_id) {
    params.push(event_id);
    joinCondition += ` AND x.event_id = $${params.length}`;
  }
  const sql = `
    SELECT c.id AS category_id, c.name AS category_name, c.icon AS category_icon,
           COALESCE(SUM(x.amount), 0) AS total
    FROM expense_categories c
    LEFT JOIN expenses x ON ${joinCondition}
    GROUP BY c.id
    ORDER BY total DESC
  `;
  const { rows } = await pool.query(sql, params);
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  res.json({ byCategory: rows, grandTotal });
}));

async function main() {
  try {
    await initDb();
  } catch (err) {
    console.error('[db] เชื่อมต่อหรือสร้างฐานข้อมูลไม่สำเร็จ:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n🏠 บ้านดี Inventory กำลังทำงานที่ http://localhost:${PORT}\n`);
  });
}

main();
