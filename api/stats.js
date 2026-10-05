// GET /api/stats  – status dashboard numbers (same shape the old site used).
//
// "Online" has two independent sources, and the dashboard needs either of them:
//   1. varnox_server_heartbeats – each bot host POSTs /api/heartbeat every ~45s.
//      Fresh ping (< 2 min) => that server tile is online. This is the signal that
//      works even before anyone pairs, so a running bot no longer looks dead.
//   2. varnox_sessions – one row per WhatsApp session. A row counts as online when
//      it is status='connected' AND was refreshed in the last 15 minutes, so a bot
//      that died overnight stops claiming to be online.
// botOnline is true when either source says so.
const { query, getSetting, ensureActiveSchema } = require('./_db');

const HEARTBEAT_FRESH_MS = 120000; // matches api/heartbeat.js
const SESSION_FRESH_MS = 15 * 60 * 1000;

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

  try {
    // Self-heal the schema on whichever database is active, so a database that
    // never went through the admin "switch database" flow still has every table.
    await ensureActiveSchema();

    const [sess, keys, today] = await Promise.all([
      query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'connected'
                                   AND updated_at > now() - interval '15 minutes')::int AS online,
                count(*) FILTER (WHERE status = 'connected')::int AS connected,
                max(updated_at) AS last_session
           FROM varnox_sessions`
      ),
      query(`SELECT count(*)::int AS n FROM varnox_premium_keys WHERE status = 'unused'`),
      query(
        `SELECT count(*)::int AS n FROM varnox_pairing_requests WHERE created_at::date = current_date`
      ),
    ]);

    const onlineNow = sess.rows[0].online;
    const connectedTotal = sess.rows[0].connected;

    // Server 1..3 heartbeat status (offline when last ping > 2 minutes ago).
    let servers = [];
    let lastHeartbeatAt = null;
    try {
      const hb = await query(
        'SELECT server_id, name, last_seen FROM varnox_server_heartbeats ORDER BY server_id'
      );
      const now = Date.now();
      const seen = new Map(hb.rows.map((r) => [Number(r.server_id), r]));
      servers = [1, 2, 3].map((i) => {
        const r = seen.get(i);
        const last = r && r.last_seen ? new Date(r.last_seen).getTime() : 0;
        const online = now - last < HEARTBEAT_FRESH_MS && last > 0;
        if (online && (!lastHeartbeatAt || last > lastHeartbeatAt)) lastHeartbeatAt = last;
        return { id: i, name: (r && r.name) || 'Server ' + i, online, lastSeen: last || null };
      });
    } catch (e) {
      console.error('[stats] heartbeat query:', e && e.message);
    }

    const anyServerOnline = servers.some((s) => s.online);

    return json(res, 200, {
      totalPairs: sess.rows[0].total,
      onlineNow,
      today: today.rows[0].n,
      // Either a live host heartbeat or a recently refreshed session means the bot is up.
      botOnline: anyServerOnline || onlineNow > 0,
      servers,
      lastHeartbeatAt,
      lastSessionAt: sess.rows[0].last_session || null,
      connectedTotal,
      premiumMode: (await getSetting('premiumMode')) === 'true',
      keysLeft: keys.rows[0].n,
      notice: (await getSetting('notice')) || '',
    });
  } catch (e) {
    console.error('[stats]', e.message);
    return json(res, 500, { error: e.message });
  }
};
