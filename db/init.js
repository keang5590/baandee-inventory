// db/init.js
// -----------------------------------------------------------------------
// เชื่อมต่อฐานข้อมูล PostgreSQL (ผ่านตัวแปรแวดล้อม DATABASE_URL) แล้วสร้าง
// ตารางทั้งหมด + เติมข้อมูลตัวอย่างให้อัตโนมัติถ้าฐานข้อมูลยังว่างอยู่
//
// ทำไมถึงย้ายจาก SQLite มา Postgres: บน Render (และ cloud host ส่วนใหญ่)
// ดิสก์ของ web service เป็นแบบชั่วคราว (ephemeral) — ไฟล์ SQLite จะหายทุกครั้ง
// ที่ deploy ใหม่ ถ้าอยากให้ข้อมูลอยู่ถาวรและใช้งานพร้อมกันหลายคนได้จริง ต้อง
// ใช้ฐานข้อมูลแยกต่างหาก (managed database) แบบ Postgres นี้
// -----------------------------------------------------------------------
const { Pool, types } = require('pg');

// ค่ามาตรฐานของ pg จะแปลงคอลัมน์ DATE เป็น JS Date object ซึ่งมักเพี้ยนวันที่
// เพราะปัญหา timezone ตอนแปลงกลับเป็น string — เราจึงสั่งให้ส่งค่ากลับเป็น
// string 'YYYY-MM-DD' ตรงๆ เหมือนตอนใช้ SQLite
types.setTypeParser(1082, (val) => val); // OID 1082 = DATE
// คอลัมน์ NUMERIC (เช่นจำนวนเงิน) ปกติ pg จะส่งเป็น string เพื่อกันพลาดเรื่อง
// ทศนิยม แต่แอปนี้ไม่ได้ต้องการความละเอียดระดับนั้น เลยแปลงเป็นตัวเลขให้เลย
types.setTypeParser(1700, (val) => parseFloat(val)); // OID 1700 = NUMERIC

if (!process.env.DATABASE_URL) {
  console.error('[db] ไม่พบตัวแปรแวดล้อม DATABASE_URL — ต้องชี้ไปที่ฐานข้อมูล PostgreSQL ก่อนรัน');
  console.error('[db] รันในเครื่อง: `docker compose up -d` แล้วก็อปค่าใน .env.example ไปเป็น .env');
  process.exit(1);
}

// Postgres แบบ managed (Render, Heroku ฯลฯ) ต้องต่อผ่าน SSL แต่ Postgres ที่รัน
// ในเครื่อง (docker-compose) มักไม่ได้เปิด SSL ไว้ เลยเช็คจาก host อัตโนมัติ
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] เกิดข้อผิดพลาดกับ connection pool:', err.message);
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      icon  TEXT DEFAULT '📦'
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id           SERIAL PRIMARY KEY,
      code         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      category_id  INTEGER REFERENCES categories(id),
      image_url    TEXT,
      stock_qty    INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available','reserved','unavailable')),
      created_at   TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      location    TEXT,
      start_date  DATE,
      end_date    DATE,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id          SERIAL PRIMARY KEY,
      event_id    INTEGER REFERENCES events(id),
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','confirmed','cancelled')),
      created_by  TEXT,
      created_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS booking_items (
      id            SERIAL PRIMARY KEY,
      booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      equipment_id  INTEGER NOT NULL REFERENCES equipment(id),
      qty           INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS expense_categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      icon  TEXT DEFAULT '💰'
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id             SERIAL PRIMARY KEY,
      category_id    INTEGER NOT NULL REFERENCES expense_categories(id),
      event_id       INTEGER REFERENCES events(id),
      equipment_id   INTEGER REFERENCES equipment(id),
      description    TEXT,
      amount         NUMERIC(12,2) NOT NULL,
      expense_date   DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at     TIMESTAMPTZ DEFAULT now()
    );
  `);

  // -----------------------------------------------------------------------
  // เก็บรูปอุปกรณ์ "ถาวร" ไว้ในฐานข้อมูล Postgres เอง (คอลัมน์ BYTEA) แทนการ
  // เซฟไฟล์ลงดิสก์ของ web service เพราะดิสก์ของ Render (แผนฟรี) เป็นแบบชั่วคราว
  // ไฟล์จะหายทุกครั้งที่ deploy ใหม่ — ส่วน Postgres เป็นฐานข้อมูลแยกต่างหาก
  // ที่อยู่ถาวรอยู่แล้ว ใช้ ALTER TABLE ... ADD COLUMN IF NOT EXISTS เพื่อให้รันซ้ำ
  // ได้ทุกครั้งที่เซิร์ฟเวอร์เริ่มทำงานโดยไม่พังถ้าคอลัมน์มีอยู่แล้ว (migration แบบง่าย)
  await pool.query(`
    ALTER TABLE equipment ADD COLUMN IF NOT EXISTS image_data BYTEA;
    ALTER TABLE equipment ADD COLUMN IF NOT EXISTS image_mime TEXT;
    ALTER TABLE equipment ADD COLUMN IF NOT EXISTS image_version INTEGER NOT NULL DEFAULT 0;
  `);
  // ล้างค่า image_url เก่าที่เคยชี้ไปที่ไฟล์บนดิสก์ (/uploads/...) ทิ้ง เพราะไฟล์พวกนั้น
  // หายไปแล้วตั้งแต่ deploy ครั้งก่อนๆ (เก็บไว้จะกลายเป็นลิงก์รูปที่เสีย) — ทำเฉพาะแถวที่
  // ยังไม่มี image_data ใหม่ (ยังไม่เคยอัปโหลดซ้ำด้วยระบบเก็บถาวรตัวนี้)
  await pool.query(`UPDATE equipment SET image_url = NULL WHERE image_url LIKE '/uploads/%' AND image_data IS NULL`);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM equipment');
  if (rows[0].count === 0) {
    console.log('[db] ฐานข้อมูลว่างเปล่า กำลังเติมข้อมูลตัวอย่าง...');
    await seed();
    console.log('[db] เติมข้อมูลตัวอย่างเรียบร้อย');
  }
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catIds = {};
    const categories = [
      ['เคาน์เตอร์ / โต๊ะ', '⬜'],
      ['ชั้นวาง / โครงสร้าง', '🧍'],
      ['ตู้ / อุปกรณ์', '🗄️'],
    ];
    for (const [name, icon] of categories) {
      const { rows } = await client.query(
        'INSERT INTO categories (name, icon) VALUES ($1, $2) RETURNING id',
        [name, icon]
      );
      catIds[name] = rows[0].id;
    }

    const equipment = [
      ['CT-001', 'เคาน์เตอร์หน้าตรง', catIds['เคาน์เตอร์ / โต๊ะ'], 4, 'available'],
      ['SH-002', 'ชั้นวางเอนกประสงค์', catIds['ชั้นวาง / โครงสร้าง'], 4, 'available'],
      ['SH-003', 'ชั้นวางสินค้าใส', catIds['ชั้นวาง / โครงสร้าง'], 4, 'available'],
      ['SH-004', 'ชั้นวางโปรโมชั่น', catIds['ชั้นวาง / โครงสร้าง'], 10, 'available'],
      ['CT-005', 'เคาน์เตอร์ทรงเหลี่ยม', catIds['เคาน์เตอร์ / โต๊ะ'], 6, 'available'],
      ['CT-006', 'เคาน์เตอร์จับอุปกรณ์', catIds['เคาน์เตอร์ / โต๊ะ'], 2, 'available'],
      ['DS-007', 'ตู้ป๊อปคอร์น', catIds['ตู้ / อุปกรณ์'], 2, 'available'],
      ['CT-008', 'เคาน์เตอร์โลโก้', catIds['เคาน์เตอร์ / โต๊ะ'], 2, 'available'],
    ];
    for (const [code, name, category_id, stock_qty, status] of equipment) {
      await client.query(
        `INSERT INTO equipment (code, name, category_id, stock_qty, status) VALUES ($1, $2, $3, $4, $5)`,
        [code, name, category_id, stock_qty, status]
      );
    }

    const { rows: evRows } = await client.query(
      `INSERT INTO events (name, location, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id`,
      ['งานบ้านและสวนแฟร์ 2024', 'ไบเทค บางนา', '2024-07-20', '2024-07-28']
    );
    const eventId = evRows[0].id;

    const expCatIds = {};
    const expenseCategories = [
      ['ค่าเช่าพื้นที่บูธ', '🏢'],
      ['ค่าขนส่งอุปกรณ์', '🚚'],
      ['ค่าติดตั้ง / รื้อถอน', '🛠️'],
      ['ค่าเช่าอุปกรณ์เพิ่มเติม', '📦'],
      ['ค่าไฟ / สาธารณูปโภค', '💡'],
      ['ค่าแรงพนักงาน', '👷'],
      ['อื่นๆ', '📝'],
    ];
    for (const [name, icon] of expenseCategories) {
      const { rows } = await client.query(
        'INSERT INTO expense_categories (name, icon) VALUES ($1, $2) RETURNING id',
        [name, icon]
      );
      expCatIds[name] = rows[0].id;
    }

    const expenses = [
      [expCatIds['ค่าเช่าพื้นที่บูธ'], eventId, 'ค่าเช่าพื้นที่ 9 วัน', 45000, '2024-07-15'],
      [expCatIds['ค่าขนส่งอุปกรณ์'], eventId, 'รถขนของไปกลับไบเทค', 6500, '2024-07-19'],
      [expCatIds['ค่าติดตั้ง / รื้อถอน'], eventId, 'ทีมช่างติดตั้งบูธ', 8000, '2024-07-19'],
      [expCatIds['ค่าเช่าอุปกรณ์เพิ่มเติม'], eventId, 'เช่าตู้ป๊อปคอร์นเพิ่ม 1 ตู้', 1500, '2024-07-20'],
    ];
    for (const [category_id, event_id, description, amount, expense_date] of expenses) {
      await client.query(
        `INSERT INTO expenses (category_id, event_id, description, amount, expense_date)
         VALUES ($1, $2, $3, $4, $5)`,
        [category_id, event_id, description, amount, expense_date]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
