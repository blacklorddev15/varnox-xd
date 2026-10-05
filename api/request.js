// POST /api/request  { phone, key? }
// Creates a pending row in varnox_pairing_requests for the bot to claim.
const { query, getSetting } = require('./_db');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString('utf8') || '{}'); } catch { return {}; } }
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch { return {}; } }
  if (typeof b === 'object') return b;
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const body = readBody(req);

  const phone = String(body.phone || '').replace(/\D/g, '');
  if (phone.length < 7 || phone.length > 15) {
    return json(res, 400, { error: 'Enter a valid international WhatsApp number.' });
  }

  try {
    // ── Premium gate ──────────────────────────────────────
    const premiumMode = (await getSetting('premiumMode')) === 'true';
    const key = String(body.key || '').trim().toUpperCase();
    if (premiumMode) {
      if (!key) return json(res, 403, { error: 'Premium mode is active. A valid activation key is required.' });
      const { rows: krows } = await query(
        'SELECT id FROM varnox_premium_keys WHERE key = $1 AND status = $2 LIMIT 1',
        [key, 'unused']
      );
      if (!krows[0]) return json(res, 403, { error: 'Invalid or already used activation key.' });
      await query('UPDATE varnox_premium_keys SET status = $1, used_phone = $2, used_at = now() WHERE id = $3',
        ['used', phone, krows[0].id]);
    }

    // ── Insert pairing request ────────────────────────────
    const { rows } = await query(
      `INSERT INTO varnox_pairing_requests (phone, status) VALUES ($1, 'pending') RETURNING id, phone, expires_at`,
      [phone]
    );
    // Return both id styles: newer portals use { id }, the classic page uses { requestId, expiresAt }
    return json(res, 200, {
      id: rows[0].id,
      requestId: rows[0].id,
      phone: rows[0].phone,
      expires_at: rows[0].expires_at,
      expiresAt: rows[0].expires_at,
    });
  } catch (e) {
    console.error('[request]', e.message);
    return json(res, 500, { error: e.message });
  }
};
