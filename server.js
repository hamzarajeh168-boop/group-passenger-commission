const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'shahm-2026';
const FILE = path.join(__dirname, 'data', 'state.json');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const id = () => crypto.randomUUID();
const money = n => Math.round(Number(n) * 100) / 100;
const WEEKLY_DEDUCT = 0.5;           // يُخصم كل خميس 11:59 مساءً
const MIN_RECHARGE = 10;             // أقل قيمة شحن مسموحة
const baileys = process.env.BAILEYS_ENABLED === 'false' ? null : require('./baileys-bot');

// آخر QR معروض من البوت (للربط من صفحة الويب)
let latestQR = '';
let botConnected = false;
if (baileys) {
  baileys.onQR = qr => { latestQR = qr; botConnected = false; };
  baileys.onConnected = () => { latestQR = ''; botConnected = true; };
}
app.get('/api/qr-status', (_, res) => {
  if (botConnected) return res.json({ connected: true });
  res.json({ connected: false, qr: latestQR || '' });
});

// صورة QR جاهزة (SVG) لصفحة الربط
app.get('/api/qr-image', async (_, res) => {
  try {
    if (botConnected || !latestQR) return res.status(404).json({ error: 'no-qr' });
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(latestQR, { type: 'svg', margin: 1, width: 320 });
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function emptyStats() { return { passengers: 0, orders: 0, totalTrips: 0, totalCommission: 0 }; }

// ============ قاعدة البيانات (Postgres — البيانات لا تضيع أبدًا) ============
// على Railway: أضف Postgres من New → Database واستخدم متغير DATABASE_URL الجاهز
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

function defaultState() {
  return {
    settings: { groupId: '', whatsappNumber: '', lastWeeklyDeduct: '', passengerCommission: 0.5, orderCommission: 1 },
    accountants: [],
    captains: [],
    pairs: [],
    ledger: [],
    sessions: {},
    messages: []
  };
}

let cache = null;   // الحالة بالذاكرة للقراءة الفورية

async function initDB() {
  // بدون DATABASE_URL: تشغيل محلي بالملف — بدون قاعدة بيانات
  if (!process.env.DATABASE_URL) {
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = defaultState(); }
    console.log('وضع محلي: الحفظ في data/state.json');
    return;
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS state (id INT PRIMARY KEY, data JSONB NOT NULL)`);
  const r = await pool.query(`SELECT data FROM state WHERE id = 1`);
  if (r.rows.length) {
    cache = r.rows[0].data;
  } else {
    // أول تشغيل: حاول نرفع بيانات الملف المحلي القديم إذا موجودة (ترحيل تلقائي)
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = defaultState(); }
    await pool.query(`INSERT INTO state (id, data) VALUES (1, $1)`, [cache]);
  }
}

function load() { return cache || defaultState(); }

function save(s) {
  cache = s;
  if (!process.env.DATABASE_URL) {
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('فشل الحفظ المحلي:', e.message); }
    return;
  }
  pool.query(`UPDATE state SET data = $1 WHERE id = 1`, [JSON.parse(JSON.stringify(s))])
    .catch(err => {
      console.error('خطأ في حفظ قاعدة البيانات:', err.message);
      // نسخة احتياطية محلية في حال فشل الاتصال حتى لا تُفقد العملية
      try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(FILE + '.tmp', FILE); } catch { }
    });
}

const normPhone = p => String(p || '').replace(/\D/g, '');
const findCaptain = (s, phone) => s.captains.find(c => c.phone === normPhone(phone));
const findAccountant = (s, phone) => s.accountants.find(a => a.phone === normPhone(phone));

async function removeFromGroup(phone, groupId) {
  if (!groupId) return { performed: false, reason: 'لم يتم ضبط معرف الجروب بعد' };
  if (baileys) {
    const controlUrl = `http://127.0.0.1:${Number(process.env.BAILEYS_CONTROL_PORT || 4101)}/remove-participant`;
    try {
      const response = await fetch(controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-baileys-key': process.env.BAILEYS_CONTROL_KEY || 'shahm-local' }, body: JSON.stringify({ groupId, phone: normPhone(phone) }) });
      if (!response.ok) return { performed: false, reason: `Baileys أرجع HTTP ${response.status}` };
      return { performed: true };
    } catch (error) { return { performed: false, reason: `Baileys غير متصل: ${error.message}` }; }
  }
  return { performed: false, reason: 'خدمة WhatsApp غير مفعلة' };
}

// إزالة تلقائية من الجروب عند صفر الرصيد — البيانات تبقى محفوظة
async function enforceZeroBalance(s, captain) {
  if (captain.balance > 0 || captain.removedFromGroup) return;
  captain.removedFromGroup = true;
  const result = await removeFromGroup(captain.phone, s.settings.groupId);
  s.ledger.unshift({ id: id(), type: 'system', phone: captain.phone, amount: 0, note: `أزيل من جروب الواتساب تلقائيًا لأن رصيده صفر${result.performed ? '' : ` (${result.reason || ''})`}`, createdAt: new Date().toISOString() });
}

function addEntry(s, { type, phone, amount, note, linkedPhone }) {
  s.ledger.unshift({ id: id(), type, phone, amount: money(amount), note: note || '', linkedPhone: linkedPhone || '', createdAt: new Date().toISOString() });
}

// ============ مصادقة ============
function admin(req, res) { if (req.get('x-admin-key') !== ADMIN_KEY) { res.status(401).json({ error: 'كلمة سر الإدارة غير صحيحة' }); return false; } return true; }
function accountantAuth(req, res, s) {
  const token = String(req.get('x-token') || '');
  const session = s.sessions[token];
  if (!session || session.role !== 'accountant') { res.status(401).json({ error: 'جلسة المحاسب غير صالحة، سجّل دخول من جديد' }); return null; }
  return findAccountant(s, session.phone);
}
function issueSession(s, phone, role) { const token = crypto.randomUUID(); s.sessions[token] = { phone, role, at: new Date().toISOString() }; return token; }

function captainView(s, c) {
  const pair = s.pairs.find(p => p.consumerPhone === c.phone || p.productPhone === c.phone) || null;
  const linkedPhone = pair ? (pair.consumerPhone === c.phone ? pair.productPhone : pair.consumerPhone) : '';
  const entries = s.ledger.filter(e => e.phone === c.phone).slice(0, 100);
  return { name: c.name, phone: c.phone, email: c.email, pin: c.pin, role: c.role, balance: c.balance, removedFromGroup: !!c.removedFromGroup, stats: c.stats || emptyStats(), linkedPhone, ledger: entries };
}

// ============ الدخول ============
app.post('/api/accountant/login', (req, res) => {
  const s = load();
  const acc = findAccountant(s, req.body.phone);
  if (!acc || acc.password !== String(req.body.password || '')) return res.status(401).json({ error: 'رقم الهاتف أو كلمة السر غير صحيحة' });
  const token = issueSession(s, acc.phone, 'accountant'); save(s);
  res.json({ token, pin: acc.pin, name: acc.name, balance: acc.balance });
});
app.post('/api/captain/login', (req, res) => {
  const s = load();
  const c = findCaptain(s, req.body.phone);
  if (!c || c.password !== String(req.body.password || '')) return res.status(401).json({ error: 'رقم الهاتف أو كلمة السر غير صحيحة' });
  const token = issueSession(s, c.phone, 'captain'); save(s);
  res.json({ token, captain: captainView(s, c) });
});

// ============ صفحة الإدارة ============
app.get('/api/admin/accounts', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  res.json({
    accountants: s.accountants.map(a => ({ id: a.id, name: a.name, phone: a.phone, email: a.email, pin: a.pin, balance: a.balance, removedFromGroup: !!a.removedFromGroup })),
    captains: s.captains.map(c => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, pin: c.pin, role: c.role, balance: c.balance, removedFromGroup: !!c.removedFromGroup, stats: c.stats || emptyStats() })),
    pairs: s.pairs,
    commissions: {
      consumption: money(s.ledger.filter(e => e.type === 'consumption').reduce((t, e) => t + Math.abs(Number(e.amount) || 0), 0)),
      production: money(s.ledger.filter(e => e.type === 'production').reduce((t, e) => t + Math.abs(Number(e.amount) || 0), 0))
    }
  });
});

app.post('/api/admin/accountants', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  if (!phone || !String(req.body.name || '').trim() || !String(req.body.password || '')) return res.status(400).json({ error: 'الاسم ورقم الهاتف وكلمة السر مطلوبة' });
  if (findAccountant(s, phone)) return res.status(409).json({ error: 'الحساب موجود مسبقًا' });
  const acc = { id: id(), name: String(req.body.name).trim(), phone, email: String(req.body.email || '').trim(), password: String(req.body.password), pin: String(Math.floor(1000 + Math.random() * 9000)), balance: 0, removedFromGroup: false };
  s.accountants.unshift(acc); save(s);
  res.status(201).json(acc);
});

app.post('/api/admin/captains', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  const role = req.body.role === 'production' ? 'production' : 'consumption'; // الدور لا يُحدد عند الإنشاء، يُحدد لاحقًا عبر الربط
  if (!phone || !String(req.body.name || '').trim() || !String(req.body.password || '')) return res.status(400).json({ error: 'الاسم ورقم الهاتف وكلمة السر مطلوبة' });
  if (findCaptain(s, phone)) return res.status(409).json({ error: 'الحساب موجود مسبقًا' });
  const c = { id: id(), name: String(req.body.name).trim(), phone, email: String(req.body.email || '').trim(), password: String(req.body.password), pin: String(Math.floor(1000 + Math.random() * 9000)), role, balance: 0, removedFromGroup: false, stats: emptyStats(), createdAt: new Date().toISOString() };
  s.captains.unshift(c); save(s);
  res.status(201).json(c);
});

// شحن رصيد (حد أدنى 10 دنانير)
app.post('/api/admin/topup', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  const amount = money(req.body.amount);
  if (amount < MIN_RECHARGE) return res.status(400).json({ error: `أقل قيمة شحن هي ${MIN_RECHARGE} دنانير` });
  const c = findCaptain(s, phone) || findAccountant(s, phone);
  if (!c) return res.status(404).json({ error: 'رقم غير موجود في النظام' });
  c.balance = money(c.balance + amount);
  if (s.captains.includes(c) && c.removedFromGroup && c.balance > 0) c.removedFromGroup = false;
  addEntry(s, { type: 'topup', phone, amount, note: 'شحن رصيد من غرفة الإدارة' });
  save(s); res.json({ balance: c.balance });
});

// سحب / إرسال رصيد عن طريق الرقم فقط
app.post('/api/admin/withdraw', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  const amount = money(req.body.amount);
  const c = findCaptain(s, phone) || findAccountant(s, phone);
  if (!c) return res.status(404).json({ error: 'رقم غير موجود في النظام' });
  if (amount <= 0 || c.balance < amount) return res.status(400).json({ error: 'الرصيد غير كافٍ للسحب' });
  c.balance = money(c.balance - amount);
  addEntry(s, { type: 'withdraw', phone, amount: -amount, note: 'سحب رصيد من غرفة الإدارة' });
  if (s.captains.includes(c)) await enforceZeroBalance(s, c);
  save(s); res.json({ balance: c.balance });
});

// إزالة من جروب الواتساب (الأرقام والبيانات تبقى محفوظة)
app.post('/api/admin/remove-from-group', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  const acc = findAccountant(s, phone);
  const c = findCaptain(s, phone);
  if (!acc && !c) return res.status(404).json({ error: 'رقم غير موجود في النظام' });
  const target = acc || c;
  target.removedFromGroup = true;
  const result = await removeFromGroup(phone, s.settings.groupId);
  addEntry(s, { type: 'system', phone, amount: 0, note: `إزالة من جروب الواتساب${result.performed ? '' : ` (${result.reason || ''})`}` });
  save(s);
  res.json({ ok: result.performed, reason: result.reason || '' });
});

// ربط مستهلك بمنتج
app.post('/api/admin/pairs', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const consumer = normPhone(req.body.consumerPhone), product = normPhone(req.body.productPhone);
  if (!consumer || !product || consumer === product) return res.status(400).json({ error: 'أدخل رقمَي مستهلك ومنتج مختلفين' });
  if (!findCaptain(s, consumer) || !findCaptain(s, product)) return res.status(404).json({ error: 'يجب إنشاء حسابي المستهلك والمنتج أولًا' });
  if (s.pairs.some(p => p.consumerPhone === consumer && p.productPhone === product)) return res.status(409).json({ error: 'الربط موجود مسبقًا' });
  s.pairs.push({ consumerPhone: consumer, productPhone: product, createdAt: new Date().toISOString() });
  save(s); res.status(201).json(s.pairs);
});

app.get('/api/admin/ledger', (req, res) => { if (!admin(req, res)) return; res.json(load().ledger.slice(0, 300)); });
app.get('/api/admin/settings', (req, res) => { if (!admin(req, res)) return; res.json(load().settings); });
async function resolveGroupLink(link) {
  if (!baileys) return { resolved: false, reason: 'خدمة WhatsApp غير مفعلة، أدخل معرف الجروب يدويًا' };
  const controlUrl = `http://127.0.0.1:${Number(process.env.BAILEYS_CONTROL_PORT || 4101)}/resolve-group`;
  try {
    const response = await fetch(controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-baileys-key': process.env.BAILEYS_CONTROL_KEY || 'shahm-local' }, body: JSON.stringify({ link }) });
    const data = await response.json();
    if (!response.ok || !data.ok) return { resolved: false, reason: data.error || `Baileys أرجع HTTP ${response.status}` };
    return { resolved: true, groupId: data.groupId, subject: data.subject || '' };
  } catch (error) { return { resolved: false, reason: `Baileys غير متصل: ${error.message}` }; }
}
app.post('/api/admin/settings', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  s.settings.whatsappNumber = normPhone(req.body.whatsappNumber);
  if (req.body.passengerCommission !== undefined) s.settings.passengerCommission = money(Math.max(0, Number(req.body.passengerCommission) || 0));
  if (req.body.orderCommission !== undefined) s.settings.orderCommission = money(Math.max(0, Number(req.body.orderCommission) || 0));
  const groupInput = String(req.body.groupId || '').trim();
  s.settings.groupLink = groupInput.includes('chat.whatsapp.com') ? groupInput : (s.settings.groupLink || '');
  if (groupInput.includes('chat.whatsapp.com')) {
    // لصق رابط الدعوة → نحوله تلقائيًا لمعرف الجروب عشان تعرف الإزالة تشتغل
    const result = await resolveGroupLink(groupInput);
    if (result.resolved) {
      s.settings.groupId = result.groupId;
      s.settings.groupSubject = result.subject;
      addEntry(s, { type: 'system', phone: 'admin', amount: 0, note: `تم ربط الجروب من الرابط: ${result.subject || result.groupId}` });
      save(s);
      return res.json({ ...s.settings, resolved: true, message: `تم التعرف على الجروب: ${result.subject || result.groupId}` });
    }
    s.settings.groupId = s.settings.groupId || '';
    save(s);
    return res.status(502).json({ error: `تعذر تحويل الرابط: ${result.reason}` });
  }
  s.settings.groupId = groupInput;
  save(s); res.json(s.settings);
});

// فحص الجروب المحفوظ: إذا المعرّف ما عاد صالح، يعيد التحويل من الرابط تلقائيًا
app.post('/api/admin/verify-group', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  if (!baileys) return res.status(502).json({ error: 'خدمة WhatsApp غير مفعلة' });
  const controlUrl = `http://127.0.0.1:${Number(process.env.BAILEYS_CONTROL_PORT || 4101)}/check-group`;
  const headers = { 'Content-Type': 'application/json', 'x-baileys-key': process.env.BAILEYS_CONTROL_KEY || 'shahm-local' };
  if (s.settings.groupId) {
    try {
      const response = await fetch(controlUrl, { method: 'POST', headers, body: JSON.stringify({ groupId: s.settings.groupId }) });
      const data = await response.json();
      if (response.ok && data.ok) return res.json({ ok: true, status: 'valid', groupId: data.groupId, subject: data.subject, participants: data.participants, message: `الجروب صالح ومربوط: ${data.subject || data.groupId} (${data.participants} عضو)` });
    } catch { }
  }
  // المعرّف غير صالح أو غير محفوظ → نعيد التحويل من الرابط
  if (s.settings.groupLink) {
    const result = await resolveGroupLink(s.settings.groupLink);
    if (result.resolved) {
      s.settings.groupId = result.groupId;
      s.settings.groupSubject = result.subject;
      addEntry(s, { type: 'system', phone: 'admin', amount: 0, note: `إصلاح تلقائي لربط الجروب: ${result.subject || result.groupId}` });
      save(s);
      return res.json({ ok: true, status: 'repaired', groupId: result.groupId, subject: result.subject, message: `تم إصلاح الربط من الرابط: ${result.subject || result.groupId}` });
    }
    return res.status(502).json({ error: `المعرّف غير صالح وتعذر الإصلاح من الرابط: ${result.reason}` });
  }
  return res.status(400).json({ error: 'لا يوجد جروب محفوظ ولا رابط دعوة — الصق رابط الجروب أولًا' });
});

// ============ صفحة المحاسب ============
app.get('/api/accountant/me', (req, res) => {
  const s = load();
  const acc = accountantAuth(req, res, s); if (!acc) return;
  const consumers = s.captains.filter(c => c.role === 'consumption').map(c => ({ phone: c.phone, name: c.name, balance: c.balance, stats: c.stats || emptyStats(), linkedPhone: (s.pairs.find(p => p.consumerPhone === c.phone) || {}).productPhone || '' }));
  const products = s.captains.filter(c => c.role === 'production').map(c => ({ phone: c.phone, name: c.name, balance: c.balance, stats: c.stats || emptyStats(), linkedPhone: (s.pairs.find(p => p.productPhone === c.phone) || {}).consumerPhone || '' }));
  res.json({ name: acc.name, phone: acc.phone, pin: acc.pin, balance: acc.balance, consumers, products });
});

// إرسال رصيد من محفظة المحاسب فقط
app.post('/api/accountant/send-balance', (req, res) => {
  const s = load();
  const acc = accountantAuth(req, res, s); if (!acc) return;
  const amount = money(req.body.amount);
  const target = findCaptain(s, req.body.phone) || findAccountant(s, req.body.phone);
  if (!target || target.phone === acc.phone) return res.status(400).json({ error: 'رقم المستلم غير صحيح' });
  if (amount <= 0 || acc.balance < amount) return res.status(400).json({ error: 'رصيد محفظتك غير كافٍ' });
  acc.balance = money(acc.balance - amount);
  target.balance = money(target.balance + amount);
  addEntry(s, { type: 'transfer', phone: acc.phone, amount: -amount, note: `إرسال رصيد إلى ${target.phone}`, linkedPhone: target.phone });
  addEntry(s, { type: 'transfer', phone: target.phone, amount, note: `استلام رصيد من المحاسب ${acc.phone}`, linkedPhone: acc.phone });
  save(s); res.json({ balance: acc.balance });
});

// البحث عن رقم للإزالة من الجروب
app.get('/api/accountant/search', (req, res) => {
  const s = load();
  const acc = accountantAuth(req, res, s); if (!acc) return;
  const phone = normPhone(req.query.phone);
  const c = findCaptain(s, phone); const a = findAccountant(s, phone);
  if (!c && !a) return res.status(404).json({ error: 'الرقم غير موجود في النظام' });
  const t = c || a;
  res.json({ name: t.name, phone: t.phone, role: c ? (c.role === 'consumption' ? 'مستهلك' : 'منتج') : 'محاسب', balance: t.balance, removedFromGroup: !!t.removedFromGroup });
});
app.post('/api/accountant/remove-from-group', async (req, res) => {
  const s = load();
  const acc = accountantAuth(req, res, s); if (!acc) return;
  const phone = normPhone(req.body.phone);
  const c = findCaptain(s, phone); const a = findAccountant(s, phone);
  if (!c && !a) return res.status(404).json({ error: 'الرقم غير موجود في النظام' });
  const target = c || a;
  target.removedFromGroup = true;
  const result = await removeFromGroup(phone, s.settings.groupId);
  addEntry(s, { type: 'system', phone, amount: 0, note: `إزالة من جروب الواتساب بواسطة المحاسب${result.performed ? '' : ` (${result.reason || ''})`}` });
  save(s);
  res.json({ ok: result.performed, reason: result.reason || '' });
});

// إضافة خانة بقيمة: المستهلك دائمًا سالب، والمنتج دائمًا موجب
// إدخال قيمة للمستهلك يسحبها من محفظته ويعطيها تلقائيًا للمنتج المرتبط به
app.post('/api/accountant/entry', (req, res) => {
  const s = load();
  const acc = accountantAuth(req, res, s); if (!acc) return;
  const phone = normPhone(req.body.phone);
  const kind = req.body.kind === 'production' ? 'production' : 'consumption';
  const amount = money(Math.abs(Number(req.body.amount) || 0));
  const c = findCaptain(s, phone);
  if (!c) return res.status(404).json({ error: 'الرقم غير موجود' });
  if (amount <= 0) return res.status(400).json({ error: 'أدخل قيمة صحيحة' });
  if (kind === 'consumption') {
    if (c.role !== 'consumption') return res.status(400).json({ error: 'هذا الرقم ليس حساب مستهلك' });
    if (c.balance < amount) return res.status(400).json({ error: 'محفظة المستهلك لا تكفي، ممنوع إتمام العملية' });
    c.balance = money(c.balance - amount);
    c.stats = c.stats || emptyStats();
    addEntry(s, { type: 'consumption', phone, amount: -amount, note: 'عمولة راكب/أوردر بواسطة المحاسب' });
    const pair = s.pairs.find(p => p.consumerPhone === phone);
    if (pair) {
      const product = findCaptain(s, pair.productPhone);
      if (product) {
        product.balance = money(product.balance + amount);
        product.stats = product.stats || emptyStats();
        addEntry(s, { type: 'production', phone: product.phone, amount, note: `تحويل عمولة من المستهلك ${phone}`, linkedPhone: phone });
      }
    }
  } else {
    if (c.role !== 'production') return res.status(400).json({ error: 'هذا الرقم ليس حساب منتج' });
    c.balance = money(c.balance + amount);
    c.stats = c.stats || emptyStats();
    addEntry(s, { type: 'production', phone, amount, note: 'إضافة قيمة إنتاج بواسطة المحاسب' });
  }
  enforceZeroBalance(s, c);
  save(s); res.json({ ok: true });
});

// ============ صفحة الكابتن ============
app.get('/api/captain/me', (req, res) => {
  const s = load();
  const token = String(req.get('x-token') || '');
  const session = s.sessions[token];
  if (!session || session.role !== 'captain') return res.status(401).json({ error: 'جلسة غير صالحة، سجّل دخول من جديد' });
  const c = findCaptain(s, session.phone);
  if (!c) return res.status(404).json({ error: 'الحساب غير موجود' });
  res.json(captainView(s, c));
});

// ============ Webhook الجروب ============
// ============ عمولة الحمل (لايك على رسالة الجروب): العدد × قيمة العمولة ============
// المستهلك بيتخصم منه قيمة العمولة وتنبرع تلقائيًا للمنتج المرتبط به، وإذا صار رصيده صفر ينحذف من الجروب
function commissionCategory(text) {
  const t = String(text || '');
  return /أوردر|اوردر|order/i.test(t) ? 'orders' : 'passengers';
}

app.post('/webhook/group', async (req, res) => {
  const event = req.body || {};
  const s = load();
  const groupId = String(s.settings.groupId || '').trim();
  const from = normPhone(event.from);

  if (event.type === 'like') {
    // عمولة الحمل: شخص عمل لايك/تفاعل على رسالة في الجروب → هو طالب حمل
    // بيتخصم منه (عدد 1 × قيمة العمولة) وتنبرع تلقائيًا للمنتج المرتبط به
    const requester = findCaptain(s, from);
    const original = s.messages.find(m => m.id === String(event.replyId || '').trim());
    if (!requester) return res.json({ ok: true, status: 'not-registered' });
    if (!original) return res.json({ ok: true, status: 'no-context' });
    const category = commissionCategory(original.text); // passengers | orders
    const rate = money(category === 'orders' ? (s.settings.orderCommission ?? 1) : (s.settings.passengerCommission ?? 0.5));
    requester.stats = requester.stats || emptyStats();
    if (requester.balance < rate) {
      // رصيده ما بيكفي → ينحذف من الجروب فورًا
      const result = await removeFromGroup(from, groupId);
      requester.removedFromGroup = true;
      addEntry(s, { type: 'system', phone: from, amount: 0, note: `أزيل من الجروب: رصيده لا يكفي عمولة ${category === 'orders' ? 'أوردر' : 'راكب'} (${rate})${result.performed ? '' : ` (${result.reason || ''})`}` });
      save(s);
      return res.json({ ok: true, status: 'removed-insufficient' });
    }
    requester.balance = money(requester.balance - rate);
    requester.stats[category] = (requester.stats[category] || 0) + 1;
    requester.stats.totalTrips = (requester.stats.totalTrips || 0) + 1;
    requester.stats.totalCommission = money((requester.stats.totalCommission || 0) + rate);
    addEntry(s, { type: 'consumption', phone: from, amount: -rate, note: `عمولة ${category === 'orders' ? 'أوردر' : 'راكب'} من جروب الواتساب` });
    const pair = s.pairs.find(p => p.consumerPhone === from);
    if (pair) {
      const product = findCaptain(s, pair.productPhone);
      if (product) {
        product.balance = money(product.balance + rate);
        product.stats = product.stats || emptyStats();
        addEntry(s, { type: 'production', phone: product.phone, amount: rate, note: `عمولة حمل من المستهلك ${from}`, linkedPhone: from });
      }
    }
    await enforceZeroBalance(s, requester);
    save(s);
    return res.json({ ok: true, status: 'charged', category, commission: rate });
  }

  if (event.type === 'message') {
    // حفظ تلقائي: إذا معرف الجروب مش محفوظ، نتعلمه من أول رسالة تجي من جروب
    if (event.groupId && String(event.groupId).endsWith('@g.us') && s.settings.groupId !== event.groupId) {
      s.settings.groupId = String(event.groupId);
      addEntry(s, { type: 'system', phone: 'admin', amount: 0, note: `تم التعرف على جروب جديد تلقائيًا من رسالة: ${event.groupId}` });
    }
    const c = findCaptain(s, from);
    // ممنوع يكتب بالجروب لو محفظته صفر → يُزال فورًا (بياناته محفوظة)
    if (c && c.balance <= 0 && !c.removedFromGroup) {
      c.removedFromGroup = true;
      const result = await removeFromGroup(from, groupId);
      addEntry(s, { type: 'system', phone: from, amount: 0, note: `أزيل من الجروب: رصيده صفر وحاول الكتابة${result.performed ? '' : ` (${result.reason || ''})`}` });
      save(s);
      return res.json({ ok: true, status: 'removed-zero-balance' });
    }
    if (event.id && !s.messages.some(m => m.id === event.id)) {
      s.messages.push({ id: event.id, from, text: String(event.text || ''), createdAt: new Date().toISOString() });
      if (s.messages.length > 500) s.messages = s.messages.slice(-500);
      save(s);
    }
    return res.json({ ok: true, status: 'saved' });
  }

  res.json({ ok: true, status: 'ignored' });
});

// ============ الخصم الأسبوعي: كل خميس 11:59 مساءً نخصم 0.5 دينار من كل الأرقام ============
let lastDeductCheck = '';
setInterval(() => {
  const now = new Date();
  const day = now.getDay();          // 4 = الخميس
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const weekKey = `${now.getFullYear()}-W${Math.ceil((now.getDate() + 6 - day) / 7)}`;
  if (day !== 4 || hhmm !== '23:59' || lastDeductCheck === weekKey) return;
  lastDeductCheck = weekKey;
  const s = load();
  [...s.captains, ...s.accountants].forEach(acc => {
    if (acc.balance <= 0) return;
    acc.balance = money(Math.max(0, acc.balance - WEEKLY_DEDUCT));
    addEntry(s, { type: 'weekly', phone: acc.phone, amount: -WEEKLY_DEDUCT, note: 'خصم أسبوعي (خميس 11:59 مساءً)' });
    if (s.captains.includes(acc)) enforceZeroBalance(s, acc);
  });
  s.settings.lastWeeklyDeduct = new Date().toISOString();
  save(s);
  console.log('تم تنفيذ الخصم الأسبوعي لجميع الأرقام');
}, 30 * 1000);

// رابط صفحة ربط الواتساب
app.get('/whatsapp-link', (_, res) => res.sendFile(path.join(__dirname, 'public', 'whatsapp-link.html')));

app.get('/api/health', (_, res) => res.json({ ok: true, app: 'شهم' }));
app.get('/control-room', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/accountant', (_, res) => res.sendFile(path.join(__dirname, 'public', 'accountant.html')));
app.get('/captain', (_, res) => res.sendFile(path.join(__dirname, 'public', 'captain.html')));
initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`Shahm running on ${PORT} — البيانات محفوظة دائمًا`));
  })
  .catch(err => {
    console.error('فشل الاتصال بقاعدة البيانات:', err.message);
    console.log('نكمل بالوضع المحلي (الملف data/state.json)...');
    cache = null;
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = defaultState(); }
    app.listen(PORT, '0.0.0.0', () => console.log(`Shahm running on ${PORT} — وضع محلي`));
  });
