// VARNOX XD – admin dashboard logic
let pw = sessionStorage.getItem('vn_admin_pw') || '';

const $ = (id) => document.getElementById(id);
const loginCard = $('loginCard');
const panel = $('panel');

function setLoginMsg(msg, tone) {
  const box = $('loginMsg');
  box.hidden = !msg;
  box.className = 'status-box' + (msg ? ' show ' + tone : '');
  box.textContent = msg || '';
}

async function api(action, extra = {}, method) {
  const res = await fetch('/api/admin?action=' + encodeURIComponent(action), {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json', ...(pw ? { 'X-Admin-Password': pw } : {}) },
    body: JSON.stringify(extra),
  });
  return res.json();
}

async function tryLogin(showErr = true) {
  pw = $('pw').value.trim() || pw;
  const d = await api('login', { password: pw });
  if (d.success) {
    sessionStorage.setItem('vn_admin_pw', pw);
    loginCard.classList.add('hidden');
    panel.classList.remove('hidden');
    await refreshAll();
    return true;
  }
  if (showErr) setLoginMsg(d.error || 'Login failed.', 'err');
  return false;
}

async function refreshStats() {
  const d = await api('stats');
  if (d.error) return;
  $('stOnline').textContent = d.onlineNow;
  $('stTotal').textContent = d.totalSessions;
  $('stKeys').textContent = d.keysLeft;
  $('stPrem').textContent = d.premiumMode ? 'ON' : 'OFF';
  $('premiumBtn').textContent = d.premiumMode ? 'Disable Premium Mode' : 'Enable Premium Mode';
  $('noticeInput').value = d.notice || '';
  // A code the bot asked for by itself, shown where the owner already looks.
  $('latestCode').textContent = d.latestCode
    ? `🛠️ Bot re-paired itself — code ${d.latestCode.code} for ${d.latestCode.phone}. `
      + 'Enter it on that phone: WhatsApp → Linked devices → Link with phone number. '
      + `(${new Date(d.latestCode.at).toLocaleString()})`
    : '';
}

async function refreshKeys() {
  const d = await api('keys');
  if (d.error) return;
  $('keysList').innerHTML = (d.keys || []).slice(0, 30).map(k =>
    `<div class="row"><span>${k.key}</span><span class="tag ${k.status === 'unused' ? 'on' : 'off'}">${k.status}${k.used_phone ? ' · ' + k.used_phone : ''}</span></div>`
  ).join('') || '<p class="sub">No keys yet.</p>';
}

// Phone numbers and session ids come out of the database, so they are escaped before they
// go anywhere near markup.
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function tagClass(status) {
  return status === 'connected' ? 'on' : status === 'disconnected' ? 'off' : 'x';
}

function relTime(iso) {
  const t = iso ? new Date(iso).getTime() : 0;
  if (!t) return 'never';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

async function refreshSessions() {
  const d = await api('sessions');
  if (d.error) return;
  const rows = (d.sessions || []).slice(0, 50);

  $('sessionsList').innerHTML = rows.map(s => {
    const label = s.phone || s.id;
    // show the session id underneath only when it adds something the phone does not
    const sub = (s.phone && s.id && s.id !== s.phone) ? esc(s.id) : '';
    return `<div class="row">` +
      `<span class="sess-main"><strong>${esc(label)}</strong>` +
        (sub ? `<small class="mono">${sub}</small>` : '') +
        `<small class="mono sess-meta">${esc(relTime(s.updated_at))}</small></span>` +
      `<span class="sess-right">` +
        `<span class="tag ${tagClass(s.status)}">${esc(s.status || 'stored')}</span>` +
        `<button type="button" class="del-btn" data-id="${esc(s.id)}">Delete</button>` +
      `</span>` +
    `</div>`;
  }).join('') || '<p class="sub">No paired users yet.</p>';

  const c = $('sessCount');
  if (c) c.textContent = rows.length + (rows.length === 1 ? ' user' : ' users');
}

// One delegated listener, so re-rendering the list never leaves stale handlers behind.
$('sessionsList').addEventListener('click', async (event) => {
  const btn = event.target.closest('.del-btn');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (!confirm(`Delete ${id}?\n\n` +
    `This removes the row from the database, so the portal stops listing them. ` +
    `It does NOT unlink WhatsApp — revoke the device with /delpair on the bot.`)) return;

  btn.disabled = true;
  btn.textContent = '…';
  const d = await api('delete_session', { id });
  if (d.success) {
    await refreshAll();
  } else {
    alert(d.error || 'Delete failed');
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
});

// Counts first so the confirmation shows the real number, then re-reads everything.
$('clearSessionsBtn').addEventListener('click', async () => {
  const box = $('clearMsg');
  box.textContent = '⏳ Counting disconnected sessions…';
  box.className = 'status-box show info';

  const pre = await api('clear_sessions', { dryRun: true });
  if (pre.error) {
    box.textContent = '❌ ' + pre.error;
    box.className = 'status-box show err';
    return;
  }
  const n = pre.wouldClear || 0;
  if (!n) {
    box.textContent = '✓ Nothing to delete — no disconnected sessions.';
    box.className = 'status-box show ok';
    return;
  }
  if (!confirm(`Delete ${n} disconnected session${n === 1 ? '' : 's'}?\n\nThis cannot be undone. Connected sessions are not touched.`)) {
    box.textContent = 'Cancelled — nothing was deleted.';
    box.className = 'status-box show info';
    return;
  }
  const d = await api('clear_sessions', {});
  if (!d.success) {
    box.textContent = '❌ ' + (d.error || 'Failed');
    box.className = 'status-box show err';
    return;
  }
  box.textContent = `✅ Deleted ${d.cleared} disconnected session${d.cleared === 1 ? '' : 's'}.`;
  box.className = 'status-box show ok';
  await refreshAll();
});

async function refreshAll() {
  await refreshStats();
  await refreshKeys();
  await refreshSessions();
  await refreshDb();
}

async function refreshDb() {
  const d = await api('current_db');
  if (!d.success) return;
  $('curDbHost').textContent = d.host || '-';
  // The control database comes from process.env.DATABASE_URL. Seeing both side by side is
  // what makes a mismatch — or a suspended control — visible instead of mysterious.
  $('ctrlDbHost').textContent = d.controlHost || 'not set';
}

$('switchDbBtn').addEventListener('click', async () => {
  const box = $('dbMsg');
  const url = $('dbUrl').value.trim();
  if (!url) {
    box.textContent = '❌ Paste a connection string first.';
    box.className = 'status-box show err';
    return;
  }
  box.textContent = '⏳ Connecting to new DB…';
  box.className = 'status-box show info';
  const d = await api('switch_db', { url });
  if (d.success) {
    // The API returns host + a masked string, never the raw connection string.
    box.textContent = '✅ Switched to: ' + (d.host || d.urlMasked || 'the new database');
    box.className = 'status-box show ok';
    $('dbUrl').value = '';
    await refreshAll();
  } else {
    box.textContent = '❌ ' + (d.error || 'Switch failed');
    box.className = 'status-box show err';
  }
});

$('redeployBtn').addEventListener('click', async () => {
  const btn = $('redeployBtn');
  const box = $('redeployMsg');
  if (!confirm(
    'Rebuild the production deployment now?\n\n' +
    'The site stays up while it builds, then swaps over. Use this after changing an ' +
    'environment variable — Vercel only applies those on a new build.')) return;
  btn.disabled = true;
  box.textContent = '⏳ Asking Vercel to rebuild…';
  box.className = 'status-box show info';
  try {
    const d = await api('redeploy');
    if (d.success) {
      box.textContent = '✅ ' + (d.message || 'Rebuild started.') + (d.url ? ' — ' + d.url : '');
      box.className = 'status-box show ok';
    } else {
      box.textContent = '❌ ' + (d.message || d.error || 'Redeploy failed');
      box.className = 'status-box show err';
    }
  } finally {
    btn.disabled = false;
  }
});

$('loginBtn').addEventListener('click', () => tryLogin());
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

$('saveNoticeBtn').addEventListener('click', async () => {
  const d = await api('set_notice', { notice: $('noticeInput').value });
  if (!d.error) { const b = $('newKey'); b.textContent = '✓ Notice saved'; b.className = 'status-box show ok'; setTimeout(() => b.className = 'status-box', 2000); }
});

$('premiumBtn').addEventListener('click', async () => {
  const cur = $('premiumBtn').textContent.startsWith('Enable');
  await api('set_premium', { enabled: cur });
  await refreshStats();
});

$('genKeyBtn').addEventListener('click', async () => {
  const d = await api('generate_key');
  const b = $('newKey');
  if (d.key) {
    b.textContent = '🔑 ' + d.key;
    b.className = 'status-box show ok';
    await refreshKeys();
  } else {
    b.textContent = '❌ ' + (d.error || 'Failed');
    b.className = 'status-box show err';
  }
});

(async () => {
  if (pw) { const ok = await tryLogin(false); if (!ok) sessionStorage.removeItem('vn_admin_pw'); }
})();
