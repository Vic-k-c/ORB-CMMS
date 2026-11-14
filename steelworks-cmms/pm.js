// ================= PM SCHEDULE MODULE =================
// Planned preventive maintenance: one row per planned visit (machine + date +
// level). Levels: W weekly, M monthly, Q quarterly, H half-yearly, A annual,
// S annual service done inside the December plant shutdown.
// Rows are seeded from pm-schedule.json (generated from the PM workbook) by
// POST /api/pm/import, and are closed either by saving a Preventive log
// that carries the pmId, or by the quick "Done" tick (used for shutdown days).
const fs = require('fs');
const path = require('path');

const LEVEL_NAME = { W: 'Weekly', M: 'Monthly', Q: 'Quarterly', H: 'Half-yearly', A: 'Annual', S: 'Annual (Dec shutdown)' };
const GRACE_DAYS = 3; // done up to 3 days after the due date still counts as on time

function nairobiToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });
}
function addDaysStr(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }

let DATA = null;
function loadData() {
  if (DATA) return DATA;
  try {
    DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'pm-schedule.json'), 'utf8'));
  } catch (e) {
    DATA = { machines: {}, classes: {}, rows: [], shutdown: { dates: {}, groups: [] } };
    console.warn('pm-schedule.json not found or unreadable: ' + e.message);
  }
  return DATA;
}

function normCode(c) { return String(c || '').trim().toUpperCase(); }
function codeVariants(c) {
  const u = normCode(c);
  const v = [u];
  if (u.startsWith('ZSF/')) v.push(u.slice(4)); else v.push('ZSF/' + u);
  return v;
}

// tasks text for one planned visit
function tasksFor(code, level) {
  const d = loadData();
  const mm = d.machines[code];
  if (!mm) return { label: '', team: '', hours: null, tasks: [] };
  const cls = d.classes[mm.cls];
  if (!cls) return { label: '', team: '', hours: null, tasks: [] };
  const lv = level === 'S' ? 'A' : level;
  const L = cls.levels[lv] || cls.levels.A || cls.levels.H || cls.levels.Q || cls.levels.M || cls.levels.W;
  let text = L ? L.tasks : '';
  if (level === 'S' && mm.group) {
    const g = (d.shutdown.groups || []).find(x => x.name.toLowerCase().indexOf(String(mm.group).split(' ')[0].toLowerCase()) === 0);
    if (g && g.tasks) text = g.tasks + '; ' + text;
  }
  const tasks = String(text).split(/;\s*/).map(s => s.trim()).filter(Boolean);
  return { label: cls.label, team: cls.team, hours: L ? L.hours : null, tasks };
}

module.exports = function (app, h) {
  const { dbGet, dbAll, dbRun, withTransaction, requirePermission, requireAnyPermission } = h;

  // ---------- schema (safe to run on every start) ----------
  async function ensureSchema() {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS pm_schedule (
        id SERIAL PRIMARY KEY,
        organization_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        due_date DATE NOT NULL,
        orig_date DATE,
        level TEXT NOT NULL,
        shutdown_day INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Planned',
        log_id TEXT,
        done_at TIMESTAMPTZ,
        done_by TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS pm_schedule_uniq ON pm_schedule (organization_id, machine_id, due_date)');
    await dbRun('CREATE INDEX IF NOT EXISTS pm_schedule_due ON pm_schedule (organization_id, due_date)');
    await dbRun('CREATE INDEX IF NOT EXISTS pm_schedule_machine ON pm_schedule (machine_id, status)');
  }

  const SELECT_ROW = `
    SELECT p.id, p.machine_id, to_char(p.due_date,'YYYY-MM-DD') AS due_date, to_char(p.orig_date,'YYYY-MM-DD') AS orig_date,
           p.level, p.shutdown_day, p.status, p.log_id, p.done_at, p.done_by, p.note,
           m.name AS machine_name, m.code AS machine_code, m.location AS machine_location, m.department AS machine_group
    FROM pm_schedule p JOIN machines m ON m.id = p.machine_id`;

  function toJSON(r) {
    const t = tasksFor(r.machine_code, r.level);
    return {
      id: r.id, machineId: r.machine_id, machineCode: r.machine_code, machineName: r.machine_name,
      location: r.machine_location || '', group: r.machine_group || 'Uncategorised',
      dueDate: r.due_date, origDate: r.orig_date, level: r.level, levelName: LEVEL_NAME[r.level] || r.level,
      shutdownDay: r.shutdown_day || 0, status: r.status, logId: r.log_id || null,
      doneAt: r.done_at, doneBy: r.done_by, note: r.note || '',
      equipment: t.label, team: t.team, hours: t.hours, tasks: t.tasks
    };
  }

  // ---------- helpers used by the logs routes ----------
  // Close / progress a PM row when a Preventive log is saved against it.
  async function linkLog(client, orgId, pmId, machineId, logId, logStatus, doneBy) {
    const id = parseInt(pmId, 10);
    if (!id) return null;
    const r = await client.query('SELECT id, status FROM pm_schedule WHERE id = $1 AND organization_id = $2 AND machine_id = $3', [id, orgId, machineId]);
    if (!r.rows[0]) return null;
    if (['Done'].includes(r.rows[0].status)) return null;
    const done = logStatus === 'Completed';
    await client.query(
      `UPDATE pm_schedule SET status = $1, log_id = $2, done_at = CASE WHEN $1 = 'Done' THEN NOW() ELSE done_at END, done_by = $3 WHERE id = $4`,
      [done ? 'Done' : 'In progress', logId, doneBy || null, id]);
    return id;
  }
  // A log linked to a PM row was later completed (e.g. supervisor edit) -> close the row.
  async function syncFromLog(logId, logStatus) {
    if (!logId) return;
    if (logStatus === 'Completed' || logStatus === 'Reviewed') {
      await dbRun(`UPDATE pm_schedule SET status = 'Done', done_at = COALESCE(done_at, NOW()) WHERE log_id = $1 AND status = 'In progress'`, [logId]);
    }
  }
  async function nextPlannedDate(client, machineId) {
    const r = await client.query(
      `SELECT to_char(MIN(due_date),'YYYY-MM-DD') AS d FROM pm_schedule WHERE machine_id = $1 AND status IN ('Planned','In progress') AND due_date >= $2::date AND level <> 'W'`,
      [machineId, nairobiToday()]);
    return r.rows[0] && r.rows[0].d ? r.rows[0].d : null;
  }
  app.locals.pm = { ensureSchema, linkLog, syncFromLog, nextPlannedDate };

  // ---------- import the schedule (idempotent) ----------
  app.post('/api/pm/import', requirePermission('manage_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const data = loadData();
      if (!data.rows.length) return res.status(500).json({ error: 'pm-schedule.json is missing on the server' });
      const machines = await dbAll('SELECT id, code FROM machines WHERE organization_id = $1', [orgId]);
      const byCode = new Map();
      machines.forEach(m => byCode.set(normCode(m.code), m.id));
      const idFor = {};
      const unmatched = new Set();
      Object.keys(data.machines).forEach(code => {
        let id = null;
        for (const v of codeVariants(code)) { if (byCode.has(v)) { id = byCode.get(v); break; } }
        if (id) idFor[code] = id; else unmatched.add(code);
      });
      const rows = data.rows.filter(r => idFor[r[0]]);
      let inserted = 0;
      const CH = 800;
      for (let i = 0; i < rows.length; i += CH) {
        const part = rows.slice(i, i + CH);
        const r = await dbRun(`
          INSERT INTO pm_schedule (organization_id, machine_id, due_date, orig_date, level, shutdown_day)
          SELECT $1, t.m, t.d::date, t.d::date, t.l, t.s
          FROM unnest($2::text[], $3::text[], $4::text[], $5::int[]) AS t(m, d, l, s)
          ON CONFLICT (organization_id, machine_id, due_date) DO NOTHING`,
          [orgId, part.map(x => idFor[x[0]]), part.map(x => x[1]), part.map(x => x[2]), part.map(x => x[3])]);
        inserted += r.rowCount || 0;
      }
      res.json({ ok: true, inserted, alreadyThere: rows.length - inserted, machinesMatched: Object.keys(idFor).length, unmatched: Array.from(unmatched).sort() });
    } catch (e) { res.status(500).json({ error: 'Import failed: ' + e.message }); }
  });

  // ---------- due lists ----------
  // scope: overdue | today | week | month | all ; level S rows live on the shutdown page
  app.get('/api/pm/due', requirePermission('view_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const today = nairobiToday();
      const scope = String(req.query.scope || 'week');
      const group = String(req.query.group || '').trim();
      const q = String(req.query.q || '').trim().toLowerCase();
      const level = String(req.query.level || '').trim();
      const status = String(req.query.status || '').trim();
      const where = ['p.organization_id = $1', "p.level <> 'S'"];
      const params = [orgId];
      const P = v => { params.push(v); return '$' + params.length; };
      if (scope === 'overdue') { where.push(`p.status IN ('Planned','In progress')`, `p.due_date < ${P(today)}::date`); }
      else if (scope === 'today') { where.push(`p.due_date = ${P(today)}::date`); }
      else if (scope === 'week') { where.push(`p.due_date BETWEEN ${P(today)}::date AND ${P(addDaysStr(today, 6))}::date`); }
      else if (scope === 'month') { where.push(`p.due_date BETWEEN ${P(today)}::date AND ${P(addDaysStr(today, 30))}::date`); }
      else if (scope === 'range') {
        if (isDate(req.query.from)) where.push(`p.due_date >= ${P(req.query.from)}::date`);
        if (isDate(req.query.to)) where.push(`p.due_date <= ${P(req.query.to)}::date`);
      }
      if (group) where.push(`m.department = ${P(group)}`);
      if (level && LEVEL_NAME[level]) where.push(`p.level = ${P(level)}`);
      if (status) where.push(`p.status = ${P(status)}`);
      if (q) where.push(`(LOWER(m.name) LIKE ${P('%' + q + '%')} OR LOWER(m.code) LIKE ${P('%' + q + '%')})`);
      const rows = await dbAll(`${SELECT_ROW} WHERE ${where.join(' AND ')} ORDER BY p.due_date, m.department, m.code LIMIT 600`, params);
      res.json({ today, rows: rows.map(toJSON) });
    } catch (e) { res.status(500).json({ error: 'Could not load PM list: ' + e.message }); }
  });

  // ---------- compliance ----------
  app.get('/api/pm/summary', requirePermission('view_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const today = nairobiToday();
      let from = isDate(req.query.from) ? req.query.from : today.slice(0, 8) + '01';
      let to = isDate(req.query.to) ? req.query.to : today;
      const rows = await dbAll(`
        SELECT m.department AS grp, p.level, p.status,
               (p.due_date < $4::date AND p.status IN ('Planned','In progress')) AS overdue,
               (p.due_date <= $4::date) AS due,
               (p.status = 'Done' AND p.done_at IS NOT NULL AND (p.done_at AT TIME ZONE 'Africa/Nairobi')::date <= p.due_date + ${GRACE_DAYS}) AS ontime
        FROM pm_schedule p JOIN machines m ON m.id = p.machine_id
        WHERE p.organization_id = $1 AND p.due_date BETWEEN $2::date AND $3::date`, [orgId, from, to, today]);
      const mk = () => ({ planned: 0, done: 0, onTime: 0, overdue: 0, skipped: 0, inProgress: 0, due: 0, dueDone: 0, dueOnTime: 0 });
      const tot = mk(); const groups = new Map(); const levels = new Map();
      rows.forEach(r => {
        const g = groups.get(r.grp || 'Uncategorised') || mk(); groups.set(r.grp || 'Uncategorised', g);
        const l = levels.get(r.level) || mk(); levels.set(r.level, l);
        [tot, g, l].forEach(x => {
          x.planned++;
          if (r.status === 'Done') x.done++;
          if (r.ontime) x.onTime++;
          if (r.due) { x.due++; if (r.status === 'Done') x.dueDone++; if (r.ontime) x.dueOnTime++; }
          if (r.overdue) x.overdue++;
          if (r.status === 'Skipped') x.skipped++;
          if (r.status === 'In progress') x.inProgress++;
        });
      });
      const pct = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : null;
      // compliance is measured on visits already due (due date today or earlier)
      const out = x => Object.assign({}, x, { donePct: pct(x.dueDone, x.due), onTimePct: pct(x.dueOnTime, x.due) });
      const overdueNow = await dbGet(`SELECT COUNT(*) AS n FROM pm_schedule WHERE organization_id = $1 AND status IN ('Planned','In progress') AND due_date < $2::date AND level <> 'S'`, [orgId, today]);
      res.json({
        from, to, today, overdueNow: parseInt(overdueNow.n, 10), total: out(tot),
        groups: Array.from(groups.entries()).map(([k, v]) => Object.assign({ group: k }, out(v))).sort((a, b) => b.planned - a.planned),
        levels: Array.from(levels.entries()).map(([k, v]) => Object.assign({ level: k, levelName: LEVEL_NAME[k] || k }, out(v)))
      });
    } catch (e) { res.status(500).json({ error: 'Could not load PM summary: ' + e.message }); }
  });

  // ---------- shutdown ----------
  app.get('/api/pm/shutdown', requirePermission('view_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const year = parseInt(req.query.year, 10) || parseInt(nairobiToday().slice(0, 4), 10);
      const rows = await dbAll(`${SELECT_ROW} WHERE p.organization_id = $1 AND p.level = 'S' AND p.due_date BETWEEN $2::date AND $3::date ORDER BY p.due_date, m.department, m.code`,
        [orgId, year + '-12-01', year + '-12-31']);
      const d = loadData();
      res.json({
        year, dates: (d.shutdown.dates || {})[String(year)] || [], groups: d.shutdown.groups || [],
        rows: rows.map(r => Object.assign(toJSON(r), { shutdownGroup: (d.machines[r.machine_code] || {}).group || 'Other' }))
      });
    } catch (e) { res.status(500).json({ error: 'Could not load shutdown plan: ' + e.message }); }
  });

  // ---------- actions ----------
  async function getRow(req) {
    const id = parseInt(req.params.id, 10);
    if (!id) return null;
    return dbGet("SELECT *, to_char(due_date,'YYYY-MM-DD') AS due_str FROM pm_schedule WHERE id = $1 AND organization_id = $2", [id, req.session.user.organizationId]);
  }

  // quick tick (shutdown days / small PM with no log)
  app.post('/api/pm/:id/complete', requirePermission('submit_logs'), async (req, res) => {
    try {
      const row = await getRow(req);
      if (!row) return res.status(404).json({ error: 'PM visit not found' });
      await dbRun(`UPDATE pm_schedule SET status = 'Done', done_at = NOW(), done_by = $1, note = COALESCE(NULLIF($2,''), note) WHERE id = $3`,
        [req.session.user.name || req.session.user.username || null, String(req.body.note || '').trim(), row.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not mark done: ' + e.message }); }
  });
  app.post('/api/pm/bulk-complete', requirePermission('submit_logs'), async (req, res) => {
    try {
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(x => parseInt(x, 10)).filter(Boolean).slice(0, 500);
      if (!ids.length) return res.status(400).json({ error: 'Nothing selected' });
      const undo = req.body.undo === true;
      const r = undo
        ? await dbRun(`UPDATE pm_schedule SET status = 'Planned', done_at = NULL, done_by = NULL WHERE organization_id = $1 AND id = ANY($2::int[]) AND log_id IS NULL`, [req.session.user.organizationId, ids])
        : await dbRun(`UPDATE pm_schedule SET status = 'Done', done_at = NOW(), done_by = $3 WHERE organization_id = $1 AND id = ANY($2::int[]) AND status <> 'Done'`,
            [req.session.user.organizationId, ids, req.session.user.name || req.session.user.username || null]);
      res.json({ ok: true, updated: r.rowCount || 0 });
    } catch (e) { res.status(500).json({ error: 'Could not update: ' + e.message }); }
  });
  app.post('/api/pm/:id/reopen', requirePermission('submit_logs'), async (req, res) => {
    try {
      const row = await getRow(req);
      if (!row) return res.status(404).json({ error: 'PM visit not found' });
      await dbRun(`UPDATE pm_schedule SET status = 'Planned', done_at = NULL, done_by = NULL WHERE id = $1 AND log_id IS NULL`, [row.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not reopen: ' + e.message }); }
  });
  app.post('/api/pm/:id/reschedule', requirePermission('submit_logs'), async (req, res) => {
    try {
      const row = await getRow(req);
      if (!row) return res.status(404).json({ error: 'PM visit not found' });
      const date = String(req.body.date || ''); const reason = String(req.body.reason || '').trim();
      if (!isDate(date)) return res.status(400).json({ error: 'Pick a valid new date' });
      if (!reason) return res.status(400).json({ error: 'Give a reason for moving this PM' });
      const note = ((row.note ? row.note + ' | ' : '') + 'Moved from ' + row.due_str + ': ' + reason).slice(0, 500);
      try {
        await dbRun(`UPDATE pm_schedule SET due_date = $1::date, status = 'Planned', note = $2 WHERE id = $3`, [date, note, row.id]);
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'This machine already has a PM planned on that date' });
        throw e;
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not reschedule: ' + e.message }); }
  });
  app.post('/api/pm/:id/skip', requirePermission('submit_logs'), async (req, res) => {
    try {
      const row = await getRow(req);
      if (!row) return res.status(404).json({ error: 'PM visit not found' });
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ error: 'Give a reason for skipping this PM' });
      await dbRun(`UPDATE pm_schedule SET status = 'Skipped', note = $1 WHERE id = $2`, [((row.note ? row.note + ' | ' : '') + 'Skipped: ' + reason).slice(0, 500), row.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not skip: ' + e.message }); }
  });

  // distinct groups for the filter dropdown
  app.get('/api/pm/groups', requirePermission('view_machines'), async (req, res) => {
    try {
      const rows = await dbAll(`SELECT DISTINCT m.department AS g FROM pm_schedule p JOIN machines m ON m.id = p.machine_id WHERE p.organization_id = $1 ORDER BY 1`, [req.session.user.organizationId]);
      res.json(rows.map(r => r.g).filter(Boolean));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
