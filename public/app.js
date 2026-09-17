const $ = id => document.getElementById(id);
const headers = () => ({ 'Content-Type': 'application/json', 'x-admin-key': $('key').value.trim() });
const esc = t => String(t ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const money = v => `${Number(v || 0).toFixed(2)} د.أ`;
function msg(el, text, ok = false) { el.textContent = text; el.className = ok ? 'ok' : 'bad'; }
async function api(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { ...headers(), ...(opt.headers || {}) } });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'حدث خطأ');
  return d;
}
let accounts = [];

async function loadAll() {
  try {
    accounts = await api('/api/admin/accounts');
    renderAccounts(); renderCommissions(); renderLedger(); renderRequests();
    const s = await api('/api/admin/settings');
    $('wa').value = s.whatsappNumber || ''; $('group').value = s.groupId || '';
    $('cPass').value = s.passengerCommission ?? 0.5; $('cOrder').value = s.orderCommission ?? 1;
  } catch (e) { msg($('loginMsg'), e.message); }
}
function renderCommissions() {
  $('cConsumption').textContent = money(accounts.commissions.consumption);
  $('cProduction').textContent = money(accounts.commissions.production);
  const totals = accounts.totals || { passengers: 0, orders: 0, special: 0 };
  const el = document.getElementById('tPassengers');
  if (el) el.textContent = totals.passengers;
  const elO = document.getElementById('tOrders');
  if (elO) elO.textContent = totals.orders;
  const elS = document.getElementById('tSpecial');
  if (elS) elS.textContent = totals.special;
}
function accountRow(a, kind) {
  const roleLabel = kind === 'acc' ? 'محاسب' : (a.role === 'consumption' ? 'مستهلك' : 'منتج');
  const stats = a.stats ? ` · 🚶 ${a.stats.passengers || 0} راكب · 📦 ${a.stats.orders || 0} أوردر` : '';
  return `<div class="ledger"><span><b>${esc(a.name)}</b> <small>${roleLabel} · ${a.phone} · ${esc(a.email || '')} · الرقم السري: ${a.pin}${stats}</small></span>
 <span class="actions"><b class="${a.balance > 0 ? 'ok' : 'bad'}">${money(a.balance)}</b>
  ${a.removedFromGroup ? `<small class="bad">مزال من الجروب</small> <button onclick="addToGroup('${a.phone}')">إضافة للجروب</button>` : ''}
  ${a.removedFromGroup ? '' : `<button onclick="removeFromGroup('${a.phone}')">إزالة من الجروب</button>`}<button onclick="deleteAccount('${a.phone}', '${esc(a.name)}')" style="background:#c0392b">حذف الحساب</button></span></div>`;
}
function renderAccounts() {
  const q = $('search').value.trim().replace(/\D/g, '');
  const accs = accounts.accountants.filter(a => !q || a.phone.includes(q));
  const caps = accounts.captains.filter(c => !q || c.phone.includes(q));
  $('accounts').innerHTML =
    `<h3>المحاسبون</h3>${accs.map(a => accountRow(a, 'acc')).join('') || '<small>لا يوجد</small>'}
     <h3>الكباتن</h3>${caps.map(c => accountRow(c, 'cap')).join('') || '<small>لا يوجد</small>'}
     <h3>الروابط (مستهلك ← منتج)</h3>${accounts.pairs.map(p => `<div class="ledger"><small>${p.consumerPhone} ← ${p.productPhone}</small></div>`).join('') || '<small>لا يوجد ربط</small>'}`;
}
async function renderLedger() {
  try {
    const ledger = await api('/api/admin/ledger');
    const label = { consumption: 'استهلاك', production: 'إنتاج', topup: 'شحن', withdraw: 'سحب', transfer: 'تحويل', weekly: 'خصم أسبوعي', system: 'نظام' };
    $('ledger').innerHTML = ledger.map(e => `<div class="ledger"><span>${label[e.type] || e.type}<small>${e.phone} ${e.note || ''} ${e.createdAt}</small></span><b class="${e.amount < 0 ? 'bad' : 'ok'}">${e.amount > 0 ? '+' : ''}${money(e.amount)}</b></div>`).join('') || '<small>لا يوجد عمليات</small>';
  } catch (e) { }
}
window.deleteAccount = async (phone, name) => {
  if (!confirm(`⚠️ حذف حساب ${name} (${phone}) نهائيًا؟\nسيُزال من جروب الواتساب وستُحذف كل بياناته وروابطه — لا يمكن التراجع!`)) return;
  try { const r = await api('/api/admin/delete-account', { method: 'POST', body: JSON.stringify({ phone }) }); alert(r.removedFromGroup ? 'تم حذف الحساب وإزالته من الجروب' : `تم حذف الحساب (تعذرت إزالته من الجروب: ${r.reason || 'غير محدد'})`); loadAll(); }
  catch (e) { alert(e.message); }
};
window.addToGroup = async phone => {
  if (!confirm(`إعادة ${phone} إلى جروب الواتساب؟`)) return;
  try { const r = await api('/api/admin/add-to-group', { method: 'POST', body: JSON.stringify({ phone }) }); alert(r.ok ? 'تمت الإضافة للجروب' : `تعذرت الإضافة: ${r.reason}`); loadAll(); }
  catch (e) { alert(e.message); }
};
window.removeFromGroup = async phone => {
  if (!confirm(`إزالة ${phone} من جروب الواتساب؟ (بياناته ستبقى محفوظة)`)) return;
  try { const r = await api('/api/admin/remove-from-group', { method: 'POST', body: JSON.stringify({ phone }) }); alert(r.ok ? 'تمت الإزالة من الجروب' : `تعذرت الإزالة: ${r.reason}`); loadAll(); }
  catch (e) { alert(e.message); }
};
$('login').onclick = () => { loadAll().then(() => { $('panel').hidden = false; $('loginCard').hidden = true; }).catch(() => { }); };
$('saveSettings').onclick = async () => { try { const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ whatsappNumber: $('wa').value, groupId: $('group').value, passengerCommission: Number($('cPass').value) || 0.5, orderCommission: Number($('cOrder').value) || 1 }) }); msg($('setMsg'), r.message || 'تم الحفظ — الجروب مربوط وجاهز للإزالة', true); } catch (e) { msg($('setMsg'), e.message); } };
$('verifyGroup').onclick = async () => {
  try { const r = await api('/api/admin/verify-group', { method: 'POST' }); msg($('setMsg'), r.message, true); loadAll(); }
  catch (e) { msg($('setMsg'), e.message); }
};
$('createAcc').onclick = async () => {
  try { const a = await api('/api/admin/accountants', { method: 'POST', body: JSON.stringify({ name: $('accName').value, phone: $('accPhone').value, email: $('accEmail').value, password: $('accPass').value }) }); msg($('accMsg'), `تم الإنشاء — الرقم السري: ${a.pin}`, true); loadAll(); }
  catch (e) { msg($('accMsg'), e.message); }
};
$('createCap').onclick = async () => {
  try { const c = await api('/api/admin/captains', { method: 'POST', body: JSON.stringify({ name: $('capName').value, phone: $('capPhone').value, email: $('capEmail').value, password: $('capPass').value }) }); msg($('capMsg'), `تم الإنشاء — الرقم السري: ${c.pin}`, true); loadAll(); }
  catch (e) { msg($('capMsg'), e.message); }
};
$('topup').onclick = async () => {
  try { const r = await api('/api/admin/topup', { method: 'POST', body: JSON.stringify({ phone: $('topPhone').value, amount: Number($('topAmount').value) }) }); msg($('topMsg'), `تم الشحن — الرصيد الآن ${money(r.balance)}`, true); loadAll(); }
  catch (e) { msg($('topMsg'), e.message); }
};
$('withdraw').onclick = async () => {
  try { const r = await api('/api/admin/withdraw', { method: 'POST', body: JSON.stringify({ phone: $('wdPhone').value, amount: Number($('wdAmount').value) }) }); msg($('wdMsg'), `تم السحب — الرصيد الآن ${money(r.balance)}`, true); loadAll(); }
  catch (e) { msg($('wdMsg'), e.message); }
};
$('addPair').onclick = async () => {
  try { await api('/api/admin/pairs', { method: 'POST', body: JSON.stringify({ consumerPhone: $('pairConsumer').value, productPhone: $('pairProduct').value }) }); msg($('pairMsg'), 'تم الربط', true); loadAll(); }
  catch (e) { msg($('pairMsg'), e.message); }
};
$('refreshLedger').onclick = renderLedger;
$('search').oninput = renderAccounts;

// ============ طلبات إنشاء الحساب ============
async function renderRequests() {
  try {
    const requests = await api('/api/admin/signup-requests');
    $('signupRequestsCard').hidden = requests.length === 0;
    $('signupRequests').innerHTML = requests.map(r => `<div class="ledger"><span><b>${esc(r.name)}</b><small>${r.phone} · ${esc(r.email || '')} · ${r.createdAt}</small></span><span class="actions"><button onclick="approveReq('${r.id}')">موافقة وإنشاء</button><button onclick="rejectReq('${r.id}')" style="background:#c0392b">رفض</button></span></div>`).join('') || '<small>لا يوجد طلبات معلقة</small>';
  } catch { }
}
window.approveReq = async id => {
  try { const c = await api(`/api/admin/signup-requests/${id}/approve`, { method: 'POST' }); alert(`تم إنشاء حساب ${c.name} — الرقم السري: ${c.pin}`); renderRequests(); loadAll(); }
  catch (e) { alert(e.message); }
};
window.rejectReq = async id => {
  if (!confirm('رفض هذا الطلب؟')) return;
  try { await api(`/api/admin/signup-requests/${id}/reject`, { method: 'POST' }); renderRequests(); }
  catch (e) { alert(e.message); }
};
