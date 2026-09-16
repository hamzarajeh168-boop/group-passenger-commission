const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const money = v => `${Number(v || 0).toFixed(2)} د.أ`;
function msg(el, text, ok = false) { el.textContent = text; el.className = ok ? 'ok' : 'bad'; }
const token = () => localStorage.getItem('shahm-token') || '';
async function api(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', 'x-token': token() } });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'حدث خطأ');
  return d;
}
function captainCard(c, role) {
  const roleLabel = role === 'consumption' ? 'مستهلك' : 'منتج';
  const sign = role === 'consumption' ? '−' : '+';
  const signClass = role === 'consumption' ? 'bad' : 'ok';
  return `<div class="ledger"><span><b>${esc(c.name)}</b> <small>${roleLabel} · ${c.phone}${c.linkedPhone ? ` · مرتبط بـ ${c.linkedPhone}` : ''}${c.removedFromGroup ? ' · <b class="bad">مزال من الجروب</b>' : ''}</small>
 <small>🚶 راكب: ${c.stats.passengers || 0} <b class="${signClass}">${sign}${money(c.stats.totalCommission || 0)}</b> · 📦 أوردر: ${c.stats.orders || 0}</small></span>
 <b class="${c.balance > 0 ? 'ok' : 'bad'}">${money(c.balance)}</b></div>`;
}
async function loadMe() {
  try {
    const me = await api('/api/accountant/me');
    $('accName').textContent = me.name;
    $('accIdentity').textContent = `${me.phone} · الرقم السري: ${me.pin}`;
    $('accBalance').textContent = money(me.balance);
    $('consumers').innerHTML = me.consumers.map(c => captainCard(c, 'consumption')).join('') || '<small>لا يوجد مستهلكون</small>';
    $('products').innerHTML = me.products.map(c => captainCard(c, 'production')).join('') || '<small>لا يوجد منتجون</small>';
    $('panel').hidden = false; $('loginCard').hidden = true;
  } catch (e) { msg($('loginMsg'), e.message); }
}
$('login').onclick = async () => {
  try {
    const r = await api('/api/accountant/login', { method: 'POST', body: JSON.stringify({ phone: $('phone').value, password: $('password').value }) });
    localStorage.setItem('shahm-token', r.token);
    loadMe();
  } catch (e) { msg($('loginMsg'), e.message); }
};
$('logout').onclick = () => { localStorage.removeItem('shahm-token'); location.reload(); };
$('sendBalance').onclick = async () => {
  try { const r = await api('/api/accountant/send-balance', { method: 'POST', body: JSON.stringify({ phone: $('sendPhone').value, amount: Number($('sendAmount').value) }) }); msg($('sendMsg'), `تم الإرسال — محفظتك الآن ${money(r.balance)}`, true); loadMe(); }
  catch (e) { msg($('sendMsg'), e.message); }
};
$('searchBtn').onclick = async () => {
  try {
    const r = await api('/api/accountant/search?phone=' + encodeURIComponent($('rmPhone').value));
    $('searchResult').innerHTML = `<div class="ledger"><span><b>${esc(r.name)}</b> <small>${r.role} · ${r.phone} · الرصيد ${money(r.balance)}${r.removedFromGroup ? ' · مزال مسبقًا' : ''}</small></span><button onclick="doRemove('${r.phone}')">إزالة</button></div>`;
  } catch (e) { $('searchResult').innerHTML = `<small class="bad">${e.message}</small>`; }
};
window.doRemove = async phone => {
  if (!confirm(`إزالة ${phone} من جروب الواتساب؟ بياناته ستبقى محفوظة`)) return;
  try { const r = await api('/api/accountant/remove-from-group', { method: 'POST', body: JSON.stringify({ phone }) }); alert(r.ok ? 'تمت الإزالة من الجروب' : `تعذرت الإزالة: ${r.reason}`); loadMe(); }
  catch (e) { alert(e.message); }
};
$('addEntry').onclick = async () => {
  try { await api('/api/accountant/entry', { method: 'POST', body: JSON.stringify({ phone: $('entryPhone').value, amount: Number($('entryAmount').value), kind: $('entryKind').value }) }); msg($('entryMsg'), 'تمت الإضافة', true); loadMe(); }
  catch (e) { msg($('entryMsg'), e.message); }
};
if (token()) loadMe();
