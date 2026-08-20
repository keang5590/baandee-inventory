// public/app.js
// -----------------------------------------------------------------------
// Vanilla JS ล้วนๆ ไม่มี framework — ทำหน้าที่:
//   1) สลับแท็บ (tab) ต่างๆ ในหน้าเดียว (Single Page App แบบง่าย)
//   2) เรียก API (fetch) ไปที่ server.js เพื่อโหลด/บันทึกข้อมูลจริงจาก SQLite
//   3) วาด (render) การ์ดอุปกรณ์ ตะกร้าจอง และตารางค่าใช้จ่าย
// -----------------------------------------------------------------------

const state = {
  categories: [],
  equipment: [],
  events: [],
  expenseCategories: [],
  cart: {}, // { equipment_id: qty }
  activeEventId: null, // งานออกบูธที่กำลังเตรียมอยู่ตอนนี้
  currentUser: null, // ผู้ใช้ที่ล็อกอินอยู่ตอนนี้ { id, username, display_name }
};

// ---------- helper: เรียก API ----------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    // token หมดอายุ/ไม่ได้ล็อกอิน ระหว่างใช้งานอยู่ — เด้งกลับไปหน้า login ทันที
    window.location.href = '/login.html';
    throw new Error('กรุณาเข้าสู่ระบบ');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'เกิดข้อผิดพลาด' }));
    throw new Error(err.error || 'เกิดข้อผิดพลาด');
  }
  return res.status === 204 ? null : res.json();
}

const money = (n) => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ========================================================================
// TAB SWITCHING
// ========================================================================
function initTabs() {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = el.dataset.tab;
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(`tab-${tab}`).classList.remove('hidden');

      if (tab === 'expenses') loadExpensesTab();
      if (tab === 'bookings') loadBookingsTab();
      if (tab === 'home') loadHomeTab();
      if (tab === 'mybooths') loadMyBoothsTab();
      if (tab === 'warehouse') loadWarehouseTab();
      if (tab === 'settings') loadSettingsForm();

      closeSidebarDrawer(); // มือถือ: เลือกแท็บแล้วปิดเมนูด้านข้างให้อัตโนมัติ (ไม่มีผลอะไรบนจอเดสก์ท็อป)
    });
  });
}

// ========================================================================
// เมนูด้านข้างบนมือถือ/แท็บเล็ต (hamburger drawer)
// บนจอกว้าง (เดสก์ท็อป) sidebar แสดงตลอดเวลาอยู่แล้วตาม CSS ปกติ ฟังก์ชันพวกนี้
// มีผลจริงๆ แค่ตอนจอแคบ (ดู media query ใน style.css) — เรียกใช้ได้อย่างปลอดภัย
// ทุกขนาดจอเพราะแค่ toggle class เฉยๆ ไม่กระทบ layout บนเดสก์ท็อป
// ========================================================================
function openSidebarDrawer() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
}
function closeSidebarDrawer() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}
function initSidebarDrawer() {
  document.getElementById('btnHamburger').addEventListener('click', openSidebarDrawer);
  document.getElementById('btnCloseSidebar').addEventListener('click', closeSidebarDrawer);
  document.getElementById('sidebarOverlay').addEventListener('click', closeSidebarDrawer);
}

// ========================================================================
// TAB: อุปกรณ์ทั้งหมด
// ========================================================================
async function loadCategories() {
  state.categories = await api('/api/categories');
  const wrap = document.getElementById('categoryFilters');
  state.categories.forEach((c) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.cat = c.id;
    btn.textContent = `${c.icon || '📦'} ${c.name}`;
    btn.addEventListener('click', () => {
      document.querySelectorAll('#categoryFilters .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadEquipment();
    });
    wrap.appendChild(btn);
  });
  document.querySelector('#categoryFilters .chip[data-cat=""]').addEventListener('click', (e) => {
    document.querySelectorAll('#categoryFilters .chip').forEach((b) => b.classList.remove('active'));
    e.target.classList.add('active');
    loadEquipment();
  });
}

async function loadEquipment() {
  const q = document.getElementById('searchBox').value.trim();
  const activeChip = document.querySelector('#categoryFilters .chip.active');
  const category_id = activeChip ? activeChip.dataset.cat : '';
  const status = document.getElementById('statusFilter').value;
  const sort = document.getElementById('sortFilter').value;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category_id) params.set('category_id', category_id);
  if (status) params.set('status', status);

  let list = await api(`/api/equipment?${params.toString()}`);

  if (sort === 'stock_asc') list = list.sort((a, b) => a.stock_qty - b.stock_qty);
  else if (sort === 'name_asc') list = list.sort((a, b) => a.name.localeCompare(b.name, 'th'));

  state.equipment = list;
  renderEquipmentGrid();
}

const statusLabel = { available: ['green', 'พร้อมใช้งาน'], reserved: ['yellow', 'จองแล้ว / รอตรวจสอบ'], unavailable: ['red', 'ไม่พร้อมใช้งาน'] };

function renderEquipmentGrid() {
  const grid = document.getElementById('equipmentGrid');
  grid.innerHTML = '';
  if (!state.equipment.length) {
    grid.innerHTML = '<div class="empty-hint">ไม่พบอุปกรณ์ที่ค้นหา</div>';
    return;
  }
  for (const item of state.equipment) {
    const [dotClass, label] = statusLabel[item.status] || statusLabel.available;
    const qty = state.cart[item.id] || 0;

    const thumbInner = item.image_url
      ? `<img src="${item.image_url}" alt="${item.name}" />`
      : (item.category_icon || '📦');

    const card = document.createElement('div');
    card.className = 'eq-card';
    card.innerHTML = `
      <div class="eq-thumb">
        ${thumbInner}
        <button class="eq-photo-btn" type="button" title="อัปโหลดรูปอุปกรณ์">📷</button>
        <input type="file" class="eq-photo-input" accept="image/*" hidden />
      </div>
      <div class="eq-body">
        <div class="eq-name">${item.name}</div>
        <div class="eq-code">รหัส: ${item.code}</div>
        <div class="eq-stock">คงเหลือ: ${item.stock_qty} ชิ้น</div>
        <div class="eq-status"><span class="status-dot ${dotClass}"></span>${label}</div>
        <div class="qty-row">
          <button class="qty-minus">−</button>
          <input type="text" class="qty-val" value="${qty}" readonly />
          <button class="qty-plus">+</button>
          <button class="cart-add" title="เพิ่มลงตะกร้า">🛒</button>
        </div>
      </div>
    `;
    const qtyInput = card.querySelector('.qty-val');
    card.querySelector('.qty-minus').addEventListener('click', () => {
      const v = Math.max(0, Number(qtyInput.value) - 1);
      qtyInput.value = v;
    });
    card.querySelector('.qty-plus').addEventListener('click', () => {
      const v = Math.min(item.stock_qty, Number(qtyInput.value) + 1);
      qtyInput.value = v;
    });
    card.querySelector('.cart-add').addEventListener('click', () => {
      const v = Number(qtyInput.value);
      if (v > 0) {
        state.cart[item.id] = v;
      } else {
        delete state.cart[item.id];
      }
      renderCart();
    });

    // อัปโหลดรูปอุปกรณ์: กดปุ่มกล้อง -> เปิด file picker -> เลือกไฟล์แล้วอัปโหลดทันที
    const photoInput = card.querySelector('.eq-photo-input');
    card.querySelector('.eq-photo-btn').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', () => uploadEquipmentPhoto(item.id, photoInput, card));

    grid.appendChild(card);
  }
}

async function uploadEquipmentPhoto(equipmentId, inputEl, cardEl) {
  const file = inputEl.files[0];
  if (!file) return;

  const thumb = cardEl.querySelector('.eq-thumb');
  const originalContent = thumb.innerHTML;
  thumb.innerHTML = '<span class="eq-photo-loading">กำลังอัปโหลด...</span>';

  try {
    const formData = new FormData();
    formData.append('image', file);
    // หมายเหตุ: ที่นี่ไม่ใส่ header 'Content-Type' เอง — เบราว์เซอร์จะตั้งให้อัตโนมัติ
    // พร้อม boundary ที่ถูกต้องของ multipart/form-data ถ้าตั้งเองมักจะพังเพราะ boundary หาย
    const res = await fetch(`/api/equipment/${equipmentId}/image`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'อัปโหลดไม่สำเร็จ' }));
      throw new Error(err.error || 'อัปโหลดไม่สำเร็จ');
    }
    const { image_url } = await res.json();

    // อัปเดตข้อมูลในหน่วยความจำ แล้ววาดการ์ดใหม่ทั้งกริดให้ตรงกับฐานข้อมูล
    const item = state.equipment.find((e) => e.id === equipmentId);
    if (item) item.image_url = image_url;
    renderEquipmentGrid();
  } catch (err) {
    alert(err.message);
    thumb.innerHTML = originalContent;
  }
}

function renderCart() {
  const list = document.getElementById('cartList');
  const ids = Object.keys(state.cart);
  document.getElementById('cartCount').textContent = ids.length;
  document.getElementById('sideCartBadge').textContent = ids.length;
  document.getElementById('cartItemCount').textContent = `${ids.length} รายการ`;
  const totalQty = Object.values(state.cart).reduce((a, b) => a + b, 0);
  document.getElementById('cartTotalQty').textContent = `${totalQty} ชิ้น`;

  if (!ids.length) {
    list.innerHTML = '<div class="empty-hint">ยังไม่มีอุปกรณ์ที่เลือก</div>';
    return;
  }
  list.innerHTML = '';
  for (const id of ids) {
    const item = state.equipment.find((e) => String(e.id) === String(id));
    const row = document.createElement('div');
    row.className = 'cart-item';
    row.innerHTML = `<span>${item ? item.name : `#${id}`}</span><span>${state.cart[id]} ชิ้น</span>`;
    list.appendChild(row);
  }
}

async function submitBooking() {
  const ids = Object.keys(state.cart);
  if (!ids.length) {
    alert('กรุณาเลือกอุปกรณ์อย่างน้อย 1 รายการ');
    return;
  }
  if (!state.activeEventId) {
    alert('กรุณาสร้าง หรือเลือก "รายการออกบูธ" ที่กำลังเตรียมงานก่อน (ปุ่ม + สร้างรายการออกบูธใหม่ ที่แถบด้านซ้าย)');
    return;
  }
  const items = ids.map((id) => ({ equipment_id: Number(id), qty: state.cart[id] }));
  try {
    await api('/api/bookings', {
      method: 'POST',
      // created_by ไม่ต้องส่งจากฝั่งนี้แล้ว — เซิร์ฟเวอร์ดึงชื่อจากผู้ใช้ที่ล็อกอินอยู่ให้เองอัตโนมัติ
      body: JSON.stringify({ event_id: state.activeEventId, items }),
    });
  } catch (err) {
    // เซิร์ฟเวอร์ตรวจสต็อกจริงก่อนบันทึกเสมอ — ถ้าของไม่พอ/ไม่พร้อมใช้งาน จะ throw ข้อความ
    // ภาษาไทยที่อ่านเข้าใจได้เลยกลับมา (เช่น "... เหลือไม่พอ (คงเหลือ X ชิ้น...)")
    alert(err.message);
    return;
  }
  state.cart = {};
  renderCart();
  await loadEquipment();
  alert('สร้างรายการจองเรียบร้อยแล้ว ✅ ดูได้ที่แท็บ "การจองอุปกรณ์"');
}

// ========================================================================
// TAB: หมวดค่าใช้จ่าย (ฟีเจอร์ใหม่ที่เพิ่มให้)
// ========================================================================
async function loadExpenseCategories() {
  state.expenseCategories = await api('/api/expense-categories');
  const formSelect = document.getElementById('expenseFormCategory');
  formSelect.innerHTML = state.expenseCategories
    .map((c) => `<option value="${c.id}">${c.icon || '💰'} ${c.name}</option>`)
    .join('');
}

async function loadEventOptions() {
  state.events = await api('/api/events'); // เรียงจากใหม่สุดไปเก่าสุด (ดู server.js: ORDER BY id DESC)
  const evFilter = document.getElementById('expenseEventFilter');
  const evForm = document.getElementById('expenseFormEvent');
  const opts = state.events.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  evFilter.innerHTML = '<option value="">ทุกงานออกบูธ</option>' + opts;
  evForm.innerHTML = '<option value="">— ไม่ระบุ —</option>' + opts;

  // ถ้ายังไม่เคยเลือกงานออกบูธที่ใช้งานอยู่ (หรืองานที่เคยเลือกถูกลบไปแล้ว) ให้ใช้งานล่าสุดเป็นค่าเริ่มต้น
  const stillExists = state.events.some((e) => e.id === state.activeEventId);
  if (!stillExists) {
    state.activeEventId = state.events[0] ? state.events[0].id : null;
  }
  renderActiveEventBox();
}

function renderActiveEventBox() {
  const nameEl = document.getElementById('eventName');
  const metaEl = document.getElementById('eventMeta');
  const active = state.events.find((e) => e.id === state.activeEventId);
  if (!active) {
    nameEl.textContent = 'ยังไม่มีรายการออกบูธ';
    metaEl.textContent = 'กด "+ สร้างรายการออกบูธใหม่" ที่แถบด้านซ้ายเพื่อเริ่มต้น';
    return;
  }
  nameEl.textContent = active.name;
  const dateRange = [active.start_date, active.end_date].filter(Boolean).join(' – ');
  metaEl.textContent = [dateRange, active.location].filter(Boolean).join(' • ') || 'ยังไม่ระบุวันที่/สถานที่';
}

async function loadExpensesTab() {
  await Promise.all([loadExpenseCategories(), loadEventOptions()]);
  await renderExpenseSummary();
  await renderExpenseTable();
}

async function renderExpenseSummary() {
  const eventId = document.getElementById('expenseEventFilter').value;
  const params = eventId ? `?event_id=${eventId}` : '';
  const { byCategory, grandTotal } = await api(`/api/expenses/summary${params}`);

  const wrap = document.getElementById('expenseSummaryCards');
  wrap.innerHTML = byCategory
    .map(
      (c) => `
      <div class="exp-card">
        <div class="exp-icon">${c.category_icon || '💰'}</div>
        <div class="exp-name">${c.category_name}</div>
        <div class="exp-amount">฿${money(c.total)}</div>
      </div>`
    )
    .join('');

  document.getElementById('expenseGrandTotal').textContent = money(grandTotal);
  document.getElementById('expenseTotalBig').textContent = `฿${money(grandTotal)}`;

  const breakdown = document.getElementById('expenseCatBreakdown');
  breakdown.innerHTML = byCategory
    .filter((c) => c.total > 0)
    .map(
      (c) => `<div class="side-row"><span>${c.category_icon || ''} ${c.category_name}</span><span>฿${money(c.total)}</span></div>`
    )
    .join('');

  renderExpenseChart(byCategory);
}

let expenseChartInstance = null; // อ้างอิง Chart.js instance ปัจจุบัน — ต้อง destroy() ก่อนวาดใหม่ทุกครั้ง
// กันปัญหา "Canvas is already in use" ตอนสลับแท็บ/เปลี่ยนตัวกรองงานออกบูธซ้ำๆ

function renderExpenseChart(byCategory) {
  const canvas = document.getElementById('expenseChart');
  const emptyHint = document.getElementById('expenseChartEmpty');
  const rows = byCategory.filter((c) => c.total > 0); // หมวดที่ยังไม่มีค่าใช้จ่ายเลย ไม่ต้องโชว์แท่งเปล่าๆ

  if (expenseChartInstance) {
    expenseChartInstance.destroy();
    expenseChartInstance = null;
  }

  if (!rows.length) {
    canvas.classList.add('hidden');
    emptyHint.classList.remove('hidden');
    return;
  }
  canvas.classList.remove('hidden');
  emptyHint.classList.add('hidden');

  // ความสูงกราฟปรับตามจำนวนหมวด กันแท่งอัดกันแน่นเกินไปถ้ามีหลายหมวด
  canvas.parentElement.style.height = `${Math.max(120, rows.length * 40)}px`;

  const labels = rows.map((c) => `${c.category_icon || '💰'} ${c.category_name}`);
  const totals = rows.map((c) => c.total);

  expenseChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data: totals,
          backgroundColor: '#f5b400', // สีเดียวทั้งกราฟ — เป็นข้อมูลชุดเดียว (ยอดค่าใช้จ่าย) ไม่ใช่หลายซีรีส์
          borderRadius: 4,
          borderSkipped: 'start', // มุมโค้งเฉพาะปลายแท่ง ฝั่งฐาน (แกน y) เหลี่ยมตามปกติ
          maxBarThickness: 24,
          categoryPercentage: 0.7,
        },
      ],
    },
    options: {
      indexAxis: 'y', // แท่งแนวนอน — อ่านชื่อหมวดหมู่ภาษาไทยยาวๆ ได้ง่ายกว่าแนวตั้ง
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }, // มีข้อมูลชุดเดียว ไม่ต้องมี legend (ชื่อหมวดอยู่ที่แกนอยู่แล้ว)
        tooltip: {
          callbacks: {
            label: (ctx) => `฿${money(ctx.parsed.x)}`,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: '#e7e8eb' }, // เส้นกริดจางๆ สีเดียวกับ --border ในธีมหลัก
          ticks: {
            color: '#8a8f98',
            callback: (v) => `฿${Number(v).toLocaleString('th-TH')}`,
          },
        },
        y: {
          grid: { display: false },
          ticks: { color: '#222' },
        },
      },
    },
  });
}

async function renderExpenseTable() {
  const eventId = document.getElementById('expenseEventFilter').value;
  const params = eventId ? `?event_id=${eventId}` : '';
  const rows = await api(`/api/expenses${params}`);
  const tbody = document.getElementById('expenseTableBody');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px;">ยังไม่มีรายการค่าใช้จ่าย</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td>${r.expense_date}</td>
        <td>${r.category_icon || ''} ${r.category_name}</td>
        <td>${r.description || '-'}</td>
        <td>${r.event_name || '-'}</td>
        <td>${r.equipment_name || '-'}</td>
        <td class="right">฿${money(r.amount)}</td>
        <td><button class="row-del" data-id="${r.id}">ลบ</button></td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('.row-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('ลบรายการนี้หรือไม่?')) return;
      await api(`/api/expenses/${btn.dataset.id}`, { method: 'DELETE' });
      await renderExpenseSummary();
      await renderExpenseTable();
    });
  });
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function initExpenseModals() {
  document.getElementById('btnAddExpense').addEventListener('click', () => {
    document.getElementById('expenseFormDate').value = new Date().toISOString().slice(0, 10);
    openModal('expenseModal');
  });
  document.getElementById('btnCancelExpense').addEventListener('click', () => closeModal('expenseModal'));
  document.getElementById('btnSaveExpense').addEventListener('click', async () => {
    const category_id = Number(document.getElementById('expenseFormCategory').value);
    const event_id = document.getElementById('expenseFormEvent').value || null;
    const description = document.getElementById('expenseFormDesc').value.trim();
    const amount = Number(document.getElementById('expenseFormAmount').value);
    const expense_date = document.getElementById('expenseFormDate').value;
    if (!amount || amount <= 0) { alert('กรุณาระบุจำนวนเงินให้ถูกต้อง'); return; }
    await api('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ category_id, event_id, description, amount, expense_date }),
    });
    closeModal('expenseModal');
    document.getElementById('expenseFormDesc').value = '';
    document.getElementById('expenseFormAmount').value = '';
    await renderExpenseSummary();
    await renderExpenseTable();
  });

  document.getElementById('btnAddExpenseCategory').addEventListener('click', () => openModal('categoryModal'));
  document.getElementById('btnCancelCategory').addEventListener('click', () => closeModal('categoryModal'));
  document.getElementById('btnSaveCategory').addEventListener('click', async () => {
    const name = document.getElementById('categoryFormName').value.trim();
    const icon = document.getElementById('categoryFormIcon').value.trim() || '💰';
    if (!name) { alert('กรุณาระบุชื่อหมวดหมู่'); return; }
    await api('/api/expense-categories', { method: 'POST', body: JSON.stringify({ name, icon }) });
    closeModal('categoryModal');
    document.getElementById('categoryFormName').value = '';
    document.getElementById('categoryFormIcon').value = '';
    await loadExpenseCategories();
    await renderExpenseSummary();
  });

  document.getElementById('expenseEventFilter').addEventListener('change', async () => {
    await renderExpenseSummary();
    await renderExpenseTable();
  });
}

// ========================================================================
// TAB: การจองอุปกรณ์
// ========================================================================
async function loadBookingsTab() {
  const rows = await api('/api/bookings');
  const tbody = document.getElementById('bookingsTableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px;">ยังไม่มีการจอง</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (b) => `
      <tr>
        <td>#${b.id}</td>
        <td>${b.event_name || '-'}</td>
        <td>${renderBookingStatusBadge(b.status)}</td>
        <td>${b.items.map((i) => `${i.equipment_name} ×${i.qty}`).join(', ')}</td>
        <td>${b.created_by || '-'}</td>
        <td>${b.created_at}</td>
        <td>${
          b.status === 'cancelled'
            ? '<span class="created-by">ยกเลิกไปแล้ว</span>'
            : `${
                b.status === 'pending'
                  ? `<button class="booking-confirm-btn" data-id="${b.id}">ยืนยันการจอง</button>`
                  : ''
              }<button class="btn-outline sm booking-cancel-btn" data-id="${b.id}">ยกเลิกใบจอง</button>`
        }</td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('.booking-confirm-btn').forEach((btn) => {
    btn.addEventListener('click', () => confirmBooking(Number(btn.dataset.id)));
  });
  tbody.querySelectorAll('.booking-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => cancelBooking(Number(btn.dataset.id)));
  });
}

// สถานะใบจอง: ป้ายสี (badge) แยกตามสถานะให้เห็นชัดตาต่อสถานะ — pending สีส้ม,
// confirmed สีเขียว, cancelled สีแดง
const bookingStatusLabel = { pending: 'รอการยืนยัน', confirmed: 'ยืนยันการจอง', cancelled: 'ยกเลิกการจอง' };
const bookingStatusColor = { pending: 'orange', confirmed: 'green', cancelled: 'red' };

function renderBookingStatusBadge(status) {
  const label = bookingStatusLabel[status] || status;
  const color = bookingStatusColor[status] || 'orange';
  return `<span class="booking-status-badge ${color}">${label}</span>`;
}

async function confirmBooking(id) {
  try {
    await api(`/api/bookings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'confirmed' }),
    });
  } catch (err) {
    alert(err.message);
    return;
  }
  await loadBookingsTab();
}

async function cancelBooking(id) {
  if (!confirm(`ยกเลิกใบจอง #${id} หรือไม่?\nอุปกรณ์ในใบจองนี้จะถูกคืนสต็อกกลับให้อัตโนมัติ`)) return;
  try {
    await api(`/api/bookings/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    });
  } catch (err) {
    alert(err.message);
    return;
  }
  // โหลดตารางการจองใหม่ + รายการอุปกรณ์ใหม่ (สต็อกที่คืนแล้วต้องอัปเดตให้เห็นทันที)
  await loadBookingsTab();
  await loadEquipment();
}

// ========================================================================
// TAB: หน้าหลัก
// ========================================================================
async function loadHomeTab() {
  const [equipment, { grandTotal }, bookings] = await Promise.all([
    api('/api/equipment'),
    api('/api/expenses/summary'),
    api('/api/bookings'),
  ]);
  const totalStock = equipment.reduce((s, e) => s + e.stock_qty, 0);
  document.getElementById('statRow').innerHTML = `
    <div class="stat-box"><div class="label">อุปกรณ์ทั้งหมด</div><div class="value">${equipment.length} รายการ</div></div>
    <div class="stat-box"><div class="label">สต็อกรวม</div><div class="value">${totalStock} ชิ้น</div></div>
    <div class="stat-box"><div class="label">การจองทั้งหมด</div><div class="value">${bookings.length} รายการ</div></div>
    <div class="stat-box"><div class="label">ค่าใช้จ่ายรวม</div><div class="value">฿${money(grandTotal)}</div></div>
  `;
}

// ========================================================================
// TAB: รายการออกบูธของฉัน (สร้าง/เลือกงานออกบูธที่ใช้งานอยู่)
// ========================================================================
async function loadMyBoothsTab() {
  state.events = await api('/api/events');
  renderBoothGrid();
}

function renderBoothGrid() {
  const grid = document.getElementById('boothGrid');
  if (!state.events.length) {
    grid.innerHTML = '<div class="empty-hint">ยังไม่มีรายการออกบูธ กด "+ สร้างรายการออกบูธใหม่" เพื่อเริ่มต้น</div>';
    return;
  }
  grid.innerHTML = '';
  for (const ev of state.events) {
    const isActive = ev.id === state.activeEventId;
    const dateRange = [ev.start_date, ev.end_date].filter(Boolean).join(' – ');
    const card = document.createElement('div');
    card.className = `booth-card${isActive ? ' active' : ''}`;
    card.innerHTML = `
      ${isActive ? '<span class="booth-active-badge">ใช้งานอยู่</span>' : ''}
      <div class="booth-name">${ev.name}</div>
      <div class="booth-meta">${[dateRange, ev.location].filter(Boolean).join(' • ') || 'ยังไม่ระบุวันที่/สถานที่'}</div>
      <div class="created-by">สร้างโดย: ${ev.created_by || '-'}</div>
      <div class="booth-actions">
        ${isActive ? '' : '<button class="btn-outline choose-btn">เลือกใช้งาน</button>'}
        <button class="btn-outline booth-detail-btn">📋 ดูรายการจอง</button>
        <button class="btn-outline booth-del-btn" title="ลบรายการออกบูธนี้">🗑️ ลบ</button>
      </div>
    `;
    card.querySelector('.booth-detail-btn').addEventListener('click', () => openBookingDetail(ev));
    const chooseBtn = card.querySelector('.choose-btn');
    if (chooseBtn) {
      chooseBtn.addEventListener('click', () => {
        state.activeEventId = ev.id;
        renderActiveEventBox();
        renderBoothGrid();
      });
    }
    card.querySelector('.booth-del-btn').addEventListener('click', () => deleteBooth(ev));
    grid.appendChild(card);
  }
}

// ---------- รายละเอียดการจองของงานออกบูธ 1 งาน (ดู + ปริ้น) ----------
// รวมยอดอุปกรณ์เฉพาะใบจองที่ "ยืนยันแล้ว" เป็นรายการเดียว (เหมาะสำหรับเช็คของขึ้นรถ)
// ส่วนใบจองที่ "รอการยืนยัน" แสดงแยกไว้ด้านล่างให้ดูเฉยๆ ไม่นับรวม/ไม่ปริ้น
async function openBookingDetail(ev) {
  const allBookings = await api('/api/bookings');
  const bookingsForEvent = allBookings.filter((b) => b.event_id === ev.id);
  const confirmed = bookingsForEvent.filter((b) => b.status === 'confirmed');
  const pending = bookingsForEvent.filter((b) => b.status === 'pending');

  // รวมยอดอุปกรณ์ชิ้นเดียวกันจากหลายใบจองเป็นแถวเดียว
  const totals = {}; // equipment_id -> { name, code, qty }
  for (const b of confirmed) {
    for (const item of b.items) {
      if (!totals[item.equipment_id]) {
        totals[item.equipment_id] = { name: item.equipment_name, code: item.equipment_code, qty: 0 };
      }
      totals[item.equipment_id].qty += item.qty;
    }
  }
  const totalRows = Object.values(totals).sort((a, b) => a.name.localeCompare(b.name, 'th'));

  const dateRange = [ev.start_date, ev.end_date].filter(Boolean).join(' – ');
  document.getElementById('bdEventName').textContent = `รายการจอง: ${ev.name}`;
  document.getElementById('bdEventMeta').textContent =
    [dateRange, ev.location].filter(Boolean).join(' • ') || 'ยังไม่ระบุวันที่/สถานที่';

  const confirmedBody = document.getElementById('bdConfirmedBody');
  confirmedBody.innerHTML = totalRows.length
    ? totalRows.map((r) => `<tr><td>${r.name}</td><td>${r.code}</td><td class="right">${r.qty}</td></tr>`).join('')
    : '<tr><td colspan="3" style="text-align:center;color:#999;padding:20px;">ยังไม่มีใบจองที่ยืนยันแล้วในงานนี้</td></tr>';

  const pendingSection = document.getElementById('bdPendingSection');
  const pendingBody = document.getElementById('bdPendingBody');
  if (!pending.length) {
    pendingSection.classList.add('hidden');
    pendingBody.innerHTML = '';
  } else {
    pendingSection.classList.remove('hidden');
    pendingBody.innerHTML = pending
      .map(
        (b) => `
        <tr>
          <td>#${b.id}</td>
          <td>${b.items.map((i) => `${i.equipment_name} ×${i.qty}`).join(', ')}</td>
          <td>${b.created_by || '-'}</td>
        </tr>`
      )
      .join('');
  }

  openModal('bookingDetailModal');
}

function initBookingDetailModal() {
  document.getElementById('btnCloseBookingDetail').addEventListener('click', () => closeModal('bookingDetailModal'));
  document.getElementById('btnPrintBookingDetail').addEventListener('click', () => window.print());
}

async function deleteBooth(ev) {
  if (!confirm(`ลบรายการออกบูธ "${ev.name}" หรือไม่?\nการจองอุปกรณ์และค่าใช้จ่ายทั้งหมดที่ผูกกับงานนี้จะถูกลบไปด้วย และลบแล้วกู้คืนไม่ได้`)) {
    return;
  }
  try {
    await api(`/api/events/${ev.id}`, { method: 'DELETE' });
  } catch (err) {
    alert(err.message);
    return;
  }
  // อุปกรณ์ที่เคยถูกจองไว้ในงานนี้ถูกปลดสถานะกลับเป็น "พร้อมใช้งาน" แล้วที่ฝั่งเซิร์ฟเวอร์
  // โหลดรายการงานออกบูธใหม่ (จะจัดการ activeEventId ให้เองถ้างานที่ลบเป็นงานที่กำลังใช้งานอยู่)
  await loadEventOptions();
  renderBoothGrid();
  await loadEquipment();
}

function initBoothModal() {
  const open = () => {
    document.getElementById('boothFormName').value = '';
    document.getElementById('boothFormLocation').value = '';
    document.getElementById('boothFormStart').value = '';
    document.getElementById('boothFormEnd').value = '';
    closeSidebarDrawer(); // ถ้ากดจากเมนูมือถือที่เปิดอยู่ ให้ปิดเมนูไปด้วยตอนเปิด modal
    openModal('boothModal');
  };
  document.getElementById('btnNewBooth').addEventListener('click', open);
  document.getElementById('btnNewBoothInline').addEventListener('click', open);
  document.getElementById('btnCancelBooth').addEventListener('click', () => closeModal('boothModal'));

  document.getElementById('btnSaveBooth').addEventListener('click', async () => {
    const name = document.getElementById('boothFormName').value.trim();
    const location = document.getElementById('boothFormLocation').value.trim();
    const start_date = document.getElementById('boothFormStart').value;
    const end_date = document.getElementById('boothFormEnd').value;
    if (!name) { alert('กรุณาระบุชื่องาน'); return; }

    const { id } = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ name, location, start_date, end_date }),
    });
    state.activeEventId = id; // งานที่เพิ่งสร้างกลายเป็นงานที่ใช้งานอยู่ทันที
    closeModal('boothModal');

    await loadEventOptions();
    renderBoothGrid();
    alert(`สร้างรายการออกบูธ "${name}" เรียบร้อยแล้ว ✅ ตอนนี้กำลังใช้งานอยู่`);
  });
}

// ========================================================================
// TAB: คลังอุปกรณ์ (จัดการสต็อก — เพิ่ม/แก้ไข/ลบอุปกรณ์)
// ใช้ /api/equipment ตัวเดียวกับแท็บ "อุปกรณ์ทั้งหมด" — เพียงแต่แท็บนี้แสดงเป็น
// ตารางจัดการสต็อกแทนที่จะเป็นกริดสำหรับเลือกอุปกรณ์ไปออกบูธ
// ========================================================================
let editingEquipmentId = null; // null = กำลังเพิ่มใหม่, ไม่ null = กำลังแก้ไขอุปกรณ์ตัวนี้อยู่

async function loadWarehouseTab() {
  const list = await api('/api/equipment');
  renderWarehouseTable(list);
}

function renderWarehouseTable(list) {
  const tbody = document.getElementById('warehouseTableBody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px;">ยังไม่มีอุปกรณ์ในคลัง กด "+ เพิ่มอุปกรณ์ใหม่" เพื่อเริ่มต้น</td></tr>';
    return;
  }
  tbody.innerHTML = list
    .map((item) => {
      const [dotClass, label] = statusLabel[item.status] || statusLabel.available;
      const thumb = item.image_url
        ? `<img src="${item.image_url}" alt="${item.name}" style="width:36px;height:36px;border-radius:8px;object-fit:cover;" />`
        : `<span style="font-size:20px;">${item.category_icon || '📦'}</span>`;
      return `
      <tr>
        <td>${thumb}</td>
        <td>${item.code}</td>
        <td>${item.name}</td>
        <td>${item.category_icon || ''} ${item.category_name || '— ไม่ระบุ —'}</td>
        <td class="right">${item.stock_qty} ชิ้น</td>
        <td><span class="status-dot ${dotClass}"></span>${label}</td>
        <td>
          <button class="btn-outline sm equip-edit-btn" data-id="${item.id}">แก้ไข</button>
          <button class="row-del equip-del-btn" data-id="${item.id}">ลบ</button>
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('.equip-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = list.find((e) => String(e.id) === btn.dataset.id);
      openEquipmentModal(item || null);
    });
  });
  tbody.querySelectorAll('.equip-del-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = list.find((e) => String(e.id) === btn.dataset.id);
      if (!confirm(`ลบอุปกรณ์ "${item ? item.name : ''}" ออกจากคลังหรือไม่?`)) return;
      try {
        await api(`/api/equipment/${btn.dataset.id}`, { method: 'DELETE' });
      } catch (err) {
        alert(err.message);
        return;
      }
      await loadWarehouseTab();
      await loadEquipment(); // อัปเดตแท็บ "อุปกรณ์ทั้งหมด" ให้ตรงกันด้วย
    });
  });
}

function populateEquipmentCategorySelect() {
  const sel = document.getElementById('equipmentFormCategory');
  const opts = state.categories.map((c) => `<option value="${c.id}">${c.icon || '📦'} ${c.name}</option>`).join('');
  sel.innerHTML = '<option value="">— ไม่ระบุ —</option>' + opts;
}

function openEquipmentModal(item) {
  populateEquipmentCategorySelect();
  editingEquipmentId = item ? item.id : null;
  document.getElementById('equipmentModalTitle').textContent = item ? 'แก้ไขอุปกรณ์' : 'เพิ่มอุปกรณ์ใหม่';
  document.getElementById('equipmentFormCode').value = item ? item.code : '';
  document.getElementById('equipmentFormName').value = item ? item.name : '';
  document.getElementById('equipmentFormCategory').value = item && item.category_id ? item.category_id : '';
  document.getElementById('equipmentFormStock').value = item ? item.stock_qty : 0;
  document.getElementById('equipmentFormStatus').value = item ? item.status : 'available';
  openModal('equipmentModal');
}

function initEquipmentModal() {
  document.getElementById('btnNewEquipmentInline').addEventListener('click', () => openEquipmentModal(null));
  document.getElementById('btnCancelEquipment').addEventListener('click', () => closeModal('equipmentModal'));

  document.getElementById('btnSaveEquipment').addEventListener('click', async () => {
    const code = document.getElementById('equipmentFormCode').value.trim();
    const name = document.getElementById('equipmentFormName').value.trim();
    const category_id = document.getElementById('equipmentFormCategory').value || null;
    const stock_qty = Number(document.getElementById('equipmentFormStock').value) || 0;
    const status = document.getElementById('equipmentFormStatus').value;
    if (!code || !name) { alert('กรุณาระบุรหัสอุปกรณ์และชื่ออุปกรณ์'); return; }

    try {
      if (editingEquipmentId) {
        await api(`/api/equipment/${editingEquipmentId}`, {
          method: 'PATCH',
          body: JSON.stringify({ code, name, category_id, stock_qty, status }),
        });
      } else {
        await api('/api/equipment', {
          method: 'POST',
          body: JSON.stringify({ code, name, category_id, stock_qty, status }),
        });
      }
    } catch (err) {
      alert(err.message);
      return;
    }

    closeModal('equipmentModal');
    await loadWarehouseTab();
    await loadEquipment(); // อัปเดตแท็บ "อุปกรณ์ทั้งหมด" ให้ตรงกันด้วย
  });
}

// ========================================================================
// INIT
// ========================================================================
async function loadCurrentUser() {
  state.currentUser = await api('/api/me'); // ถ้ายังไม่ล็อกอิน api() จะเด้งไป /login.html ให้เองอัตโนมัติ
  document.getElementById('userName').textContent = state.currentUser.display_name;
  document.getElementById('userAvatar').textContent = state.currentUser.display_name.trim().charAt(0).toUpperCase();
}

function initLogout() {
  document.getElementById('btnLogout').addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login.html';
    }
  });
}

// ========================================================================
// SETTINGS (แก้ไขบัญชีของตัวเอง)
// ========================================================================
function loadSettingsForm() {
  document.getElementById('accUsername').value = state.currentUser.username;
  document.getElementById('accDisplayName').value = state.currentUser.display_name;
  document.getElementById('accCurrentPassword').value = '';
  document.getElementById('accNewPassword').value = '';
  document.getElementById('accNewPasswordConfirm').value = '';
}

function initSettingsForm() {
  document.getElementById('accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = document.getElementById('accUsername').value.trim();
    const display_name = document.getElementById('accDisplayName').value.trim();
    const current_password = document.getElementById('accCurrentPassword').value;
    const new_password = document.getElementById('accNewPassword').value;
    const new_password_confirm = document.getElementById('accNewPasswordConfirm').value;

    if (!username || !display_name) {
      alert('กรุณากรอกชื่อผู้ใช้และชื่อที่แสดง');
      return;
    }
    if (new_password && new_password !== new_password_confirm) {
      alert('รหัสผ่านใหม่ที่กรอกทั้งสองช่องไม่ตรงกัน');
      return;
    }

    try {
      const res = await api('/api/account', {
        method: 'PATCH',
        body: JSON.stringify({
          username,
          display_name,
          current_password: current_password || undefined,
          new_password: new_password || undefined,
        }),
      });
      state.currentUser = res.user;
      document.getElementById('userName').textContent = state.currentUser.display_name;
      document.getElementById('userAvatar').textContent = state.currentUser.display_name.trim().charAt(0).toUpperCase();
      loadSettingsForm(); // เคลียร์ช่องรหัสผ่านหลังบันทึกสำเร็จ
      alert('บันทึกข้อมูลบัญชีเรียบร้อยแล้ว ✅');
    } catch (err) {
      alert(err.message);
    }
  });
}

async function init() {
  await loadCurrentUser();
  initLogout();
  initSettingsForm();
  initTabs();
  initExpenseModals();
  initBoothModal();
  initBookingDetailModal();
  initEquipmentModal();
  initSidebarDrawer();

  document.getElementById('searchBox').addEventListener('input', debounce(loadEquipment, 300));
  document.getElementById('statusFilter').addEventListener('change', loadEquipment);
  document.getElementById('sortFilter').addEventListener('change', loadEquipment);
  document.getElementById('btnCheckout').addEventListener('click', submitBooking);

  await loadCategories();
  await loadEventOptions();
  await loadEquipment();
  renderCart();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

init();
