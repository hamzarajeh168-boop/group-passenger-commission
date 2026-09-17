const $ = id => document.getElementById(id);
const money = value => `${Number(value || 0).toFixed(2)} د.أ`;
function showMessage(text, ok = false) { $('loginMsg').textContent = text; $('loginMsg').className = ok ? 'ok' : 'bad'; }
const token = () => localStorage.getItem('shahm-captain-token') || '';
async function api(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', 'x-token': token() } });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'حدث خطأ');
  return d;
}
function render(c) {
  $('capName').textContent = c.name;
  $('capIdentity').textContent = `${c.role === 'consumption' ? 'مستهلك' : 'منتج'} · ${c.phone} · ${c.email || ''} · الرقم السري: ${c.pin}`;
  $('capStatus').textContent = c.removedFromGroup ? 'مزال من جروب الواتساب' : 'فعّال في الجروب';
  $('balance').textContent = money(c.balance);
  $('passengers').textContent = c.stats.passengers || 0;
  $('orders').textContent = c.stats.orders || 0;
  $('linked').textContent = c.linkedPhone || '—';
  $('zeroWarn').hidden = c.balance > 0;
  const label = { consumption: 'استهلاك', production: 'إنتاج', topup: 'شحن', withdraw: 'سحب', transfer: 'تحويل', weekly: 'خصم أسبوعي', system: 'نظام' };
  $('ledger').innerHTML = (c.ledger || []).map(e => `<div class="ledger"><span>${label[e.type] || e.type}<small>${e.note || ''} ${e.createdAt}</small></span><b class="${e.amount < 0 ? 'bad' : 'ok'}">${e.amount > 0 ? '+' : ''}${money(e.amount)}</b></div>`).join('') || '<small>لا يوجد عمليات</small>';
  $('loginCard').hidden = true;
  $('panel').hidden = false;
}
async function loadMe() {
  try { render(await api('/api/captain/me')); }
  catch (e) { showMessage(e.message); }
}
$('login').onclick = async () => {
  try {
    const r = await api('/api/captain/login', { method: 'POST', body: JSON.stringify({ phone: $('phone').value, password: $('password').value }) });
    localStorage.setItem('shahm-captain-token', r.token);
    render(r.captain);
  } catch (e) { showMessage(e.message); }
};
$('password').onkeydown = e => { if (e.key === 'Enter') $('login').click(); };
$('logout').onclick = () => { localStorage.removeItem('shahm-captain-token'); location.reload(); };
if (token()) loadMe();
// ============ إنشاء حساب بموافقة الإدارة ============
$('showSignup').onclick = () => { $('signupCard').hidden = false; $('signupCard').style.display = ''; $('signupCard').previousElementSibling.hidden = true; };
$('backLogin').onclick = () => { $('signupCard').hidden = true; $('signupCard').previousElementSibling.hidden = false; };
$('signup').onclick = async () => {
  const el = $('signupMsg');
  try {
    const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('suName').value, phone: $('suPhone').value, email: $('suEmail').value, password: $('suPass').value }) });
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'تعذر إرسال الطلب');
    el.textContent = d.message;
    el.className = 'ok';
    $('suName').value = $('suPhone').value = $('suEmail').value = $('suPass').value = '';
  } catch (e) { el.textContent = e.message; el.className = 'bad'; }
};
