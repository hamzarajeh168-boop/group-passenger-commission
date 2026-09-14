const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'shahm-2026';
const FILE = path.join(__dirname, 'data', 'state.json');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const id = () => crypto.randomUUID();
const money = n => Math.round(Number(n) * 100) / 100;
const MINIMUM_BALANCE = 0.75;
function emptyStats() { return { passengers: 0, orders: 0, fullCars: 0, other: 0, totalTrips: 0, totalCommission: 0 }; }
function captainStats(captain) { captain.stats = { ...emptyStats(), ...(captain.stats || {}) }; return captain.stats; }
function categoryFor(rule, text) {
  const value = `${String(rule && rule.label || '')} ${String(text || '')}`.toLocaleLowerCase('ar');
  if (value.includes('سيارة كاملة') || value.includes('سياره كامله') || value.includes('full')) return 'fullCars';
  if (value.includes('راكب') || value.includes('passenger')) return 'passengers';
  if (value.includes('اوردر') || value.includes('أوردر') || value.includes('order')) return 'orders';
  return 'other';
}
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { settings: { whatsappNumber: '', groupId: '', likeEmoji: '👍', enabled: true, rules: [] }, captains: [], messages: [], likes: [], ledger: [] }; } }
function save(s) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(FILE + '.tmp', FILE); }
function admin(req, res) { if (req.get('x-admin-key') !== ADMIN_KEY) { res.status(401).json({ error: 'كلمة سر غرفة التحكم غير صحيحة' }); return false; } return true; }
function ruleFor(text, rules) { const value = String(text || '').toLocaleLowerCase('ar'); return (rules || []).find(r => r.enabled !== false && r.match && value.includes(String(r.match).toLocaleLowerCase('ar'))) || null; }
async function removeFromGroup(phone, groupId) {
  const instance = process.env.GREEN_API_INSTANCE_ID;
  const token = process.env.GREEN_API_TOKEN;
  if (!instance || !token || !groupId) return { attempted: false, performed: false, reason: 'بيانات Green API أو Group ID غير مكتملة' };
  const url = `${process.env.GREEN_API_URL || 'https://api.green-api.com'}/waInstance${encodeURIComponent(instance)}/removeGroupParticipant/${encodeURIComponent(token)}`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: groupId, participant: `${String(phone).replace(/\D/g, '')}@c.us` }) });
  if (!response.ok) return { attempted: true, performed: false, reason: `Green API returned HTTP ${response.status}` };
  return { attempted: true, performed: true };
}
app.get('/api/health', (_, res) => res.json({ ok: true, app: 'شهم' }));
app.get('/api/settings', (req, res) => { if (admin(req, res)) res.json(load().settings); });
app.put('/api/settings', (req, res) => { if (!admin(req, res)) return; const s = load(); s.settings = { whatsappNumber: String(req.body.whatsappNumber || '').trim(), groupId: String(req.body.groupId || '').trim(), likeEmoji: String(req.body.likeEmoji || '👍').trim(), enabled: req.body.enabled !== false, rules: (Array.isArray(req.body.rules) ? req.body.rules : []).filter(r => String(r.match || '').trim()).map(r => ({ id: String(r.id || id()), label: String(r.label || r.match), match: String(r.match).trim(), commission: money(Math.max(0, Number(r.commission) || 0)), enabled: r.enabled !== false })) }; save(s); res.json(s.settings); });
app.get('/api/captains', (req, res) => { if (admin(req, res)) res.json(load().captains); });
app.post('/api/captains', (req, res) => { if (!admin(req, res)) return; const s = load(); const phone = String(req.body.phone || '').replace(/\D/g, ''); if (!phone || !String(req.body.name || '').trim()) return res.status(400).json({ error: 'أدخل اسم الكابتن ورقم الهاتف' }); if (s.captains.some(c => c.phone === phone)) return res.status(409).json({ error: 'الحساب موجود مسبقًا' }); const captain = { id: id(), code: `SH-${Math.floor(100000 + Math.random() * 900000)}`, name: String(req.body.name).trim(), phone, balance: 0, status: 'active', stats: emptyStats(), createdAt: new Date().toISOString() }; s.captains.unshift(captain); save(s); res.status(201).json(captain); });
app.post('/api/captains/:id/status', (req, res) => { if (!admin(req, res)) return; const s = load(); const c = s.captains.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'الكابتن غير موجود' }); if (!['active', 'paused', 'blocked'].includes(req.body.status)) return res.status(400).json({ error: 'حالة غير صحيحة' }); c.status = req.body.status; save(s); res.json(c); });
app.post('/api/wallet/topup', (req, res) => { if (!admin(req, res)) return; const s = load(); const phone = String(req.body.phone || '').replace(/\D/g, ''); const amount = money(req.body.amount); const c = s.captains.find(x => x.phone === phone); if (!c || amount <= 0) return res.status(400).json({ error: 'رقم الكابتن غير موجود أو القيمة غير صحيحة' }); c.balance = money(c.balance + amount); s.ledger.unshift({ id: id(), captainId: c.id, phone, type: 'topup', amount, note: 'شحن رصيد من غرفة التحكم', createdAt: new Date().toISOString() }); save(s); res.json(c); });
app.get('/api/ledger', (req, res) => { if (admin(req, res)) res.json(load().ledger); });
app.post('/webhook/group', async (req, res) => { const event = req.body || {}; const s = load(); if (event.type === 'message' && event.id) { if (!s.messages.some(m => m.id === event.id)) s.messages.push({ id: event.id, from: String(event.from || ''), text: String(event.text || ''), replyTo: String(event.replyTo || ''), createdAt: new Date().toISOString() }); save(s); return res.json({ ok: true, status: 'message-saved' }); } if (event.type !== 'like') return res.json({ ok: true, status: 'ignored' }); if (s.likes.some(x => x.id === event.id)) return res.json({ ok: true, status: 'duplicate' }); const reply = s.messages.find(m => m.id === event.replyId); const original = reply && s.messages.find(m => m.id === reply.replyTo); const captain = s.captains.find(c => c.phone === String(event.from || '').replace(/\D/g, '')); const rule = ruleFor(original && original.text, s.settings.rules); const record = { id: event.id || id(), captainPhone: event.from, replyId: event.replyId, requestText: original ? original.text : '', status: 'rejected', createdAt: new Date().toISOString() }; let insufficientBalance = false; if (!captain || !reply || !original || event.emoji !== s.settings.likeEmoji || !rule) record.reason = 'لا يوجد سياق مكتمل أو قاعدة عمولة مطابقة'; else if (captain.status !== 'active') record.reason = 'حساب الكابتن موقوف أو محظور'; else if (captain.balance < MINIMUM_BALANCE) { insufficientBalance = true; record.reason = `الرصيد أقل من الحد الأدنى ${MINIMUM_BALANCE.toFixed(2)} - يمنع أخذ أي طلب وسيتم إزالة الرقم من الجروب`; } else if (captain.balance < rule.commission) { insufficientBalance = true; record.reason = 'الرصيد أقل من عمولة هذا الطلب - يمنع أخذ الطلب وسيتم إزالة الرقم من الجروب حتى يتم الشحن'; } else { captain.balance = money(captain.balance - rule.commission); const stats = captainStats(captain); const category = categoryFor(rule, original.text); stats[category] += 1; stats.totalTrips += 1; stats.totalCommission = money(stats.totalCommission + rule.commission); record.status = 'charged'; record.commission = rule.commission; record.rule = rule.label; record.category = category; s.ledger.unshift({ id: id(), captainId: captain.id, phone: captain.phone, type: 'commission', amount: -rule.commission, rule: rule.label, category, requestText: original.text, replyId: reply.id, createdAt: record.createdAt }); } if (insufficientBalance) record.groupRemoval = await removeFromGroup(captain.phone, event.groupId || s.settings.groupId); s.likes.unshift(record); save(s); res.json({ ok: true, ...record, minimumBalance: MINIMUM_BALANCE, removeLike: false }); });
app.get('/control-room', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Shahm running on ${PORT}`));
