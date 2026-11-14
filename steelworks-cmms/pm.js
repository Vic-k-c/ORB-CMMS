// ================= PM SCHEDULE MODULE =================
// Planned preventive maintenance, fully database driven and per organization.
//
// Tables (all created automatically on start):
//   pm_templates         what each visit level covers, per equipment class (tasks, hours, team)
//   pm_machine_plan      which class (and optional shutdown group) each machine belongs to
//   pm_shutdown_groups   shutdown work packages (tasks + manpower per day)
//   pm_schedule          one row per planned visit: machine + date + level
//
// Levels: W weekly, M monthly, Q quarterly, H half-yearly, A annual,
//         S annual service done during the plant shutdown.
// Data is fed by POST /api/pm/import (JSON file chosen in the app) or by plain
// SQL inserts into the tables above. Nothing here is specific to one plant.

const LEVEL_NAME = { W: 'Weekly', M: 'Monthly', Q: 'Quarterly', H: 'Half-yearly', A: 'Annual', S: 'Annual (shutdown)' };
const LEVELS = Object.keys(LEVEL_NAME);
const GRACE_DAYS = 3; // done up to 3 days after the due date still counts as on time
// Calendar "today" is worked out in this time zone (set PM_TIMEZONE on the server to change it)
const TZ = /^[A-Za-z_\/+\-0-9]+$/.test(process.env.PM_TIMEZONE || '') ? process.env.PM_TIMEZONE : 'Africa/Nairobi';

function today() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }
function addDaysStr(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
function normCode(c) { return String(c || '').trim().toUpperCase(); }
function codeVariants(c) {
  const u = normCode(c);
  const v = [u];
  const i = u.indexOf('/');
  if (i > 0) v.push(u.slice(i + 1));      // code without its organisation prefix
  return v;
}

module.exports = function (app, h) {
  const { dbGet, dbAll, dbRun, withTransaction, requirePermission } = h;

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
    await dbRun(`
      CREATE TABLE IF NOT EXISTS pm_templates (
        id SERIAL PRIMARY KEY,
        organization_id TEXT NOT NULL,
        class_key TEXT NOT NULL,
        label TEXT,
        team TEXT,
        level TEXT NOT NULL,
        tasks TEXT NOT NULL DEFAULT '',
        hours NUMERIC,
        UNIQUE (organization_id, class_key, level)
      )`);
    await dbRun(`
      CREATE TABLE IF NOT EXISTS pm_machine_plan (
        organization_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        class_key TEXT NOT NULL,
        shutdown_group TEXT,
        PRIMARY KEY (organization_id, machine_id)
      )`);
    await dbRun(`
      CREATE TABLE IF NOT EXISTS pm_shutdown_groups (
        id SERIAL PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        tasks TEXT,
        manpower TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE (organization_id, name)
      )`);
  }

  // ---------- templates / plans for one organisation ----------
  async function loadPlans(orgId) {
    const [tp, pl, sg] = await Promise.all([
      dbAll('SELECT class_key, label, team, level, tasks, hours FROM pm_templates WHERE organization_id = $1', [orgId]),
      dbAll('SELECT machine_id, class_key, shutdown_group FROM pm_machine_plan WHERE organization_id = $1', [orgId]),
      dbAll('SELECT name, tasks, manpower, sort_order FROM pm_shutdown_groups WHERE organization_id = $1 ORDER BY sort_order, id', [orgId])
    ]);
    const tpl = new Map(); tp.forEach(t => tpl.set(t.class_key + '|' + t.level, t));
    const plan = new Map(); pl.forEach(p => plan.set(p.machine_id, p));
    const groups = sg.map(g => ({ name: g.name, tasks: g.tasks || '', manpower: String(g.manpower || '').split(',').map(x => x.trim() === '' ? null : Number(x)) }));
    return { tpl, plan, groups };
  }
  function visitInfo(P, machineId, level) {
    const pl = P.plan.get(machineId);
    if (!pl) return { label: '', team: '', hours: null, tasks: [] };
    const t = P.tpl.get(pl.class_key + '|' + level) || (level === 'S' ? P.tpl.get(pl.class_key + '|A') : null);
    let text = t ? (t.tasks || '') : '';
    if (level === 'S' && pl.shutdown_group) {
      const g = P.groups.find(x => x.name === pl.shutdown_group);
      if (g && g.tasks) text = g.tasks + '; ' + text;
    }
    const any = t || P.tpl.get(pl.class_key + '|M') || P.tpl.get(pl.class_key + '|A');
    return {
      label: any ? (any.label || '') : '', team: any ? (any.team || '') : '',
      hours: t && t.hours !== null ? Number(t.hours) : null,
      tasks: String(text).split(/;\s*/).map(x => x.trim()).filter(Boolean)
    };
  }

  const SELECT_ROW = `
    SELECT p.id, p.machine_id, to_char(p.due_date,'YYYY-MM-DD') AS due_date, to_char(p.orig_date,'YYYY-MM-DD') AS orig_date,
           p.level, p.shutdown_day, p.status, p.log_id, p.done_at, p.done_by, p.note,
           m.name AS machine_name, m.code AS machine_code, m.location AS machine_location, m.department AS machine_group
    FROM pm_schedule p JOIN machines m ON m.id = p.machine_id`;

  function toJSON(r, P) {
    const t = visitInfo(P, r.machine_id, r.level);
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
    if (!r.rows[0] || r.rows[0].status === 'Done') return null;
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
      [machineId, today()]);
    return r.rows[0] && r.rows[0].d ? r.rows[0].d : null;
  }

  // ---------- import (any organisation; JSON chosen in the app) ----------
  // Body: { mode: 'merge' | 'replace',
  //         templates: [{classKey,label,team,level,tasks,hours}],
  //         plans: [{code,classKey,shutdownGroup}],
  //         shutdownGroups: [{name,tasks,manpower:[n,n,...]}],
  //         rows: [[machineCode,'YYYY-MM-DD',level,shutdownDay]] }
  app.post('/api/pm/import', requirePermission('manage_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const b = req.body || {};
      const rowsIn = Array.isArray(b.rows) ? b.rows : [];
      if (!rowsIn.length && !(Array.isArray(b.templates) && b.templates.length)) return res.status(400).json({ error: 'The file has no PM data in it' });
      const replace = b.mode === 'replace';

      const machines = await dbAll('SELECT id, code FROM machines WHERE organization_id = $1', [orgId]);
      const byCode = new Map();
      machines.forEach(m => byCode.set(normCode(m.code), m.id));
      const resolve = code => { for (const v of codeVariants(code)) if (byCode.has(v)) return byCode.get(v); return null; };
      const unmatched = new Set();

      const result = await withTransaction(async (client) => {
        let templates = 0, plans = 0, groups = 0, inserted = 0, removed = 0;
        // templates
        for (const t of (Array.isArray(b.templates) ? b.templates : [])) {
          if (!t || !t.classKey || !LEVELS.includes(t.level)) continue;
          await client.query(`
            INSERT INTO pm_templates (organization_id, class_key, label, team, level, tasks, hours)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (organization_id, class_key, level) DO UPDATE SET label = EXCLUDED.label, team = EXCLUDED.team, tasks = EXCLUDED.tasks, hours = EXCLUDED.hours`,
            [orgId, String(t.classKey), t.label || null, t.team || null, t.level, String(t.tasks || ''), t.hours === undefined || t.hours === null ? null : Number(t.hours)]);
          templates++;
        }
        // machine plans
        for (const p of (Array.isArray(b.plans) ? b.plans : [])) {
          const mid = resolve(p && p.code);
          if (!mid || !p.classKey) { if (p && p.code) unmatched.add(p.code); continue; }
          await client.query(`
            INSERT INTO pm_machine_plan (organization_id, machine_id, class_key, shutdown_group) VALUES ($1,$2,$3,$4)
            ON CONFLICT (organization_id, machine_id) DO UPDATE SET class_key = EXCLUDED.class_key, shutdown_group = EXCLUDED.shutdown_group`,
            [orgId, mid, String(p.classKey), p.shutdownGroup || null]);
          plans++;
        }
        // shutdown groups
        let so = 0;
        for (const g of (Array.isArray(b.shutdownGroups) ? b.shutdownGroups : [])) {
          if (!g || !g.name) continue;
          await client.query(`
            INSERT INTO pm_shutdown_groups (organization_id, name, tasks, manpower, sort_order) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (organization_id, name) DO UPDATE SET tasks = EXCLUDED.tasks, manpower = EXCLUDED.manpower, sort_order = EXCLUDED.sort_order`,
            [orgId, g.name, g.tasks || '', (Array.isArray(g.manpower) ? g.manpower : []).map(x => x === null || x === undefined ? '' : x).join(','), so++]);
          groups++;
        }
        // schedule rows
        if (replace) {
          const r = await client.query(`DELETE FROM pm_schedule WHERE organization_id = $1 AND status = 'Planned' AND log_id IS NULL AND due_date >= $2::date`, [orgId, today()]);
          removed = r.rowCount || 0;
        }
        const good = [];
        for (const r of rowsIn) {
          if (!Array.isArray(r) || !isDate(r[1]) || !LEVELS.includes(r[2])) continue;
          const mid = resolve(r[0]);
          if (!mid) { unmatched.add(r[0]); continue; }
          good.push([mid, r[1], r[2], parseInt(r[3], 10) || 0]);
        }
        for (let i = 0; i < good.length; i += 800) {
          const part = good.slice(i, i + 800);
          const r = await client.query(`
            INSERT INTO pm_schedule (organization_id, machine_id, due_date, orig_date, level, shutdown_day)
            SELECT $1, t.m, t.d::date, t.d::date, t.l, t.s
            FROM unnest($2::text[], $3::text[], $4::text[], $5::int[]) AS t(m, d, l, s)
            ON CONFLICT (organization_id, machine_id, due_date) DO NOTHING`,
            [orgId, part.map(x => x[0]), part.map(x => x[1]), part.map(x => x[2]), part.map(x => x[3])]);
          inserted += r.rowCount || 0;
        }
        return { templates, plans, groups, inserted, skippedExisting: good.length - inserted, removed };
      });
      res.json(Object.assign({ ok: true, unmatched: Array.from(unmatched).sort() }, result));
    } catch (e) { res.status(500).json({ error: 'Import failed: ' + e.message }); }
  });

  // ---------- due lists ----------
  // scope: overdue | today | week | month | range ; level S rows live on the shutdown page
  app.get('/api/pm/due', requirePermission('view_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const td = today();
      const scope = String(req.query.scope || 'week');
      const group = String(req.query.group || '').trim();
      const q = String(req.query.q || '').trim().toLowerCase();
      const level = String(req.query.level || '').trim();
      const status = String(req.query.status || '').trim();
      const where = ['p.organization_id = $1', "p.level <> 'S'"];
      const params = [orgId];
      const P = v => { params.push(v); return '$' + params.length; };
      if (scope === 'overdue') { where.push(`p.status IN ('Planned','In progress')`, `p.due_date < ${P(td)}::date`); }
      else if (scope === 'today') { where.push(`p.due_date = ${P(td)}::date`); }
      else if (scope === 'week') { where.push(`p.due_date BETWEEN ${P(td)}::date AND ${P(addDaysStr(td, 6))}::date`); }
      else if (scope === 'month') { where.push(`p.due_date BETWEEN ${P(td)}::date AND ${P(addDaysStr(td, 30))}::date`); }
      else if (scope === 'range') {
        if (isDate(req.query.from)) where.push(`p.due_date >= ${P(req.query.from)}::date`);
        if (isDate(req.query.to)) where.push(`p.due_date <= ${P(req.query.to)}::date`);
      }
      if (group) where.push(`m.department = ${P(group)}`);
      if (LEVEL_NAME[level]) where.push(`p.level = ${P(level)}`);
      if (status) where.push(`p.status = ${P(status)}`);
      if (q) where.push(`(LOWER(m.name) LIKE ${P('%' + q + '%')} OR LOWER(m.code) LIKE ${P('%' + q + '%')})`);
      const [rows, plans] = await Promise.all([
        dbAll(`${SELECT_ROW} WHERE ${where.join(' AND ')} ORDER BY p.due_date, m.department, m.code LIMIT 600`, params),
        loadPlans(orgId)
      ]);
      res.json({ today: td, rows: rows.map(r => toJSON(r, plans)) });
    } catch (e) { res.status(500).json({ error: 'Could not load PM list: ' + e.message }); }
  });

  // ---------- compliance ----------
  async function buildSummary(orgId, from, to) {
    const td = today();
    const rows = await dbAll(`
      SELECT m.department AS grp, p.level, p.status,
             (p.due_date < $4::date AND p.status IN ('Planned','In progress')) AS overdue,
             (p.due_date <= $4::date) AS due,
             (p.status = 'Done' AND p.done_at IS NOT NULL AND (p.done_at AT TIME ZONE '${TZ}')::date <= p.due_date + ${GRACE_DAYS}) AS ontime
      FROM pm_schedule p JOIN machines m ON m.id = p.machine_id
      WHERE p.organization_id = $1 AND p.due_date BETWEEN $2::date AND $3::date`, [orgId, from, to, td]);
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
    const overdueNow = await dbGet(`SELECT COUNT(*) AS n FROM pm_schedule WHERE organization_id = $1 AND status IN ('Planned','In progress') AND due_date < $2::date AND level <> 'S'`, [orgId, td]);
    const odRows = await dbAll(`${SELECT_ROW} WHERE p.organization_id = $1 AND p.status IN ('Planned','In progress') AND p.due_date < $2::date AND p.level <> 'S' ORDER BY p.due_date, m.code LIMIT 40`, [orgId, td]);
    return {
      from, to, today: td, overdueNow: parseInt(overdueNow.n, 10), total: out(tot),
      groups: Array.from(groups.entries()).map(([k, v]) => Object.assign({ group: k }, out(v))).sort((a, b) => b.planned - a.planned),
      levels: Array.from(levels.entries()).map(([k, v]) => Object.assign({ level: k, levelName: LEVEL_NAME[k] || k }, out(v))),
      overdueList: odRows.map(r => ({
        machine: r.machine_name, code: r.machine_code, group: r.machine_group || '', level: r.level, levelName: LEVEL_NAME[r.level] || r.level,
        dueDate: r.due_date, daysLate: Math.max(0, Math.round((new Date(td + 'T00:00:00Z') - new Date(r.due_date + 'T00:00:00Z')) / 86400000))
      }))
    };
  }
  app.get('/api/pm/summary', requirePermission('view_machines'), async (req, res) => {
    try {
      const td = today();
      const from = isDate(req.query.from) ? req.query.from : td.slice(0, 8) + '01';
      const to = isDate(req.query.to) ? req.query.to : td;
      res.json(await buildSummary(req.session.user.organizationId, from, to));
    } catch (e) { res.status(500).json({ error: 'Could not load PM summary: ' + e.message }); }
  });
  // numbers for the dashboard cards
  async function dashboardNumbers(orgId) {
    const td = today();
    const r = await dbGet(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status IN ('Planned','In progress') AND level <> 'S' AND due_date BETWEEN $2::date AND $3::date) AS due_soon,
             COUNT(*) FILTER (WHERE status IN ('Planned','In progress') AND level <> 'S' AND due_date < $2::date) AS overdue,
             COUNT(DISTINCT machine_id) FILTER (WHERE status IN ('Planned','In progress') AND level <> 'S' AND due_date < $2::date) AS overdue_machines,
             COUNT(DISTINCT machine_id) AS machines
      FROM pm_schedule WHERE organization_id = $1`, [orgId, td, addDaysStr(td, 6)]);
    return { total: parseInt(r.total, 10), dueSoon: parseInt(r.due_soon, 10), overdue: parseInt(r.overdue, 10),
             overdueMachines: parseInt(r.overdue_machines, 10), machines: parseInt(r.machines, 10) };
  }
  app.locals.pm = { ensureSchema, linkLog, syncFromLog, nextPlannedDate, summary: buildSummary, dashboardNumbers };

  // ---------- shutdown ----------
  app.get('/api/pm/shutdown', requirePermission('view_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const yrs = await dbAll(`SELECT DISTINCT EXTRACT(YEAR FROM due_date)::int AS y FROM pm_schedule WHERE organization_id = $1 AND level = 'S' ORDER BY 1`, [orgId]);
      const years = yrs.map(r => r.y);
      let year = parseInt(req.query.year, 10);
      if (!year) { const cy = parseInt(today().slice(0, 4), 10); year = years.includes(cy) ? cy : (years.find(y => y >= cy) || years[years.length - 1] || cy); }
      const [rows, plans] = await Promise.all([
        dbAll(`${SELECT_ROW} WHERE p.organization_id = $1 AND p.level = 'S' AND p.due_date BETWEEN $2::date AND $3::date ORDER BY p.due_date, m.department, m.code`, [orgId, year + '-01-01', year + '-12-31']),
        loadPlans(orgId)
      ]);
      const dates = [];
      rows.forEach(r => { if (r.shutdown_day && !dates[r.shutdown_day - 1]) dates[r.shutdown_day - 1] = r.due_date; });
      for (let i = 0; i < dates.length; i++) if (!dates[i]) dates[i] = null;
      res.json({
        year, years, dates, groups: plans.groups,
        rows: rows.map(r => Object.assign(toJSON(r, plans), { shutdownGroup: (plans.plan.get(r.machine_id) || {}).shutdown_group || 'Other' }))
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
        [req.session.user.name || req.session.user.username || null, String((req.body || {}).note || '').trim(), row.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not mark done: ' + e.message }); }
  });
  app.post('/api/pm/bulk-complete', requirePermission('submit_logs'), async (req, res) => {
    try {
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(x => parseInt(x, 10)).filter(Boolean).slice(0, 500);
      if (!ids.length) return res.status(400).json({ error: 'Nothing selected' });
      const r = await dbRun(`UPDATE pm_schedule SET status = 'Done', done_at = NOW(), done_by = $3 WHERE organization_id = $1 AND id = ANY($2::int[]) AND status <> 'Done'`,
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
