// server.js
// -----------------------------------------------------------------------
// เว็บเซิร์ฟเวอร์หลัก: Express รับ request, คุยกับฐานข้อมูล PostgreSQL (db/init.js)
// แล้วส่งข้อมูลกลับเป็น JSON ให้หน้าเว็บ (public/app.js) เอาไปแสดงผล
// -----------------------------------------------------------------------
require('dotenv').config(); // โหลดค่าจากไฟล์ .env ถ้ามี (ไม่มีก็ข้ามเฉยๆ ไม่ error) — ใช้ตอน dev ในเครื่อง
const express = require('express');
const path = require('path');
const multer = require('multer');
const { pool, initDb } = require('./db/init.js');

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------
// รูปอุปกรณ์ที่อัปโหลด: เก็บเป็น "ถาวร" ไว้ในคอลัมน์ BYTEA ของตาราง equipment
// เอง (ดู db/init.js) แทนที่จะเซฟไฟล์ลงดิสก์ของ web service — เพราะดิสก์ของ
// Render (แผนฟรี) เป็นแบบชั่วคราว ไฟล์จะหายทุกครั้งที่ deploy ใหม่ ส่วน Postgres
// เป็นฐานข้อมูลแยกต่างหากที่อยู่ถาวร รูปที่อัปโหลดจึงไม่หายอีกต่อไป
//
// ใช้ multer.memoryStorage() แทน diskStorage — ไฟล์ที่อัปโหลดจะอยู่ใน
// req.file.buffer (ในหน่วยความจำ) ไม่ถูกเขียนลงดิสก์เลย แล้วค่อยเอา buffer นั้น
// ไปเก็บลงคอลัมน์ image_data ตรงๆ
// -----------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // จำกัดไฟล์ไม่เกิน 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('อัปโหลดได้เฉพาะไฟล์รูปภาพเท่านั้น'));
    }
    cb(null, true);
  },
});

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
  // หมายเหตุ: ตั้งใจไม่ SELECT e.image_data มาด้วย (ไฟล์รูปจริงเก็บเป็น BYTEA อยู่ในนี้)
  // เพราะฝั่งหน้าเว็บต้องการแค่ e.image_url (ลิงก์ไปที่ endpoint /api/equipment/:id/image
  // ที่จะดึงรูปมาเสิร์ฟแยกทีหลัง) การดึง image_data มาด้วยทุกครั้งที่โหลดรายการอุปกรณ์
  // จะทำให้ response หนักขึ้นมากโดยไม่จำเป็น (รูปทุกชิ้นถูกส่งมาพร้อมกันหมด)
  let sql = `
    SELECT e.id, e.code, e.name, e.category_id, e.image_url, e.stock_qty, e.status, e.created_at,
           c.name AS category_name, c.icon AS category_icon
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

app.post('/api/equipment', async (req, res) => {
  const { code, name, category_id, stock_qty, status, image_url } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'ต้องระบุ code และ name' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO equipment (code, name, category_id, stock_qty, status, image_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [code, name, category_id || null, stock_qty || 0, status || 'available', image_url || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    // 23505 = unique_violation — รหัสอุปกรณ์ (code) ซ้ำกับที่มีอยู่แล้ว
    if (err.code === '23505') {
      return res.status(400).json({ error: `รหัสอุปกรณ์ "${code}" ถูกใช้ไปแล้ว กรุณาตั้งรหัสอื่น` });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/equipment/:id', async (req, res) => {
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
  try {
    await pool.query(`UPDATE equipment SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: `รหัสอุปกรณ์ "${req.body.code}" ถูกใช้ไปแล้ว กรุณาตั้งรหัสอื่น` });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/equipment/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM equipment WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    // 23503 = foreign_key_violation — อุปกรณ์นี้ถูกอ้างอิงอยู่ในรายการจอง (booking_items) หรือค่าใช้จ่าย (expenses) อยู่
    // ตอบกลับเป็นข้อความที่เข้าใจง่ายแทนข้อความ error ดิบของ Postgres
    if (err.code === '23503') {
      return res.status(400).json({ error: 'ลบไม่ได้ เพราะอุปกรณ์นี้ถูกใช้อยู่ในรายการจองหรือค่าใช้จ่ายที่มีอยู่แล้ว' });
    }
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// อัปโหลดรูปอุปกรณ์ — รับไฟล์ผ่าน multipart/form-data ชื่อฟิลด์ 'image' แล้วเก็บ
// ไบต์ของรูปตรงๆ ลงคอลัมน์ image_data ของอุปกรณ์ชิ้นนั้น (เก็บถาวรในฐานข้อมูล)
// image_version ใช้กันเบราว์เซอร์แคชรูปเก่าค้าง — เพิ่มค่าทุกครั้งที่อัปโหลดใหม่
// แล้วฝัง ?v=<version> ต่อท้าย URL ให้ URL เปลี่ยนทุกครั้งที่มีรูปใหม่
app.post('/api/equipment/:id/image', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      // ครอบ error ของ multer เอง (ไฟล์ใหญ่เกิน, ไม่ใช่รูปภาพ ฯลฯ) ให้ตอบเป็น JSON เหมือน endpoint อื่น
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปที่อัปโหลด' });

    try {
      const { rows } = await pool.query(
        `UPDATE equipment
         SET image_data = $1,
             image_mime = $2,
             image_version = image_version + 1,
             image_url = '/api/equipment/' || $3::text || '/image?v=' || (image_version + 1)::text
         WHERE id = $3
         RETURNING image_url`,
        [req.file.buffer, req.file.mimetype, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'ไม่พบอุปกรณ์นี้' });

      res.json({ ok: true, image_url: rows[0].image_url });
    } catch (dbErr) {
      console.error(dbErr);
      res.status(500).json({ error: dbErr.message });
    }
  });
});

// เสิร์ฟรูปอุปกรณ์จากฐานข้อมูลตรงๆ (ไม่ผ่านไฟล์ระบบเลย) — ?v= ท้าย URL ไม่ได้ถูกใช้
// ในโค้ดฝั่งนี้ มีไว้แค่กันเบราว์เซอร์แคช URL เดิมข้ามรูปใหม่เท่านั้น
app.get('/api/equipment/:id/image', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT image_data, image_mime FROM equipment WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length || !rows[0].image_data) return res.status(404).send('ไม่พบรูปอุปกรณ์นี้');
    res.set('Content-Type', rows[0].image_mime || 'image/jpeg');
    // URL นี้ผูกกับ image_version เฉพาะเจาะจง (จาก ?v=) เนื้อหาที่ URL นี้จะไม่เปลี่ยนอีก
    // ต่อให้มีการอัปโหลดรูปใหม่ทับ เพราะจะได้ ?v= ใหม่ไปเลย จึงแคชได้ยาวๆ อย่างปลอดภัย
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(rows[0].image_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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

// ลบรายการออกบูธ 1 งาน — ลบข้อมูลที่ผูกกับงานนี้ไปด้วย (การจอง/รายการอุปกรณ์ในบิล/ค่าใช้จ่าย)
// เพราะตอนสร้างตารางไม่ได้ตั้ง ON DELETE CASCADE ไว้ตั้งแต่แรก จึงต้องลบตามลำดับเองในทรานแซกชันเดียว
// และคืนสถานะอุปกรณ์ที่เคยถูกจอง (reserved) ไว้ในงานนี้ให้กลับเป็น "พร้อมใช้งาน" ไม่ให้ค้างสถานะตลอดไป
app.delete('/api/events/:id', wrap(async (req, res) => {
  const eventId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (!existing.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบรายการออกบูธนี้' });
    }

    const { rows: equipIds } = await client.query(
      `SELECT DISTINCT bi.equipment_id
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       WHERE b.event_id = $1`,
      [eventId]
    );

    await client.query(
      `DELETE FROM booking_items WHERE booking_id IN (SELECT id FROM bookings WHERE event_id = $1)`,
      [eventId]
    );
    await client.query('DELETE FROM bookings WHERE event_id = $1', [eventId]);
    await client.query('DELETE FROM expenses WHERE event_id = $1', [eventId]);

    if (equipIds.length) {
      await client.query(
        `UPDATE equipment SET status = 'available' WHERE id = ANY($1::int[]) AND status = 'reserved'`,
        [equipIds.map((r) => r.equipment_id)]
      );
    }

    await client.query('DELETE FROM events WHERE id = $1', [eventId]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
