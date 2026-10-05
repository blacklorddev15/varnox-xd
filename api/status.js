// GET /api/status?id=<requestId>  – polled by the frontend until a code appears.
const { query } = require('./_db');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();

  const id = String(req.query?.id || '').replace(/\D/g, '');
  if (!id) return json(res, 400, { error: 'Missing id' });

  try {
    const { rows } = await query(
      `SELECT id, phone, status, pairing_code, error, created_at, updated_at, expires_at
       FROM varnox_pairing_requests WHERE id = $1`,
      [Number(id)]
    );
    if (!rows[0]) return json(res, 404, { error: 'Request not found' });
    return json(res, 200, rows[0]);
  } catch (e) {
    console.error('[status]', e.message);
    return json(res, 500, { error: e.message });
  }
};
