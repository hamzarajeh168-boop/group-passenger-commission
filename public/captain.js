const $ = id => document.getElementById(id);
const money = value => `${Number(value || 0).toFixed(2)} د.أ`;
function showMessage(text, ok = false) { $('loginMsg').textContent = text; $('loginMsg').className = ok ? 'ok' : 'bad'; }
function render(data) {
  const c = data.captain;
  $('captainName').textContent = c.name;
  $('captainIdentity').textContent = `${c.code} · ${c.phone}`;
  $('captainStatus').textContent = c.status === 'active' ? 'الحساب فعال' : `الحساب ${c.status}`;
  $('balance').textContent = money(c.balance);
  $('charges').textContent = money(data.totals.charges);
  $('topups').textContent = money(data.totals.topups);
  $('passengers').textContent = c.stats.passengers || 0;
  $('orders').textContent = c.stats.orders || 0;
  $('groupFloor').textContent = c.stats.groupFloor || 0;
  $('ledger').innerHTML = data.ledger.map(entry => `<div class="ledger"><span>${entry.type === 'commission' ? 'استهلاك' : 'شحن رصيد'}<small>${entry.rule || entry.note || ''} ${entry.category || ''}<br>${entry.requestText || entry.createdAt}</small></span><b class="${entry.amount < 0 ? 'bad' : 'ok'}">${entry.amount > 0 ? '+' : ''}${money(entry.amount)}</b></div>`).join('') || '<small>لا يوجد عمليات مسجلة</small>';
  $('loginCard').hidden = true;
  $('dashboard').hidden = false;
}
async function login() {
  const phoneOrCode = $('loginValue').value.trim();
  if (!phoneOrCode) return showMessage('أدخل رقم الهاتف أو كود الكابتن');
  try {
    const response = await fetch('/api/captain/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneOrCode }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'تعذر تسجيل الدخول');
    render(data);
  } catch (error) { showMessage(error.message); }
}
$('login').onclick = login;
$('loginValue').onkeydown = event => { if (event.key === 'Enter') login(); };
$('logout').onclick = () => { $('dashboard').hidden = true; $('loginCard').hidden = false; $('loginValue').value = ''; $('loginMsg').textContent = ''; };
