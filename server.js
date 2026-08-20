// server.js
// -----------------------------------------------------------------------
// เว็บเซิร์ฟเวอร์หลัก: Express รับ request, คุยกับฐานข้อมูล PostgreSQL (db/init.js)
// แล้วส่งข้อมูลกลับเป็น JSON ให้หน้าเว็บ (public/app.js) เอาไปแสดงผล
// -----------------------------------------------------------------------
require('dotenv').config(); // โหลดค่าจากไฟล์ .env ถ้ามี (ไม่มีก็ข้ามเฉยๆ ไม่ error) — ใช้ตอน dev ในเครื่อง
const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { pool, initDb } = require('./db/init.js');

const app = express();
const PORT = process.env.PORT || 3000;
// อยู่หลัง reverse proxy ของ Render (HTTPS terminate ที่ edge แล้วส่งต่อมาเป็น HTTP)
// ต้องตั้งค่านี้ไว้ req.protocol ถึงจะรู้ว่า request จริงๆ มาทาง https หรือเปล่า
app.set('trust proxy', 1);

// -----------------------------------------------------------------------
// ระบบล็อกอิน: ใช้ JWT (เซ็นด้วย secret key) เก็บไว้ใน cookie แบบ httpOnly
// แทนการเก็บ session ไว้ในหน่วยความจำเซิร์ฟเวอร์ — เพราะ Render (แผนฟรี) รีสตาร์ท
// โปรเซสได้บ่อย (deploy ใหม่/พักเครื่องตอนไม่มีคนใช้) ถ้าเก็บ session ไว้ในหน่วยความจำ
// ผู้ใช้จะหลุดล็อกอินทุกครั้งที่เซิร์ฟเวอร์รีสตาร์ท ส่วน JWT ตรวจสอบได้จาก secret
// อย่างเดียวไม่ต้องพึ่งหน่วยความจำ จึงอยู่ได้ทนแม้เซิร์ฟเวอร์จะรีสตาร์ทกี่ครั้งก็ตาม
// -----------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me-before-production';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] ไม่พบตัวแปรแวดล้อม JWT_SECRET — ใช้ค่า default ชั่วคราว (ไม่ปลอดภัยสำหรับใช้งานจริง ต้องตั้งค่าจริงก่อน deploy)');
}
const COOKIE_NAME = 'baandee_token';
const TOKEN_TTL = '30d'; // จำการล็อกอินไว้ 30 วัน ไม่ต้องล็อกอินใหม่ทุกครั้งที่เปิดเว็บ
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, display_name: user.display_name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

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
app.use(cookieParser());

// ต้องล็อกอินก่อนถึงจะเข้าหน้าเว็บหลัก (index.html) ได้ — เช็ค cookie ก่อนที่
// express.static (บรรทัดถัดไป) จะเสิร์ฟไฟล์ ถ้ายังไม่ล็อกอิน/token หมดอายุ ก็เด้ง
// ไปหน้า /login.html แทน หน้า login เองและไฟล์ static อื่นๆ (css/js) ไม่ถูกกันไว้
app.get(['/', '/index.html'], (req, res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return next(); // ล็อกอินอยู่แล้ว ปล่อยให้ express.static เสิร์ฟหน้าเว็บตามปกติ
    } catch (err) {
      res.clearCookie(COOKIE_NAME);
    }
  }
  res.redirect('/login.html');
});

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

// บันทึกประวัติการใช้งาน (หน้า "ประวัติการใช้งาน") — เรียกหลังจากทำรายการสำคัญสำเร็จแล้ว
// เท่านั้น (ไม่เรียกถ้า transaction หลักล้มเหลว) ตั้งใจไม่ throw ถ้าบันทึกประวัติเอง
// ล้มเหลว เพราะไม่อยากให้การบันทึกประวัติ (ฟีเจอร์เสริม) ไปทำให้รายการหลักพังตามไปด้วย
async function logActivity(category, summary, actor, client = pool) {
  try {
    await client.query(
      'INSERT INTO activity_log (category, summary, actor) VALUES ($1, $2, $3)',
      [category, summary, actor || null]
    );
  } catch (err) {
    console.error('[activity_log] บันทึกประวัติไม่สำเร็จ:', err.message);
  }
}

app.get('/api/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

// ========================= AUTH (ล็อกอิน / ล็อกเอาต์) =========================
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  // เช็ค bcrypt.compare เสมอแม้หา user ไม่เจอ (เทียบกับ hash เปล่าๆ) กันไม่ให้เดา
  // จากเวลาตอบกลับได้ว่า username ไหนมีอยู่จริงในระบบหรือไม่ (timing attack)
  const passwordOk = await bcrypt.compare(password, user ? user.password_hash : '$2b$10$invalidsaltinvalidsaltin');
  if (!user || !passwordOk) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.protocol === 'https',
    sameSite: 'lax',
    maxAge: TOKEN_MAX_AGE_MS,
  });
  res.json({ ok: true, user: { id: user.id, username: user.username, display_name: user.display_name } });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ทุก endpoint ใต้ /api ที่ประกาศ "หลัง" บรรทัดนี้ ต้องล็อกอินก่อนถึงจะเรียกได้
// (health/login/logout ที่ประกาศไว้ข้างบนนี้ยังคงเรียกได้โดยไม่ต้องล็อกอิน)
app.use('/api', (req, res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.clearCookie(COOKIE_NAME);
    res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }
});

app.get('/api/me', (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, display_name: req.user.display_name });
});

// แก้ไขบัญชีของตัวเอง (เปลี่ยนชื่อผู้ใช้ / ชื่อที่แสดง / รหัสผ่าน) — ทำได้เฉพาะบัญชีของ
// ตัวเองเท่านั้น (ใช้ req.user.id จาก token เสมอ ไม่รับ id จาก body) เปลี่ยนรหัสผ่านได้
// ก็ต่อเมื่อกรอกรหัสผ่านเดิมถูกต้องเท่านั้น กันคนอื่นแอบมาเปลี่ยนตอนเผลอไม่ได้ล็อกหน้าจอ
app.patch('/api/account', wrap(async (req, res) => {
  const { username, display_name, current_password, new_password } = req.body || {};
  const uname = String(username || '').trim();
  const dname = String(display_name || '').trim();

  if (!uname || !dname) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และชื่อที่แสดง' });
  }
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(uname)) {
    return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องเป็นตัวอักษรภาษาอังกฤษ ตัวเลข หรือ . _ - เท่านั้น (3-30 ตัวอักษร)' });
  }
  if (dname.length > 60) {
    return res.status(400).json({ error: 'ชื่อที่แสดงยาวเกินไป (ไม่เกิน 60 ตัวอักษร)' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้' });

  let password_hash = user.password_hash;
  if (new_password) {
    if (!current_password) {
      return res.status(400).json({ error: 'กรุณากรอกรหัสผ่านเดิมก่อนตั้งรหัสผ่านใหม่' });
    }
    const currentOk = await bcrypt.compare(current_password, user.password_hash);
    if (!currentOk) {
      return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
    }
    password_hash = await bcrypt.hash(new_password, 10);
  }

  let updated;
  try {
    const result = await pool.query(
      'UPDATE users SET username = $1, display_name = $2, password_hash = $3 WHERE id = $4 RETURNING *',
      [uname, dname, password_hash, req.user.id]
    );
    updated = result.rows[0];
  } catch (err) {
    if (err.code === '23505') { // unique_violation — username ซ้ำกับคนอื่น
      return res.status(409).json({ error: 'ชื่อผู้ใช้นี้มีคนใช้แล้ว กรุณาเลือกชื่ออื่น' });
    }
    throw err;
  }

  // บันทึกประวัติเฉพาะสิ่งที่เปลี่ยนจริงๆ — ไม่บันทึกรหัสผ่านจริงๆ ลงประวัติ (ความปลอดภัย)
  // แค่บอกว่า "เปลี่ยนรหัสผ่าน" เฉยๆ
  const changes = [];
  if (user.username !== uname) changes.push(`เปลี่ยนชื่อผู้ใช้เป็น "${uname}"`);
  if (user.display_name !== dname) changes.push(`เปลี่ยนชื่อที่แสดงเป็น "${dname}"`);
  if (new_password) changes.push('เปลี่ยนรหัสผ่าน');
  if (changes.length) {
    await logActivity('account', `แก้ไขข้อมูลบัญชี: ${changes.join(', ')}`, updated.display_name);
  }

  // ออก token ใหม่ทันที เพราะ username/display_name ที่ฝังอยู่ใน token เปลี่ยนไปแล้ว
  // ผู้ใช้จะได้ไม่ต้องล็อกอินใหม่หลังกดบันทึก
  const token = signToken(updated);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.protocol === 'https',
    sameSite: 'lax',
    maxAge: TOKEN_MAX_AGE_MS,
  });
  res.json({ ok: true, user: { id: updated.id, username: updated.username, display_name: updated.display_name } });
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
    await logActivity('equipment', `เพิ่มอุปกรณ์ใหม่: ${name} (${code})`, req.user.display_name);
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

const EQUIPMENT_STATUS_TH = { available: 'พร้อมใช้งาน', reserved: 'จองแล้ว', unavailable: 'ไม่พร้อมใช้งาน' };

app.patch('/api/equipment/:id', async (req, res) => {
  const fields = ['code', 'name', 'category_id', 'stock_qty', 'status', 'image_url'];
  const changedFields = fields.filter((f) => req.body[f] !== undefined);
  const updates = [];
  const params = [];
  for (const f of changedFields) {
    params.push(req.body[f]);
    updates.push(`${f} = $${params.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'ไม่มีข้อมูลให้แก้ไข' });
  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE equipment SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING code, name`,
      params
    );
    if (rows[0]) {
      // ถ้าแก้แค่ "สถานะ" อย่างเดียว บันทึกประวัติเป็นข้อความเฉพาะเรื่องสถานะ ให้เข้าใจง่ายกว่า
      const msg = (changedFields.length === 1 && changedFields[0] === 'status')
        ? `เปลี่ยนสถานะอุปกรณ์: ${rows[0].name} (${rows[0].code}) → ${EQUIPMENT_STATUS_TH[req.body.status] || req.body.status}`
        : `แก้ไขข้อมูลอุปกรณ์: ${rows[0].name} (${rows[0].code})`;
      await logActivity('equipment', msg, req.user.display_name);
    }
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
    const { rows } = await pool.query('DELETE FROM equipment WHERE id = $1 RETURNING code, name', [req.params.id]);
    if (rows[0]) {
      await logActivity('equipment', `ลบอุปกรณ์: ${rows[0].name} (${rows[0].code})`, req.user.display_name);
    }
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
  // created_by ดึงจากผู้ใช้ที่ล็อกอินอยู่จริงเสมอ (ไม่รับค่าจาก client) กันไม่ให้
  // ใครก็ได้ปลอมชื่อคนอื่นตอนสร้างรายการออกบูธ
  const { rows } = await pool.query(
    `INSERT INTO events (name, location, start_date, end_date, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, location || null, start_date || null, end_date || null, req.user.display_name]
  );
  await logActivity('event', `สร้างงานออกบูธใหม่: ${name}`, req.user.display_name);
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

    const { rows: existing } = await client.query('SELECT id, name FROM events WHERE id = $1', [eventId]);
    if (!existing.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบรายการออกบูธนี้' });
    }

    // เอาเฉพาะรายการจองที่ "ยังไม่ถูกยกเลิก" มาคืนสต็อก — ใบจองที่ยกเลิกไปแล้วก่อนหน้านี้
    // คืนสต็อกไปแล้วตอนกดยกเลิก ถ้านับซ้ำตรงนี้อีกสต็อกจะเพี้ยน (เกินจำนวนจริง)
    const { rows: itemsToRestore } = await client.query(
      `SELECT bi.equipment_id, bi.qty
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       WHERE b.event_id = $1 AND b.status != 'cancelled'`,
      [eventId]
    );

    await client.query(
      `DELETE FROM booking_items WHERE booking_id IN (SELECT id FROM bookings WHERE event_id = $1)`,
      [eventId]
    );
    await client.query('DELETE FROM bookings WHERE event_id = $1', [eventId]);
    await client.query('DELETE FROM expenses WHERE event_id = $1', [eventId]);

    // รวมจำนวนที่ต้องคืนต่ออุปกรณ์ 1 ชิ้น (เผื่อกรณีมีหลายใบจองในงานนี้จองอุปกรณ์ชิ้นเดียวกัน)
    const restoreMap = {};
    for (const r of itemsToRestore) {
      restoreMap[r.equipment_id] = (restoreMap[r.equipment_id] || 0) + r.qty;
    }
    for (const [equipmentId, qty] of Object.entries(restoreMap)) {
      await client.query(
        `UPDATE equipment
         SET stock_qty = stock_qty + $1,
             status = CASE
               WHEN status = 'unavailable' THEN status
               WHEN stock_qty + $1 > 0 THEN 'available'
               ELSE 'reserved'
             END
         WHERE id = $2`,
        [qty, equipmentId]
      );
    }

    await client.query('DELETE FROM events WHERE id = $1', [eventId]);
    await logActivity('event', `ลบงานออกบูธ: ${existing[0].name}`, req.user.display_name, client);
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
  const { event_id, items } = req.body; // items: [{equipment_id, qty}]
  if (!items || !items.length) return res.status(400).json({ error: 'ต้องเลือกอุปกรณ์อย่างน้อย 1 รายการ' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ตรวจสต็อกจริงของทุกชิ้นก่อนสร้างใบจอง — ล็อกแถว (FOR UPDATE) ไว้จนกว่า
    // transaction นี้จะจบ กันกรณีจองพร้อมกันหลายคนแล้วสต็อกติดลบ (race condition)
    // ถ้าชิ้นไหนของไม่พอ หรือถูกตั้งเป็น "ไม่พร้อมใช้งาน" ไว้ ยกเลิกทั้งใบจองทันที
    for (const item of items) {
      const qty = item.qty || 1;
      const { rows: eq } = await client.query(
        'SELECT name, stock_qty, status FROM equipment WHERE id = $1 FOR UPDATE',
        [item.equipment_id]
      );
      if (!eq.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ไม่พบอุปกรณ์ที่เลือกไว้ในรายการ' });
      }
      if (eq[0].status === 'unavailable') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `"${eq[0].name}" ไม่พร้อมใช้งานในขณะนี้ จองไม่ได้` });
      }
      if (eq[0].stock_qty < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `"${eq[0].name}" เหลือไม่พอ (คงเหลือ ${eq[0].stock_qty} ชิ้น แต่พยายามจอง ${qty} ชิ้น)`,
        });
      }
    }

    // created_by ดึงจากผู้ใช้ที่ล็อกอินอยู่จริงเสมอ (ไม่รับค่าจาก client) เหมือนกับ /api/events
    const { rows } = await client.query(
      `INSERT INTO bookings (event_id, created_by, status) VALUES ($1, $2, 'pending') RETURNING id`,
      [event_id || null, req.user.display_name]
    );
    const bookingId = rows[0].id;

    for (const item of items) {
      const qty = item.qty || 1;
      await client.query(
        `INSERT INTO booking_items (booking_id, equipment_id, qty) VALUES ($1, $2, $3)`,
        [bookingId, item.equipment_id, qty]
      );
      // ตัดสต็อกจริง — ถ้าตัดแล้วเหลือ 0 พอดี เปลี่ยนสถานะเป็น "จองแล้ว" ให้อัตโนมัติ
      // (ผ่านการเช็คไปแล้วด้านบนว่าไม่ใช่ 'unavailable' จึงตั้งเป็น 'available'/'reserved' ได้เลย)
      await client.query(
        `UPDATE equipment
         SET stock_qty = stock_qty - $1,
             status = CASE WHEN stock_qty - $1 <= 0 THEN 'reserved' ELSE 'available' END
         WHERE id = $2`,
        [qty, item.equipment_id]
      );
    }

    // หาชื่องานออกบูธมาใส่ในข้อความประวัติ ให้อ่านแล้วรู้เลยว่าใบจองนี้เป็นของงานไหน
    let eventLabel = '';
    if (event_id) {
      const { rows: evRows } = await client.query('SELECT name FROM events WHERE id = $1', [event_id]);
      if (evRows[0]) eventLabel = ` สำหรับงาน "${evRows[0].name}"`;
    }
    await logActivity('booking', `สร้างใบจองอุปกรณ์ใหม่${eventLabel} (${items.length} รายการ)`, req.user.display_name, client);

    await client.query('COMMIT');
    res.status(201).json({ id: bookingId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

const BOOKING_STATUS_TH = { pending: 'รอดำเนินการ', confirmed: 'ยืนยันแล้ว', cancelled: 'ยกเลิกแล้ว' };

app.patch('/api/bookings/:id', wrap(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE OF b — ล็อกเฉพาะแถวของตาราง bookings เท่านั้น เพราะ Postgres ไม่ยอมให้
    // FOR UPDATE ทำงานกับฝั่งที่เป็น nullable ของ LEFT JOIN (ตาราง events อาจไม่มีแถวคู่)
    const { rows: existing } = await client.query(
      `SELECT b.status, ev.name AS event_name
       FROM bookings b LEFT JOIN events ev ON ev.id = b.event_id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [req.params.id]
    );
    if (!existing.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบใบจองนี้' });
    }

    // คืนสต็อกให้อุปกรณ์ทุกชิ้นในใบจองนี้ตอนเปลี่ยนเป็น "ยกเลิก" เท่านั้น และทำแค่
    // ครั้งเดียว (เช็คว่าก่อนหน้านี้ยังไม่ได้ถูกยกเลิกไว้อยู่แล้ว) กันคืนสต็อกซ้ำซ้อน
    if (status === 'cancelled' && existing[0].status !== 'cancelled') {
      const { rows: items } = await client.query(
        'SELECT equipment_id, qty FROM booking_items WHERE booking_id = $1',
        [req.params.id]
      );
      for (const item of items) {
        // ไม่แตะสถานะ 'unavailable' (เป็น flag ที่พนักงานตั้งเองว่าอุปกรณ์ชำรุด/ใช้ไม่ได้
        // ไม่เกี่ยวกับจำนวนสต็อก) ส่วนกรณีอื่นคำนวณสถานะใหม่จากจำนวนคงเหลือหลังคืนสต็อก
        await client.query(
          `UPDATE equipment
           SET stock_qty = stock_qty + $1,
               status = CASE
                 WHEN status = 'unavailable' THEN status
                 WHEN stock_qty + $1 > 0 THEN 'available'
                 ELSE 'reserved'
               END
           WHERE id = $2`,
          [item.qty, item.equipment_id]
        );
      }
    }

    await client.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, req.params.id]);

    if (existing[0].status !== status) {
      const eventLabel = existing[0].event_name ? ` (งาน "${existing[0].event_name}")` : '';
      const verb = status === 'confirmed' ? 'ยืนยันใบจองอุปกรณ์'
        : status === 'cancelled' ? 'ยกเลิกใบจองอุปกรณ์'
        : `เปลี่ยนสถานะใบจองเป็น "${BOOKING_STATUS_TH[status]}"`;
      await logActivity('booking', `${verb}${eventLabel}`, req.user.display_name, client);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  const { rows: catRows } = await pool.query('SELECT name FROM expense_categories WHERE id = $1', [category_id]);
  const catName = catRows[0]?.name || 'ไม่ระบุหมวด';
  const amountLabel = Number(amount).toLocaleString('th-TH');
  await logActivity('expense', `เพิ่มค่าใช้จ่าย: ${catName} จำนวน ${amountLabel} บาท${description ? ' — ' + description : ''}`, req.user.display_name);
  res.status(201).json({ id: rows[0].id });
}));

app.delete('/api/expenses/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT x.amount, x.description, c.name AS category_name
     FROM expenses x JOIN expense_categories c ON c.id = x.category_id
     WHERE x.id = $1`,
    [req.params.id]
  );
  await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
  if (rows[0]) {
    const amountLabel = Number(rows[0].amount).toLocaleString('th-TH');
    await logActivity('expense', `ลบค่าใช้จ่าย: ${rows[0].category_name} จำนวน ${amountLabel} บาท`, req.user.display_name);
  }
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

// ========================= ACTIVITY LOG (ประวัติการใช้งาน) =========================
// แบ่งหน้าแบบ cursor (before=<id ล่าสุดที่โหลดไปแล้ว>) แทน offset/page เพราะข้อมูลใหม่
// จะถูกเพิ่มเข้ามาเรื่อยๆ ระหว่างที่ผู้ใช้กำลังกด "โหลดเพิ่ม" — แบบ id ไม่มีปัญหารายการ
// ซ้ำ/หายเวลาเลื่อนหน้า ต่างจาก offset ที่จะเพี้ยนถ้ามีรายการใหม่แทรกเข้ามาระหว่างนั้น
app.get('/api/activity-log', wrap(async (req, res) => {
  const { category, before } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  let sql = 'SELECT * FROM activity_log WHERE 1=1';
  const params = [];
  if (category && category !== 'all') {
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }
  if (before) {
    params.push(before);
    sql += ` AND id < $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY id DESC LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);
  res.json({ items: rows, hasMore: rows.length === limit });
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
