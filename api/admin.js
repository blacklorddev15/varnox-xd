// POST /api/admin  { action, password?, ... }  or GET /api/admin?action=...
// Actions: login | stats | sessions | keys | generate_key | set_notice | set_premium
//          | current_db | switch_db | servers | reset_heartbeats | redeploy
// Legacy aliases used by the landing page: status | test | update_database
//          | update_notice | get_premium | generate_keys | list_keys
// Protected by ADMIN_PASSWORD env var (sent as X-Admin-Password header or body.password).
const { Pool } = require('pg');
const {
  query,
  getSetting,
  setSetting,
  switchActiveDatabase,
  activeUrl,
  ensureActiveSchema,
} = require('./_db');

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

// Never hand back a usable credential: the password is replaced with dots. This endpoint
// used to return the whole connection string, which gave a working database credential to
// anyone who could reach the admin. The sibling portals already mask it; this brings this
// one into line. The password is not needed to identify a database.
function maskUrl(url) {
  const m = String(url || '').match(/^(postgres(?:ql)?:\/\/[^:]+:)[^@]+@(.*)$/i);
  return m ? `${m[1]}\u2022\u2022\u2022\u2022@${m[2]}` : '';
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

function rand(n) {
  return Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
}

// Open a throwaway pool against an arbitrary connection string, prove it answers, close it.
// Deliberately does NOT go through ensureTarget(): "test connection" must not create tables
// or write the active_database_url row into a database the operator is only inspecting.
async function testConnection(url) {
  const pool = new Pool({
    connectionString: String(url).split('?')[0],
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    max: 1,
  });
  try {
    const r = await pool.query('SELECT current_database() AS db');
    return { ok: true, message: `Connection OK — database "${r.rows[0].db}".`, database: r.rows[0].db };
  } catch (e) {
    return { ok: false, message: 'Connection failed: ' + (e && e.message) };
  } finally {
    await pool.end().catch(() => {});
  }
}

function authOK(req, body) {
  const adminPw = process.env.ADMIN_PASSWORD || '';
  if (!adminPw) return false;
  const supplied = String(req.headers['x-admin-password'] || body.password || '');
  return supplied === adminPw;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
  if (req.method === 'OPTIONS') return res.end();

  const body = req.method === 'POST'
    ? Object.assign({}, readBody(req), req.query || {})
    : (req.query || {});
  const action = String(body.action || '');

  // login is the only action allowed without a header
  if (action === 'login') {
    if (!authOK(req, body)) return json(res, 401, { error: 'Incorrect admin password.' });
    return json(res, 200, { success: true });
  }

  if (!authOK(req, body)) return json(res, 401, { error: 'Unauthorized. Login first.' });

  try {
    await ensureActiveSchema();
    switch (action) {
      case 'stats': {
        const [sess, keys] = await Promise.all([
          query('SELECT count(*)::int AS total, count(*) FILTER (WHERE status = \'connected\')::int AS online FROM varnox_sessions'),
          query('SELECT count(*)::int AS n FROM varnox_premium_keys WHERE status = \'unused\''),
        ]);

        // The newest code, whoever asked for it. When the bot re-pairs by itself nobody requested
        // one, so without this the code would sit in the database and never be seen.
        const latest = await query(
          `SELECT phone, pairing_code, updated_at
             FROM varnox_pairing_requests
            WHERE status = 'code_generated' AND pairing_code IS NOT NULL
              -- only a fresh one: an old code would sit in the panel for ever and mislead
              AND updated_at > now() - interval '30 minutes'
            ORDER BY updated_at DESC
            LIMIT 1`
        ).catch(() => ({ rows: [] }));

        return json(res, 200, {
          totalSessions: sess.rows[0].total,
          onlineNow: sess.rows[0].online,
          keysLeft: keys.rows[0].n,
          premiumMode: (await getSetting('premiumMode')) === 'true',
          notice: (await getSetting('notice')) || '',
          latestCode: latest.rows[0]
            ? { phone: latest.rows[0].phone, code: latest.rows[0].pairing_code, at: latest.rows[0].updated_at }
            : null,
        });
      }

      case 'sessions': {
        const { rows } = await query(
          'SELECT id, phone, status, updated_at FROM varnox_sessions ORDER BY updated_at DESC LIMIT 100'
        );
        return json(res, 200, { sessions: rows });
      }

      // Removes ONE paired user. This only clears the database row: revoking the WhatsApp
      // link itself is the bot's job (/delpair), which also deletes ./sessions/<id>.
      case 'delete_session': {
        const id = String(body.id == null ? '' : body.id).trim().slice(0, 200);
        if (!id) return json(res, 400, { error: 'Missing session id.' });
        const { rows } = await query(
          'DELETE FROM varnox_sessions WHERE id = $1 RETURNING id', [id]
        );
        if (!rows.length) return json(res, 404, { error: 'No such session.' });
        return json(res, 200, { success: true, deleted: rows[0].id });
      }

      // Bulk path for rows the bot has already logged out. The predicate is exactly
      // "disconnected", so a session that is still linked can never be deleted here.
      // Pass { dryRun: true } to get the count without deleting anything.
      case 'clear_sessions': {
        if (body.dryRun) {
          const { rows } = await query(
            "SELECT count(*)::int AS n FROM varnox_sessions WHERE LOWER(status) = 'disconnected'"
          );
          return json(res, 200, { success: true, dryRun: true, wouldClear: rows[0].n });
        }
        const { rows } = await query(
          "DELETE FROM varnox_sessions WHERE LOWER(status) = 'disconnected' RETURNING id"
        );
        return json(res, 200, { success: true, cleared: rows.length });
      }

      case 'keys': {
        const { rows } = await query(
          'SELECT id, key, status, used_phone, used_at, created_at FROM varnox_premium_keys ORDER BY id DESC LIMIT 100'
        );
        return json(res, 200, { keys: rows });
      }

      case 'generate_key': {
        const newKey = `VN-${rand(4)}-${rand(4)}`;
        await query('INSERT INTO varnox_premium_keys (key, status) VALUES ($1, $2)', [newKey, 'unused']);
        return json(res, 200, { success: true, ok: true, key: newKey });
      }

      case 'set_notice': {
        await setSetting('notice', String(body.notice || ''));
        return json(res, 200, { success: true, notice: String(body.notice || '') });
      }

      case 'set_premium': {
        await setSetting('premiumMode', body.enabled ? 'true' : 'false');
        return json(res, 200, {
          success: true,
          ok: true,
          premiumMode: !!body.enabled,
          message: body.enabled ? 'Premium mode enabled.' : 'Premium mode disabled.',
        });
      }

      case 'current_db': {
        const url = await activeUrl();
        let host = '';
        let database = '';
        try {
          const parsed = new URL(url);
          host = parsed.host;
          database = parsed.pathname.replace(/^\//, '');
        } catch (_) { /* ignore */ }
        // Host, database name and a masked string only -- never the raw connection string.
        //
        // controlHost is the CONTROL database (process.env.DATABASE_URL): what every cold
        // start bootstraps from, and what the site falls back to when the stored pointer
        // cannot be read. When it differs from the active database, or when it is the
        // suspended one, that is the first fact worth seeing.
        let controlHost = '';
        try { controlHost = new URL(String(process.env.DATABASE_URL || '')).host; }
        catch (_) { /* ignore */ }
        return json(res, 200, { success: true, host, database, urlMasked: maskUrl(url), controlHost });
      }

      case 'switch_db': {
        const url = await switchActiveDatabase(String(body.url || '').trim());
        return json(res, 200, { success: true, host: hostOf(url), urlMasked: maskUrl(url) });
      }

      case 'servers': {
        const { rows } = await query(
          'SELECT server_id, name, last_seen FROM varnox_server_heartbeats ORDER BY server_id'
        );
        return json(res, 200, { servers: rows });
      }

      // Clear every server heartbeat so the dashboard starts from a clean slate.
      case 'reset_heartbeats': {
        await query(`UPDATE varnox_server_heartbeats SET last_seen = now() - interval '1 hour'`);
        return json(res, 200, { success: true });
      }

      // Rebuild the current production deployment.
      //
      // Vercel only applies environment variables on a NEW build, so changing DATABASE_URL
      // does nothing until something rebuilds. That rebuild is the one step that otherwise
      // forces a trip to the dashboard, which is exactly what this button exists to avoid.
      //
      // Redeploying by deploymentId inherits every setting from that build - environment
      // variables included - which is what is wanted here. See:
      // https://vercel.com/docs/rest-api/deployments/create-a-new-deployment
      case 'redeploy': {
        if (typeof fetch !== 'function') {
          return json(res, 200, {
            success: false,
            message: 'This deployment is running a Node runtime without fetch; needs Node 18+.',
          });
        }
        const token = String(process.env.VERCEL_API_TOKEN || '').trim();
        const project = String(process.env.PROJECT_ID || process.env.VERCEL_PROJECT_ID || '').trim();
        const team = String(process.env.TEAM_ID || process.env.VERCEL_TEAM_ID || '').trim();
        if (!token || !project) {
          return json(res, 200, {
            success: false,
            message: 'Redeploy needs VERCEL_API_TOKEN and PROJECT_ID set on this deployment.',
          });
        }
        const auth = { Authorization: `Bearer ${token}` };
        const teamQ = team ? `?teamId=${encodeURIComponent(team)}` : '';

        // A fresh build from the Git source -- NOT a redeploy of the existing deployment.
        //
        // Vercel's redeploy-by-deploymentId inherits that build's settings, environment
        // variables included, so it rebuilds with the OLD environment and changes nothing.
        // That was measured on this project, not assumed: a redeploy left DATABASE_URL
        // stale, while a build from Git picked the new value up immediately. A button that
        // looks like it worked but silently did not is worse than no button.
        const projRes = await fetch(
          `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}${teamQ}`,
          { headers: auth }
        );
        const proj = await projRes.json();
        if (!projRes.ok) {
          return json(res, 200, {
            success: false,
            message: 'Vercel: ' + ((proj.error && proj.error.message) || projRes.status),
          });
        }
        const link = proj.link || {};
        if (!link.repoId) {
          return json(res, 200, {
            success: false,
            message: 'This project has no Git repository linked, so a rebuild that picks up '
                   + 'new environment variables cannot be started from here.',
          });
        }

        const createRes = await fetch(
          `https://api.vercel.com/v13/deployments${teamQ}`,
          {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
            body: JSON.stringify({
              name: proj.name || link.repo,
              project: project,
              target: 'production',
              gitSource: {
                type: link.type || 'github',
                repoId: link.repoId,
                ref: link.productionBranch || 'main',
              },
            }),
          }
        );
        const created = await createRes.json();
        if (!createRes.ok) {
          return json(res, 200, {
            success: false,
            message: 'Vercel: ' + ((created.error && created.error.message) || createRes.status),
          });
        }
        return json(res, 200, {
          success: true,
          message: 'Rebuild started — the site stays up while it builds.',
          url: created.url ? `https://${created.url}` : '',
        });
      }

      /* ── Landing-page aliases ────────────────────────────────────────────
         index.html was written against an older action vocabulary: status,
         test, update_database, update_notice, get_premium, generate_keys,
         list_keys. None of those existed in this handler, so the landing
         admin modal answered every unlock attempt with "Unknown action." and
         the panel never opened — a correct password looked exactly like a
         wrong one. The aliases below map those names onto the handlers above
         and answer in the { ok } shape that page reads, while still carrying
         { success } so admin.html is unaffected. */

      case 'status': {
        const url = await activeUrl();
        const dbHost = hostOf(url);
        return json(res, 200, {
          ok: true,
          success: true,
          dbHost,
          host: dbHost,
          notice: (await getSetting('notice')) || '',
          urlMasked: maskUrl(url),
        });
      }

      case 'test': {
        const url = String(body.url || '').trim();
        if (!/^postgres(ql)?:\/\//i.test(url)) {
          return json(res, 200, {
            ok: false, success: false,
            message: 'That does not look like a Postgres connection string.',
          });
        }
        const r = await testConnection(url);
        return json(res, 200, Object.assign({ success: r.ok }, r));
      }

      case 'update_database': {
        const raw = String(body.url || '').trim();
        if (!/^postgres(ql)?:\/\//i.test(raw)) {
          return json(res, 200, {
            ok: false, success: false,
            message: 'That does not look like a Postgres connection string.',
          });
        }
        // switchActiveDatabase validates by CONNECTING, so a well-formed but unreachable
        // string throws here. Catch it: the landing page prints data.message, and letting
        // this reach the outer handler would surface as the literal text "undefined".
        let url;
        try {
          url = await switchActiveDatabase(raw);
        } catch (e) {
          return json(res, 200, {
            ok: false, success: false,
            message: 'Could not switch database: ' + (e && e.message),
          });
        }
        const host = hostOf(url);
        return json(res, 200, {
          ok: true, success: true, host, dbHost: host, urlMasked: maskUrl(url),
          message: `Database switched to ${host}. Live immediately — the pointer is stored in `
                 + 'the database, so no redeploy is needed.',
        });
      }

      case 'update_notice': {
        const notice = String(body.notice || '');
        await setSetting('notice', notice);
        return json(res, 200, {
          ok: true, success: true, notice,
          message: notice ? 'Notice published.' : 'Notice cleared.',
        });
      }

      case 'get_premium': {
        const mode = (await getSetting('premiumMode')) === 'true';
        const { rows } = await query(
          'SELECT key, status, used_phone FROM varnox_premium_keys ORDER BY id DESC LIMIT 100'
        );
        return json(res, 200, {
          ok: true,
          success: true,
          mode: mode ? 'on' : 'off',
          keysTotal: rows.length,
          keysUsed: rows.filter((r) => String(r.status || '').toLowerCase() !== 'unused').length,
          recentKeys: rows.slice(0, 10).map((r) => ({
            key: r.key, status: r.status, usedPhone: r.used_phone || '',
          })),
        });
      }

      case 'generate_keys': {
        const count = Math.min(50, Math.max(1, Number(body.count) || 5));
        const made = Array.from({ length: count }, () => `VN-${rand(4)}-${rand(4)}`);
        await query(
          'INSERT INTO varnox_premium_keys (key, status) SELECT k, $2 FROM unnest($1::text[]) AS k',
          [made, 'unused']
        );
        return json(res, 200, {
          ok: true, success: true, keys: made,
          message: `${made.length} key${made.length === 1 ? '' : 's'} generated.`,
        });
      }

      case 'list_keys': {
        const { rows } = await query(
          'SELECT key, status, used_phone FROM varnox_premium_keys ORDER BY id DESC LIMIT 100'
        );
        return json(res, 200, {
          ok: true,
          success: true,
          keys: rows.map((r) => ({ key: r.key, status: r.status, usedPhone: r.used_phone || '' })),
        });
      }

      default:
        return json(res, 400, { error: 'Unknown action.' });
    }
  } catch (e) {
    console.error('[admin]', e.message);
    return json(res, 500, { error: e.message });
  }
};
