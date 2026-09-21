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
// واجهة المحاسب تُقدَّم من الخادم كي تبقى متوافقة مع بيئات النشر التي تجعل public للقراءة فقط.
app.get('/accountant.js', (_, res) => res.type('application/javascript').send(String.raw`
const $=id=>document.getElementById(id),money=v=>Number(v||0).toFixed(2)+' د.أ',token=()=>localStorage.getItem('shahm-token')||'';
function msg(el,t,ok){el.textContent=t;el.className=ok?'ok':'bad'}
async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json','x-token':token(),...(opt.headers||{})}}),d=await r.json();if(!r.ok)throw Error(d.error||'تعذر تنفيذ العملية');return d}
function row(c,label){return '<div class="ledger"><span><b>'+c.name+'</b><small>'+label+' · '+c.phone+' · راكب: '+(c.stats?.passengers||0)+' · أوردر: '+(c.stats?.orders||0)+' · خاص: '+(c.stats?.special||0)+'</small></span><b class="'+(c.balance>=0?'ok':'bad')+'">'+money(c.balance)+'</b></div>'}
async function load(){try{const m=await api('/api/accountant/me');$('accName').textContent=m.name;$('accIdentity').textContent=m.phone+' · الكود: '+m.pin;$('accBalance').textContent=money(m.balance);const t=m.totals||{passengers:0,orders:0,special:0};$('tPassengers').textContent=t.passengers;$('tOrders').textContent=t.orders;$('tSpecial').textContent=t.special;$('consumers').innerHTML=m.consumers.map(x=>row(x,'مستهلك')).join('')||'<small>لا يوجد مستهلكون</small>';$('products').innerHTML=m.products.map(x=>row(x,'منتج')).join('')||'<small>لا يوجد منتجون</small>';$('panel').hidden=false;$('loginCard').hidden=true}catch(e){msg($('loginMsg'),e.message)}}
$('login').onclick=async()=>{try{const r=await api('/api/accountant/login',{method:'POST',body:JSON.stringify({phone:$('phone').value,password:$('password').value})});localStorage.setItem('shahm-token',r.token);load()}catch(e){msg($('loginMsg'),e.message)}};
$('logout').onclick=()=>{localStorage.removeItem('shahm-token');location.reload()};
$('sendBalance').onclick=async()=>{try{const r=await api('/api/accountant/send-balance',{method:'POST',body:JSON.stringify({phone:$('sendPhone').value,amount:Number($('sendAmount').value)})});msg($('sendMsg'),'تم الإرسال. رصيدك الآن '+money(r.balance),true);load()}catch(e){msg($('sendMsg'),e.message)}};
$('searchBtn').onclick=async()=>{try{const r=await api('/api/accountant/remove-from-group',{method:'POST',body:JSON.stringify({phone:$('rmPhone').value})});msg($('searchResult'),r.ok?'تمت إزالة العضو':'تعذرت الإزالة: '+r.reason,r.ok);load()}catch(e){msg($('searchResult'),e.message)}};
const old=$('entryPhone').closest('article');old.hidden=true;const box=document.createElement('article');box.className='wide';box.innerHTML='<h2>تسجيل عمولة: مستهلك ← منتج</h2><p class="hint">العدد × قيمة الوحدة = إجمالي الخصم من المستهلك والإضافة للمنتج المرتبط.</p><div class="row"><input id="nPhone" placeholder="رقم المستهلك"><select id="nCategory"><option value="passengers">راكب</option><option value="orders">أوردر</option><option value="special">عمولة خاصة</option></select><input id="nQty" type="number" value="1" min="1" step="1" placeholder="العدد"><input id="nRate" type="number" min=".01" step=".01" placeholder="قيمة الوحدة"></div><p id="nTotal" class="hint">الإجمالي: 0.00 د.أ</p><button id="nSave">تسجيل العملية</button><p id="nMsg"></p>';
old.before(box);const total=()=>{$('nTotal').textContent='الإجمالي: '+money((Number($('nQty').value)||0)*(Number($('nRate').value)||0))};$('nQty').oninput=total;$('nRate').oninput=total;
$('nSave').onclick=async()=>{try{const r=await api('/api/accountant/entry',{method:'POST',body:JSON.stringify({phone:$('nPhone').value,category:$('nCategory').value,quantity:Number($('nQty').value),unitValue:Number($('nRate').value)})});msg($('nMsg'),'تم تسجيل '+r.quantity+' × '+r.unitValue+' = '+money(r.amount),true);load()}catch(e){msg($('nMsg'),e.message)}};
if(token())load();
`));
app.use(express.static(path.join(__dirname, 'public')));

const id = () => crypto.randomUUID();
const money = n => Math.round(Number(n) * 100) / 100;
const WEEKLY_DEDUCT = 0.5;           // يُخصم كل خميس 11:59 مساءً
const MIN_RECHARGE = 10;             // أقل قيمة شحن مسموحة
const baileys = process.env.BAILEYS_ENABLED === 'false' ? null : require('./baileys-bot');

// آخر QR معروض من البوت (للربط من صفحة الويب)
let latestQR = '';
let latestPairingCode = '';
let botConnected = false;
if (baileys) {
  baileys.onQR = (qr, pairingCode) => { latestQR = qr; latestPairingCode = pairingCode || ''; botConnected = false; };
  baileys.onConnected = () => { latestQR = ''; botConnected = true; };
}
app.get('/api/qr-status', (_, res) => {
  if (botConnected) return res.json({ connected: true });
  res.json({ connected: false, qr: latestQR || '', pairingCode: latestPairingCode });
});

// صورة QR جاهزة (SVG) لصفحة الربط
app.get('/api/qr-image', async (_, res) => {
  try {
    if (botConnected || (!latestQR && !latestPairingCode)) return res.status(404).json({ error: 'no-qr' });
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(latestQR, { type: 'svg', margin: 1, width: 320 });
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function emptyStats() { return { passengers: 0, orders: 0, special: 0, totalTrips: 0, totalCommission: 0 }; }

// ============ قاعدة البيانات (Postgres — البيانات لا تضيع أبدًا) ============
// على Railway: أضف Postgres من New → Database واستخدم متغير DATABASE_URL الجاهز
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });

function defaultState() {
  return {
    settings: { groupId: '', whatsappNumber: '', lastWeeklyDeduct: '', passengerCommission: 0.5, orderCommission: 1, specialCommission: 0 },
    accountants: [],
    captains: [],
    pairs: [],
    signupRequests: [],
    ledger: [],
    sessions: {},
    messages: []
  };
}

let cache = null;   // الحالة بالذاكرة للقراءة الفورية

// ترحيل أرقام قديمة للصيغة الدولية 962 — يُنفذ مرة عند كل إقلاع
function migratePhones(s) {
  let changed = 0;
  const mig = list => {
    (list || []).forEach(o => {
      const np = normPhone(o.phone);
      if (np && np !== o.phone) { o.phone = np; changed++; }
    });
  };
  mig(s.captains); mig(s.accountants);
  (s.pairs || []).forEach(p => {
    const c = normPhone(p.consumerPhone), pr = normPhone(p.productPhone);
    if (c !== p.consumerPhone || pr !== p.productPhone) { p.consumerPhone = c; p.productPhone = pr; changed++; }
  });
  if (changed) console.log(`تم ترحيل ${changed} رقم للصيغة الدولية 962`);
  return changed;
}

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

// ============ طلبات إنشاء حساب كابتن (تتطلب موافقة الإدارة) ============
// طلب جديد من صفحة الكابتن — يبقى معلق حتى توافق الإدارة
app.post('/api/signup', (req, res) => {
  const s = load();
  s.signupRequests = s.signupRequests || [];
  const phone = normPhone(req.body.phone);
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  if (!phone || !name || !password) return res.status(400).json({ error: 'الاسم ورقم الهاتف وكلمة السر مطلوبة' });
  if (findCaptain(s, phone) || findAccountant(s, phone)) return res.status(409).json({ error: 'هذا الرقم مسجل مسبقًا — سجل دخول مباشرة' });
  if (s.signupRequests.some(r => r.phone === phone && r.status === 'pending')) return res.status(409).json({ error: 'لديك طلب معلق بالفعل — انتظر موافقة الإدارة' });
  const request = { id: id(), name, phone, email: String(req.body.email || '').trim(), password, status: 'pending', createdAt: new Date().toISOString() };
  s.signupRequests.unshift(request);
  save(s);
  res.status(201).json({ ok: true, message: 'تم إرسال طلبك — لن تستطيع الدخول حتى توافق الإدارة على حسابك' });
});

// عرض الطلبات المعلقة للإدارة
app.get('/api/admin/signup-requests', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  res.json((s.signupRequests || []).filter(r => r.status === 'pending'));
});

// موافقة الإدارة → ينشأ حساب الكابتن فعليًا
app.post('/api/admin/signup-requests/:id/approve', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  s.signupRequests = s.signupRequests || [];
  const request = s.signupRequests.find(r => r.id === req.params.id && r.status === 'pending');
  if (!request) return res.status(404).json({ error: 'الطلب غير موجود أو تمت معالجته' });
  if (findCaptain(s, request.phone)) { request.status = 'rejected'; save(s); return res.status(409).json({ error: 'الرقم مسجل مسبقًا' }); }
  const c = { id: id(), name: request.name, phone: request.phone, email: request.email || '', password: request.password, pin: String(Math.floor(1000 + Math.random() * 9000)), role: 'consumption', balance: -5, removedFromGroup: false, stats: emptyStats(), createdAt: new Date().toISOString() };
  addEntry(s, { type: 'opening', phone: c.phone, amount: -5, note: 'رصيد افتتاحي للكابتن (تسجيل ذاتي مع موافقة الإدارة)' });
  s.captains.unshift(c);
  request.status = 'approved';
  save(s);
  res.status(201).json(c);
});

// رفض الطلب
app.post('/api/admin/signup-requests/:id/reject', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  s.signupRequests = s.signupRequests || [];
  const request = s.signupRequests.find(r => r.id === req.params.id && r.status === 'pending');
  if (!request) return res.status(404).json({ error: 'الطلب غير موجود أو تمت معالجته' });
  request.status = 'rejected';
  save(s);
  res.json({ ok: true });
});

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

// نحول الرقم للصيغة الدولية: نحذف الأصفار والرموز ونضيف 962 تلقائيًا إن لم توجد
const normPhone = p => {
  let digits = String(p || '').replace(/\D/g, '');
  if (digits.startsWith('00962')) digits = digits.slice(5);
  else if (digits.startsWith('962')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1); // صفر البداية المحلي
  if (digits && !digits.startsWith('962')) digits = '962' + digits;
  return digits;
};
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

// إعادة عضو مُزال إلى جروب الواتساب (بياناته محفوظة)
async function addToGroup(phone, groupId) {
  if (!groupId) return { performed: false, reason: 'لم يتم ضبط معرف الجروب بعد' };
  if (baileys) {
    const controlUrl = `http://127.0.0.1:${Number(process.env.BAILEYS_CONTROL_PORT || 4101)}/add-participant`;
    try {
      const response = await fetch(controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-baileys-key': process.env.BAILEYS_CONTROL_KEY || 'shahm-local' }, body: JSON.stringify({ groupId, phone: normPhone(phone) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) return { performed: false, reason: data.error || `Baileys أرجع HTTP ${response.status}` };
      return { performed: true };
    } catch (error) { return { performed: false, reason: `Baileys غير متصل: ${error.message}` }; }
  }
  return { performed: false, reason: 'خدمة WhatsApp غير مفعلة' };
}

// حذف رسالة من الجروب (بدل إزالة الكابتن من الجروب)
async function deleteGroupMessage(messageId, groupId, participant) {
  if (!groupId) return { performed: false, reason: 'لم يتم ضبط معرف الجروب بعد' };
  if (!messageId) return { performed: false, reason: 'لا يوجد معرف رسالة' };
  if (baileys) {
    const controlUrl = `http://127.0.0.1:${Number(process.env.BAILEYS_CONTROL_PORT || 4101)}/delete-message`;
    try {
      const response = await fetch(controlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-baileys-key': process.env.BAILEYS_CONTROL_KEY || 'shahm-local' }, body: JSON.stringify({ groupId, messageId, participant }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) return { performed: false, reason: data.error || `Baileys أرجع HTTP ${response.status}` };
      return { performed: true };
    } catch (error) { return { performed: false, reason: `Baileys غير متصل: ${error.message}` }; }
  }
  return { performed: false, reason: 'خدمة WhatsApp غير مفعلة' };
}

// عند صفر الرصيد: ما عاد منزيله من الجروب — رسائله تنحذف تلقائيًا عند الكتابة/اللايك
async function enforceZeroBalance(s, captain) {
  if (captain.balance > 0) return;
  captain.removedFromGroup = false;
  s.ledger.unshift({ id: id(), type: 'system', phone: captain.phone, amount: 0, note: 'تنبيه: رصيد الكابتن صفر — سيتم حذف رسائله من الجروب تلقائيًا حتى الشحن', createdAt: new Date().toISOString() });
}

// إعادة تلقائية للجروب عند ما رصيد الكابتن يصير فوق الصفر (لم يُعد منزيل أبدًا — مجرد حذف رسائله)
async function reactivateOnPositiveBalance(s, captain) {
  if (!captain) return;
  if (captain.removedFromGroup && captain.balance > 0) captain.removedFromGroup = false;
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
    totals: {
      passengers: s.captains.reduce((t, c) => t + (c.stats?.passengers || 0), 0),
      orders: s.captains.reduce((t, c) => t + (c.stats?.orders || 0), 0),
      special: s.captains.reduce((t, c) => t + (c.stats?.special || 0), 0)
    },
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
  // كل كابتن يبدأ بمديونية تشغيلية ثابتة قدرها 5 دنانير.
  const c = { id: id(), name: String(req.body.name).trim(), phone, email: String(req.body.email || '').trim(), password: String(req.body.password), pin: String(Math.floor(1000 + Math.random() * 9000)), role, balance: -5, removedFromGroup: false, stats: emptyStats(), createdAt: new Date().toISOString() };
  addEntry(s, { type: 'opening', phone, amount: -5, note: 'رصيد افتتاحي للكابتن' });
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
  if (s.captains.includes(c)) await reactivateOnPositiveBalance(s, c);
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

// إعادة عضو مُزال إلى جروب الواتساب (الشرط: رصيده أكبر من صفر — وإلا ينزال تلقائيًا من جديد)
app.post('/api/admin/add-to-group', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  const acc = findAccountant(s, phone);
  const c = findCaptain(s, phone);
  if (!acc && !c) return res.status(404).json({ error: 'رقم غير موجود في النظام' });
  const target = acc || c;
  if (!target.removedFromGroup) return res.status(400).json({ error: 'هذا الحساب غير مُزال من الجروب' });
  if (c && c.balance <= 0) return res.status(400).json({ error: `لا يمكن الإضافة للجروب: رصيد الكابتن ${money(c.balance)} — اشحن رصيد أولًا` });
  const result = await addToGroup(phone, s.settings.groupId);
  if (result.performed) target.removedFromGroup = false;
  addEntry(s, { type: 'system', phone, amount: 0, note: `إعادة إلى جروب الواتساب${result.performed ? '' : ` (تعذرت الإضافة: ${result.reason || ''})`}` });
  save(s);
  res.json({ ok: result.performed, reason: result.reason || '' });
});

// حذف حساب نهائي: يزيل من الجروب أولًا ثم يحذف الحساب وسجل السير (الروابط المرتبطة تُحذف أيضًا)
app.post('/api/admin/delete-account', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  const accIdx = s.accountants.findIndex(a => a.phone === phone);
  const capIdx = s.captains.findIndex(c => c.phone === phone);
  if (accIdx === -1 && capIdx === -1) return res.status(404).json({ error: 'رقم غير موجود في النظام' });
  // إزالة من جروب الواتساب قبل الحذف (أفضل جهد — الحذف يتم حتى لو فشلت الإزالة)
  const result = await removeFromGroup(phone, s.settings.groupId);
  if (accIdx !== -1) s.accountants.splice(accIdx, 1);
  if (capIdx !== -1) s.captains.splice(capIdx, 1);
  // حذف أي روابط ربط تتضمن هذا الرقم
  s.pairs = (s.pairs || []).filter(p => p.consumerPhone !== phone && p.productPhone !== phone);
  // حذف جلساته النشطة
  Object.keys(s.sessions || {}).forEach(tk => { if (s.sessions[tk].phone === phone) delete s.sessions[tk]; });
  addEntry(s, { type: 'system', phone, amount: 0, note: `حذف حساب نهائي من النظام${result.performed ? ' (وأزيل من الجروب)' : ` (تعذرت إزالته من الجروب: ${result.reason || ''})`}` });
  save(s);
  res.json({ ok: true, removedFromGroup: result.performed, reason: result.reason || '' });
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
  if (req.body.whatsappNumber !== undefined) s.settings.whatsappNumber = normPhone(req.body.whatsappNumber);
  if (req.body.passengerCommission !== undefined) s.settings.passengerCommission = money(Math.max(0, Number(req.body.passengerCommission) || 0));
  if (req.body.orderCommission !== undefined) s.settings.orderCommission = money(Math.max(0, Number(req.body.orderCommission) || 0));
  if (req.body.specialCommission !== undefined) s.settings.specialCommission = money(Math.max(0, Number(req.body.specialCommission) || 0));
  if (req.body.groupId === undefined) { save(s); return res.json(s.settings); }
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

// تنظيف الجروب: إزالة أي رقم مش مربوط بحساب (كابتن/محاسب) أو رصيده صفر أو أقل
app.post('/api/admin/cleanup-group', async (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  if (!baileys) return res.status(502).json({ error: 'خدمة WhatsApp غير مفعلة' });
  if (!s.settings.groupId) return res.status(400).json({ error: 'لا يوجد جروب مربوط — اربط الجروب أولًا' });
  try {
    const controlUrl = `http://127.0.0.1:${Number(process.env.BAILEYS_CONTROL_PORT || 4101)}/list-participants`;
    const headers = { 'Content-Type': 'application/json', 'x-baileys-key': process.env.BAILEYS_CONTROL_KEY || 'shahm-local' };
    const response = await fetch(controlUrl, { method: 'POST', headers, body: JSON.stringify({ groupId: s.settings.groupId }) });
    const data = await response.json();
    if (!response.ok || !data.ok) return res.status(502).json({ error: data.error || 'تعذر قراءة أعضاء الجروب' });
    const allowed = new Set([...s.captains.filter(c => c.balance > 0), ...s.accountants].map(c => String(c.phone).replace(/\D/g, '')));
    // رقم واتساب البوت نفسه ما بينزال
    const botNumber = String(baileys.getOwnerNumber() || '').replace(/\D/g, '');
    if (botNumber) allowed.add(botNumber);
    const removed = [], failed = [];
    for (const p of (data.participants || [])) {
      const phone = String(p).replace(/\D/g, '');
      if (allowed.has(phone)) continue;
    const result = await removeFromGroup(phone, s.settings.groupId);
      if (result.performed) removed.push(phone);
      else failed.push({ phone, reason: result.reason || 'تعذرت الإزالة' });
    }
    addEntry(s, { type: 'system', phone: 'admin', amount: 0, note: `تنظيف الجروب: تمت إزالة ${removed.length} رقم غير مسجل/بدون رصيد${failed.length ? ` — فشل: ${failed.map(f => f.phone).join(', ')}` : ''}` });
    save(s);
    res.json({ ok: true, removed, failed, total: (data.participants || []).length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============ صفحة المحاسب ============
app.get('/api/accountant/me', (req, res) => {
  const s = load();
  const acc = accountantAuth(req, res, s); if (!acc) return;
  const consumers = s.captains.filter(c => c.role === 'consumption').map(c => ({ phone: c.phone, name: c.name, balance: c.balance, stats: c.stats || emptyStats(), linkedPhone: (s.pairs.find(p => p.consumerPhone === c.phone) || {}).productPhone || '' }));
  const products = s.captains.filter(c => c.role === 'production').map(c => ({ phone: c.phone, name: c.name, balance: c.balance, stats: c.stats || emptyStats(), linkedPhone: (s.pairs.find(p => p.productPhone === c.phone) || {}).consumerPhone || '' }));
  const all = [...consumers, ...products];
  const totals = { passengers: all.reduce((t, c) => t + (c.stats.passengers || 0), 0), orders: all.reduce((t, c) => t + (c.stats.orders || 0), 0), special: all.reduce((t, c) => t + (c.stats.special || 0), 0) };
  res.json({ name: acc.name, phone: acc.phone, pin: acc.pin, balance: acc.balance, consumers, products, totals });
});

// إرسال رصيد من محفظة المحاسب فقط
app.post('/api/accountant/send-balance', async (req, res) => {
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
  if (s.captains.includes(target)) await reactivateOnPositiveBalance(s, target);
  save(s); res.json({ balance: acc.balance });
});

// البحث عن رقم للإزالة من الجروب
app.post('/api/admin/send-to-accountant', (req, res) => {
  if (!admin(req, res)) return;
  const s = load();
  const phone = normPhone(req.body.phone);
  const amount = money(req.body.amount);
  const acc = findAccountant(s, phone);
  if (!acc) return res.status(404).json({ error: 'المحاسب غير موجود' });
  if (amount <= 0) return res.status(400).json({ error: 'أدخل مبلغًا موجبًا' });
  acc.balance = money(acc.balance + amount);
  addEntry(s, { type: 'admin-transfer', phone, amount, note: 'تحويل من الإدارة إلى محفظة المحاسب', linkedPhone: 'admin' });
  save(s);
  res.json({ balance: acc.balance });
});

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
// القيد المحاسبي الموحد: الاستهلاك دائمًا سالب والإنتاج المقابل دائمًا موجب.
app.post('/api/accountant/entry', async (req, res) => {
  const s = load();
  const acc = accountantAuth(req, res, s); if (!acc) return;
  const phone = normPhone(req.body.phone);
  const category = ['passengers', 'orders', 'special'].includes(req.body.category) ? req.body.category : 'passengers';
  const quantity = Number(req.body.quantity ?? 1);
  const configuredRate = category === 'orders' ? s.settings.orderCommission : (category === 'special' ? s.settings.specialCommission : s.settings.passengerCommission);
  const unitValue = money(Math.abs(Number(req.body.unitValue ?? req.body.amount ?? configuredRate) || 0));
  const amount = money(quantity * unitValue);
  const consumer = findCaptain(s, phone);
  if (!consumer) return res.status(404).json({ error: 'الكابتن غير موجود' });
  if (!Number.isInteger(quantity) || quantity <= 0 || unitValue <= 0 || amount <= 0) return res.status(400).json({ error: 'أدخل عددًا صحيحًا موجبًا وقيمة عمولة موجبة' });
  if (consumer.role !== 'consumption') return res.status(400).json({ error: 'العمولة تُسجل على كابتن مستهلك فقط' });
  const pair = s.pairs.find(p => p.consumerPhone === phone);
  const product = pair && findCaptain(s, pair.productPhone);
  if (!product) return res.status(400).json({ error: 'اربط المستهلك بكابتن منتج قبل تسجيل العمولة' });
  if (consumer.balance < amount) return res.status(400).json({ error: 'محفظة المستهلك لا تكفي لإتمام العملية' });
  consumer.balance = money(consumer.balance - amount);
  consumer.stats = consumer.stats || emptyStats();
  consumer.stats[category] = (consumer.stats[category] || 0) + quantity;
  consumer.stats.totalTrips = (consumer.stats.totalTrips || 0) + quantity;
  consumer.stats.totalCommission = money((consumer.stats.totalCommission || 0) + amount);
  const labels = { passengers: 'راكب', orders: 'أوردر', special: 'عمولة خاصة' };
  const note = `${labels[category]}: ${quantity} × ${unitValue} = ${amount}`;
  addEntry(s, { type: 'consumption', phone, amount: -amount, note, linkedPhone: product.phone });
  product.balance = money(product.balance + amount);
  product.stats = product.stats || emptyStats();
  product.stats[category] = (product.stats[category] || 0) + quantity;
  product.stats.totalTrips = (product.stats.totalTrips || 0) + quantity;
  product.stats.totalCommission = money((product.stats.totalCommission || 0) + amount);
  addEntry(s, { type: 'production', phone: product.phone, amount, note: `إنتاج مقابل ${phone} — ${note}`, linkedPhone: phone });
  await enforceZeroBalance(s, consumer);
  await reactivateOnPositiveBalance(s, product);
  save(s);
  res.json({ ok: true, amount, quantity, unitValue, category });
});

app.post('/api/accountant/entry-legacy', async (req, res) => {
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
  await reactivateOnPositiveBalance(s, c);
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
      // رصيده ما بيكفي → ما بينزال من الجروب، بس ما بيواخد عمولة (اللايك بينسي)
      addEntry(s, { type: 'system', phone: from, amount: 0, note: `لايك مرفوض: رصيده لا يكفي عمولة ${category === 'orders' ? 'أوردر' : 'راكب'} (${rate}) — اشحن رصيد` });
      save(s);
      return res.json({ ok: true, status: 'insufficient-ignored' });
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
    if (pair) await reactivateOnPositiveBalance(s, findCaptain(s, pair.productPhone));
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
    // ممنوع يكتب بالجروب لو محفظته صفر → نحذف رسالته فورًا (بدل إزالته من الجروب)
    if (c && c.balance <= 0) {
      const result = await deleteGroupMessage(event.id, event.groupId || groupId, from);
      addEntry(s, { type: 'system', phone: from, amount: 0, note: `حُذفت رسالة كابتن رصيده صفر من الجروب${result.performed ? '' : ` (${result.reason || ''})`}` });
      save(s);
      return res.json({ ok: true, status: 'message-deleted-zero-balance' });
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
app.get('/control-room', (_, res) => {
  const page = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
  const enhancement = `<script>
  (() => {
    const panel = document.getElementById('panel');
    const settingsRow = document.getElementById('cOrder')?.parentElement?.parentElement;
    if (settingsRow && !document.getElementById('cSpecial')) {
      const label = document.createElement('label'); label.textContent = 'قيمة العمولة الخاصة';
      label.innerHTML += '<input id="cSpecial" type="number" min="0" step=".01">'; settingsRow.appendChild(label);
      const save = document.getElementById('saveSettings');
      save?.addEventListener('click', () => setTimeout(async () => {
        const key = document.getElementById('key').value.trim();
        await fetch('/api/admin/settings', { method:'POST', headers:{'Content-Type':'application/json','x-admin-key':key}, body:JSON.stringify({ specialCommission:Number(document.getElementById('cSpecial').value)||0 }) });
      }, 0));
    }
    const transfer = document.createElement('article'); transfer.innerHTML = '<h2>إرسال رصيد للمحاسب</h2><p class="hint">يُضاف الرصيد مباشرة لمحفظة المحاسب.</p><div class="row"><input id="adminAccPhone" placeholder="رقم المحاسب"><input id="adminAccAmount" type="number" min=".01" step=".01" placeholder="المبلغ"></div><button id="adminAccSend">إرسال للمحاسب</button><p id="adminAccMsg"></p>';
    if (panel && !document.getElementById('adminAccSend')) panel.appendChild(transfer);
    document.getElementById('adminAccSend')?.addEventListener('click', async () => { const out=document.getElementById('adminAccMsg'); try { const r=await fetch('/api/admin/send-to-accountant',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':document.getElementById('key').value.trim()},body:JSON.stringify({phone:document.getElementById('adminAccPhone').value,amount:Number(document.getElementById('adminAccAmount').value)})}); const d=await r.json(); if(!r.ok)throw Error(d.error); out.textContent='تم الإرسال. رصيد المحاسب: '+Number(d.balance).toFixed(2)+' د.أ'; out.className='ok'; }catch(e){out.textContent=e.message;out.className='bad';} });
  })();
  </script>`;
  res.type('html').send(page.replace('</body>', enhancement + '</body>'));
});
app.get('/accountant', (_, res) => res.sendFile(path.join(__dirname, 'public', 'accountant.html')));
app.get('/captain', (_, res) => res.sendFile(path.join(__dirname, 'public', 'captain.html')));
initDB()
  .then(() => {
    migratePhones(load()); if (process.env.DATABASE_URL) save(load()); else save(load());
    app.listen(PORT, '0.0.0.0', () => console.log(`Shahm running on ${PORT} — البيانات محفوظة دائمًا`));
  })
  .catch(err => {
    console.error('فشل الاتصال بقاعدة البيانات:', err.message);
    console.log('نكمل بالوضع المحلي (الملف data/state.json)...');
    cache = null;
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = defaultState(); }
    migratePhones(cache); save(cache);
    app.listen(PORT, '0.0.0.0', () => console.log(`Shahm running on ${PORT} — وضع محلي`));
  });
