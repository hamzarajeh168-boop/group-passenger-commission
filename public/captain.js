const $ = id => document.getElementById(id);
const money = value => `${Number(value || 0).toFixed(2)}`;
function showMessage(text, ok = false) { const el = $('loginMsg'); el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'bad'); }
const token = () => localStorage.getItem('shahm-captain-token') || '';
async function api(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', 'x-token': token() } });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'حدث خطأ');
  return d;
}
// تبويبات الدخول/التسجيل
$('tabLogin').onclick = () => { $('tabLogin').classList.add('on'); $('tabSignup').classList.remove('on'); $('loginBox').classList.remove('hidden'); $('signupBox').classList.add('hidden'); };
$('tabSignup').onclick = () => { $('tabSignup').classList.add('on'); $('tabLogin').classList.remove('on'); $('signupBox').classList.remove('hidden'); $('loginBox').classList.add('hidden'); };
// الرقم: يُضاف 962 تلقائياً عند الإرسال
const fullPhone = v => { const d = String(v || '').replace(/\D/g, ''); return d.startsWith('962') ? d : '962' + d.replace(/^0+/, ''); };
function render(c) {
  $('capName').textContent = c.name;
  $('capInitial').textContent = (c.name || '؟').trim()[0] || '؟';
  $('capIdentity').textContent = `${c.phone} · الرقم السري: ${c.pin}`;
  $('balance').textContent = money(c.balance);
  $('category').textContent = `🏷️ فئتي: ${c.autoCategory || '—'}`;
  $('consumptionTotal').textContent = money(c.consumptionTotal || 0);
  $('productionTotal').textContent = money(c.productionTotal || 0);
  $('linked').textContent = c.linkedPhone || '—';
  const st = $('capStatus');
  st.textContent = c.balance <= 0 ? '⚠️ رصيدك صفر — رسائلك بالجروب تنحذف تلقائيًا' : (c.removedFromGroup ? '⛔ مزال من جروب الواتساب' : '✅ فعّال في الجروب');
  st.className = 'msg ' + (c.balance <= 0 ? 'bad' : 'ok');
  $('zeroWarn').classList.toggle('hidden', c.balance > 0);
  const entries = c.ledger || [];
  const sum = entries.reduce((t, e) => t + Number(e.amount || 0), 0);
  $('ledgerSummary').textContent = `عدد الحركات: ${entries.length} · صافي الجرد: ${sum >= 0 ? '+' : ''}${money(sum)} د.أ`;
  const label = { consumption: 'استهلاك', production: 'إنتاج', topup: 'شحن', withdraw: 'سحب', transfer: 'تحويل', weekly: 'خصم أسبوعي', system: 'نظام' };
  $('ledger').innerHTML = entries.map(e => `<div class="led"><div><div class="t">${label[e.type] || e.type}</div><div class="d">${e.note || ''} · ${new Date(e.createdAt).toLocaleString('ar-EG')}</div></div><span class="amt ${e.amount < 0 ? 'bad' : 'ok'}">${e.amount > 0 ? '+' : ''}${money(e.amount)}</span></div>`).join('') || '<p class="sub">لا يوجد عمليات بعد</p>';
  $('authView').classList.add('hidden');
  $('panelView').classList.remove('hidden');
  window.scrollTo(0, 0);
}
async function loadMe() {
  try { render(await api('/api/captain/me')); }
  catch (e) { showMessage(e.message); }
}
$('login').onclick = async () => {
  try {
    const r = await api('/api/captain/login', { method: 'POST', body: JSON.stringify({ phone: fullPhone($('phone').value), password: $('password').value }) });
    localStorage.setItem('shahm-captain-token', r.token);
    render(r.captain);
  } catch (e) { showMessage(e.message); }
};
$('password').onkeydown = e => { if (e.key === 'Enter') $('login').click(); };
$('logout').onclick = () => { localStorage.removeItem('shahm-captain-token'); location.reload(); };
if (token()) loadMe();
// ============ إنشاء حساب بموافقة الإدارة ============
$('signup').onclick = async () => {
  const el = $('signupMsg');
  try {
    const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('suName').value, phone: fullPhone($('suPhone').value), email: $('suEmail').value, password: $('suPass').value }) });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'تعذر إرسال الطلب');
    el.textContent = d.message;
    el.className = 'msg ok';
    $('suName').value = $('suPhone').value = $('suEmail').value = $('suPass').value = '';
  } catch (e) { el.textContent = e.message; el.className = 'msg bad'; }
};
