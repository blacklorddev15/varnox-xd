// VARNOX XD – pairing page logic (Neon bridge)
const MENU_IMAGES = [
  'https://files.catbox.moe/bwc8vm.png',
];

const form = document.getElementById('pairForm');
const phoneInput = document.getElementById('phoneNumber');
const keyGroup = document.getElementById('premiumKeyGroup');
const keyInput = document.getElementById('premiumKey');
const submitBtn = document.getElementById('submitBtn');
const statusBox = document.getElementById('statusBox');
const resultBox = document.getElementById('resultBox');
const pairingCode = document.getElementById('pairingCode');
const copyBtn = document.getElementById('copyBtn');
const botPill = document.getElementById('botPill');
const noticeBanner = document.getElementById('noticeBanner');

let pollTimer = null;
let premiumMode = false;

function setStatus(msg, tone) {
  statusBox.hidden = !msg;
  statusBox.className = 'status-box' + (tone ? ' show ' + tone : '');
  statusBox.textContent = msg || '';
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    const s = await readJson(res);
    if (s.botOnline === undefined) return;
    premiumMode = !!s.premiumMode;
    botPill.textContent = s.botOnline ? '● BOT ONLINE' : '○ BOT OFFLINE';
    botPill.className = 'pill' + (s.botOnline ? '' : ' off');
    keyGroup.classList.toggle('hidden', !premiumMode);
    keyInput.required = premiumMode;
    if (s.notice) {
      noticeBanner.textContent = s.notice;
      noticeBanner.classList.add('show');
    } else {
      noticeBanner.classList.remove('show');
    }
  } catch { /* stats optional */ }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  stopPolling();
  resultBox.classList.remove('show');
  setStatus('', '');

  const phone = phoneInput.value.replace(/\D/g, '');
  if (phone.length < 7) return setStatus('❌ Enter a valid number with country code.', 'err');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Requesting code…';

  try {
    const res = await fetch('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, key: premiumMode ? keyInput.value.trim() : undefined }),
    });
    const data = await readJson(res);
    if (!res.ok || !data.id) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Generate Pairing Code';
      return setStatus('❌ ' + (data.error || 'Request failed.'), 'err');
    }

    setStatus('⏳ Waiting for the bot… usually under 30 seconds.', 'info');
    const started = Date.now();
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/status?id=' + data.id);
        const st = await readJson(r);
        if (st.error) { stopPolling(); return finishErr(st.error); }

        if (st.status === 'code_generated' || st.status === 'connected') {
          stopPolling();
          submitBtn.disabled = false;
          submitBtn.textContent = 'Generate Pairing Code';
          setStatus('', '');
          pairingCode.textContent = st.pairing_code ? st.pairing_code.replace(/(\S{4})(?=\S)/g, '$1 ') : 'CODE';
          resultBox.classList.add('show');
        } else if (st.status === 'failed' || st.status === 'expired') {
          stopPolling();
          submitBtn.disabled = false;
          submitBtn.textContent = 'Generate Pairing Code';
          finishErr(st.error || 'Request ' + st.status + '. Try again.');
        } else if (Date.now() - started > 180000) {
          stopPolling();
          submitBtn.disabled = false;
          submitBtn.textContent = 'Generate Pairing Code';
          finishErr('⏰ Timed out after 3 minutes. Try again.');
        }
      } catch { /* keep polling */ }
    }, 2500);

  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate Pairing Code';
    setStatus('❌ Network error: ' + err.message, 'err');
  }
});

function finishErr(msg) {
  setStatus('❌ ' + msg, 'err');
  resultBox.classList.remove('show');
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pairingCode.textContent.replace(/\s/g, ''));
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy Code'; }, 1500);
  } catch { /* clipboard blocked */ }
});

// rotate banner image + stats on load
document.getElementById('menuImg').src = MENU_IMAGES[Math.floor(Math.random() * MENU_IMAGES.length)];
refreshStats();
setInterval(refreshStats, 20000);
