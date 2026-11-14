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

const ExcelJS = require('exceljs');

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
      else if (scope === 'quarter') { where.push(`p.due_date BETWEEN ${P(td)}::date AND ${P(addDaysStr(td, 90))}::date`); }
      else if (scope === 'year') { where.push(`p.due_date BETWEEN ${P(td)}::date AND ${P(td.slice(0, 4) + '-12-31')}::date`); }
      else if (scope === 'upcoming') { where.push(`p.due_date >= ${P(td)}::date`); }
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


  // ---------- full-year chart (machine x week) ----------
  const LEVEL_RANK = { S: 6, A: 5, H: 4, Q: 3, M: 2, W: 1 };
  function pickYear(years, req) {
    let year = parseInt(req.query.year, 10);
    if (!year) { const cy = parseInt(today().slice(0, 4), 10); year = years.includes(cy) ? cy : (years.find(y => y >= cy) || years[years.length - 1] || cy); }
    return year;
  }
  async function yearRows(orgId, year, group) {
    const params = [orgId, year + '-01-01', year + '-12-31'];
    let extra = '';
    if (group) { params.push(group); extra = ' AND m.department = $4'; }
    return dbAll(`${SELECT_ROW} WHERE p.organization_id = $1 AND p.due_date BETWEEN $2::date AND $3::date${extra} ORDER BY m.department, m.code, p.due_date`, params);
  }
  app.get('/api/pm/chart', requirePermission('view_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const yrs = await dbAll(`SELECT DISTINCT EXTRACT(YEAR FROM due_date)::int AS y FROM pm_schedule WHERE organization_id = $1 ORDER BY 1`, [orgId]);
      const years = yrs.map(r => r.y);
      const year = pickYear(years, req);
      const rows = await yearRows(orgId, year, String(req.query.group || '').trim());
      const by = new Map();
      rows.forEach(r => {
        let m = by.get(r.machine_id);
        if (!m) { m = { code: r.machine_code, name: r.machine_name, group: r.machine_group || 'Uncategorised', v: [] }; by.set(r.machine_id, m); }
        m.v.push([r.id, r.due_date, r.level, r.status]);
      });
      res.json({ year, years, today: today(), machines: Array.from(by.values()) });
    } catch (e) { res.status(500).json({ error: 'Could not load PM chart: ' + e.message }); }
  });

  // ---------- Excel download of the whole PM schedule ----------
  app.get('/api/pm/export', requirePermission('view_machines'), async (req, res) => {
    try {
      const orgId = req.session.user.organizationId;
      const org = (await dbGet('SELECT * FROM organizations WHERE id = $1', [orgId])) || {};
      const yrs = await dbAll(`SELECT DISTINCT EXTRACT(YEAR FROM due_date)::int AS y FROM pm_schedule WHERE organization_id = $1 ORDER BY 1`, [orgId]);
      const year = pickYear(yrs.map(r => r.y), req);
      const group = String(req.query.group || '').trim();
      const rows = await yearRows(orgId, year, group);
      const td = today();
      const plans = await loadPlans(orgId);
      const wb = new ExcelJS.Workbook();
      wb.creator = (org.name || 'CMMS') + ' - CMMS';
      const NAVY = 'FF0B2545', BAND = 'FF1F3A5F';
      const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
      const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
      const heavy = { style: 'medium', color: { argb: NAVY } };
      const FILL = { W: 'FFDDEBF7', M: 'FFBDD7EE', Q: 'FFC6E0B4', H: 'FFFFE699', A: 'FFF4B183', S: 'FFD9C3E8' };
      const title = `Preventive Maintenance ${year}${group ? ' - ' + group : ''}`;
      const lh = h.letterhead || {};
      const brandLines = String(lh.brandText ? lh.brandText(org) : (org.name || '')).split('\n').map(x => x.trim()).filter(Boolean).slice(0, 2);
      const docLine = ['Document No. ' + (org.doc_no_excel || 'N/A'), 'Effective Date: ' + (org.doc_effective_date_excel || 'N/A'), 'Rev: ' + (org.doc_rev_excel || 'N/A'), 'Approved By: ' + (org.approved_by || 'N/A')].join('     ');
      // logo + company name + title, rows 1-3 of every sheet; row 4 = document control / note
      const letterhead = (ws, sheetTitle, note) => {
        [1, 2, 3].forEach(i => { ws.getRow(i).height = 22; });
        if (lh.addLogo) { try { lh.addLogo(wb, ws, org); } catch (e) { /* logo is optional */ } }
        const texts = brandLines.concat([sheetTitle + ' - ' + title]).slice(-3);
        texts.forEach((t, i) => {
          const c = ws.getRow(i + 1).getCell(3);
          c.value = t;
          c.font = i === texts.length - 1 ? { bold: true, size: 12, color: { argb: NAVY } } : { bold: i === 0, size: i === 0 ? 14 : 10, color: { argb: NAVY } };
          c.alignment = { vertical: 'middle' };
        });
        const n = ws.getRow(4).getCell(1); n.value = note ? docLine + '     |     ' + note : docLine; n.font = { italic: true, size: 9 };
      };
      const head = (ws, rowNo, lastCol) => {
        const r = ws.getRow(rowNo);
        for (let c = 1; c <= lastCol; c++) { const x = r.getCell(c); x.fill = solid(NAVY); x.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 }; x.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; }
      };
      const band = (ws, rowNo, name, lastCol) => {
        const r = ws.getRow(rowNo);
        for (let c = 1; c <= lastCol; c++) { const x = r.getCell(c); x.fill = solid(BAND); x.border = { top: heavy, bottom: heavy }; }
        const a = r.getCell(1); a.value = String(name).toUpperCase(); a.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      };
      const closeGroup = (ws, rowNo, lastCol) => {
        const r = ws.getRow(rowNo);
        for (let c = 1; c <= lastCol; c++) { const x = r.getCell(c); x.border = Object.assign({}, x.border, { bottom: heavy }); }
      };
      const dayCell = (cell, list) => {
        list.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
        cell.value = list.map(x => x.level).join('');
        const overdue = list.some(x => (x.status === 'Planned' || x.status === 'In progress') && x.due_date < td);
        const allDone = list.every(x => x.status === 'Done' || x.status === 'Skipped');
        cell.fill = solid(overdue ? 'FFFFC7CE' : allDone ? 'FFC6EFCE' : FILL[list[0].level]);
        cell.font = { bold: true, size: 8, color: { argb: overdue ? 'FF9C0006' : 'FF1F2937' } };
        cell.alignment = { horizontal: 'center' };
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      };
      const byM = new Map();
      rows.forEach(r => { if (!byM.has(r.machine_id)) byM.set(r.machine_id, { r0: r, v: [] }); byM.get(r.machine_id).v.push(r); });
      const machines = Array.from(byM.values());
      const grpOf = m => m.r0.machine_group || 'Uncategorised';
      const DAYN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      const MNAME = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const KEY_NOTE = 'W weekly, M monthly, Q quarterly, H half-yearly, A annual, S annual at shutdown. Green = done, red = overdue.';

      // grid sheet: machines down, one column per day between two dates, grouped by category
      const grid = (ws, y, m0, m1, firstDataRow, headRows) => {
        const start = Date.UTC(y, m0, 1), end = Date.UTC(y, m1 + 1, 0);
        const nD = Math.round((end - start) / 86400000) + 1, last = 3 + nD;
        const [rMon, rWd, rDay] = headRows;
        ws.getRow(rWd).getCell(1).value = 'Code'; ws.getRow(rWd).getCell(2).value = 'Machine'; ws.getRow(rWd).getCell(3).value = 'Group';
        for (let n = 0; n < nD; n++) {
          const d = new Date(start + n * 86400000), c = 4 + n;
          if (rMon && d.getUTCDate() === 1) ws.getRow(rMon).getCell(c).value = MNAME[d.getUTCMonth()];
          ws.getRow(rWd).getCell(c).value = DAYN[d.getUTCDay()];
          ws.getRow(rDay).getCell(c).value = d.getUTCDate();
          ws.getColumn(c).width = nD > 40 ? 3.1 : 4.6;
        }
        ws.getColumn(1).width = 12; ws.getColumn(2).width = 34; ws.getColumn(3).width = 20;
        head(ws, rWd, last); head(ws, rDay, last); if (rMon) head(ws, rMon, last);
        ws.getRow(rWd).font = { bold: true, size: 7, color: { argb: 'FFFFFFFF' } };
        ws.getRow(rDay).font = { bold: true, size: 7, color: { argb: 'FFFFFFFF' } };
        let rowNo = firstDataRow, lastG = null, prevRow = null, count = 0;
        const perDay = new Array(nD).fill(0);
        for (const m of machines) {
          const mine = m.v.filter(v => { const t = Date.UTC(+v.due_date.slice(0, 4), +v.due_date.slice(5, 7) - 1, +v.due_date.slice(8, 10)); return t >= start && t <= end; });
          if (!mine.length) continue;
          if (grpOf(m) !== lastG) { if (prevRow) closeGroup(ws, prevRow, last); band(ws, rowNo++, grpOf(m), last); lastG = grpOf(m); }
          const row = ws.getRow(rowNo);
          row.getCell(1).value = m.r0.machine_code; row.getCell(2).value = m.r0.machine_name; row.getCell(3).value = grpOf(m);
          [1, 2, 3].forEach(c => { row.getCell(c).border = { bottom: thin, right: thin }; });
          const days = new Map();
          mine.forEach(v => { const n = Math.round((Date.UTC(+v.due_date.slice(0, 4), +v.due_date.slice(5, 7) - 1, +v.due_date.slice(8, 10)) - start) / 86400000); if (!days.has(n)) days.set(n, []); days.get(n).push(v); });
          for (const [n, list] of days) { dayCell(row.getCell(4 + n), list); perDay[n]++; }
          prevRow = rowNo; rowNo++; count++;
        }
        if (prevRow) closeGroup(ws, prevRow, last);
        const tot = ws.getRow(rowNo + 1); tot.getCell(2).value = 'Machines serviced that day'; tot.getCell(2).font = { bold: true };
        for (let n = 0; n < nD; n++) { const c = tot.getCell(4 + n); c.value = perDay[n] || null; c.font = { bold: true, size: 8 }; c.alignment = { horizontal: 'center' }; }
        ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: nD > 40 ? 8 : 9 };
        return count;
      };

      // 1. every day of the year
      const ws = wb.addWorksheet('Whole Year', { views: [{ state: 'frozen', xSplit: 3, ySplit: 7 }] });
      letterhead(ws, 'Every day of ' + year, KEY_NOTE);
      grid(ws, year, 0, 11, 8, [5, 6, 7]);

      // 2. one sheet per month
      for (let mo = 0; mo < 12; mo++) {
        const ms = year + '-' + String(mo + 1).padStart(2, '0');
        if (!rows.some(r => r.due_date.slice(0, 7) === ms)) continue;
        const wm = wb.addWorksheet(MNAME[mo].charAt(0) + MNAME[mo].slice(1).toLowerCase() + ' ' + year, { views: [{ state: 'frozen', xSplit: 3, ySplit: 6 }] });
        letterhead(wm, new Date(Date.UTC(year, mo, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }) + ' ' + year, KEY_NOTE);
        grid(wm, year, mo, mo, 7, [null, 5, 6]);
      }

      // list-style sheets share one pattern: letterhead, header on row 5, data from row 6, heavy line when the category changes
      const listSheet = (name, sheetTitle, cols, lastGroupKey) => {
        const w = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 5 }] });
        letterhead(w, sheetTitle, '');
        cols.forEach((c, i) => { w.getColumn(i + 1).width = c[1]; w.getRow(5).getCell(i + 1).value = c[0]; });
        head(w, 5, cols.length);
        let rn = 6, prev = null;
        return {
          ws: w,
          add: (vals, key) => {
            const r = w.getRow(rn);
            vals.forEach((v, i) => { const c = r.getCell(i + 1); c.value = v; c.border = { bottom: thin, right: thin }; });
            if (lastGroupKey && key !== prev && prev !== null) for (let c = 1; c <= cols.length; c++) r.getCell(c).border = Object.assign({}, r.getCell(c).border, { top: heavy });
            prev = key; rn++; return r;
          },
          next: () => rn
        };
      };

      const L1 = listSheet('PM Schedule', 'Visit list', [['Machine code', 14], ['Machine', 36], ['Group', 22], ['Due date', 12], ['Level', 16], ['Status', 12], ['Done on', 12], ['Originally planned', 16], ['Note', 36]], true);
      rows.forEach(r => L1.add([
        r.machine_code, r.machine_name, r.machine_group || 'Uncategorised', r.due_date, LEVEL_NAME[r.level] || r.level,
        (r.status === 'Planned' && r.due_date < td) ? 'Overdue' : r.status,
        r.done_at ? new Date(r.done_at).toLocaleDateString('en-CA', { timeZone: TZ }) : '', r.orig_date !== r.due_date ? r.orig_date : '', r.note || ''
      ], r.machine_group || 'Uncategorised'));
      L1.ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: 9 } };

      const L2 = listSheet('Shutdown Plan', 'Shutdown plan', [['Day', 6], ['Date', 12], ['Work package', 34], ['Machine code', 14], ['Machine', 36], ['Status', 12]], true);
      rows.filter(r => r.level === 'S').sort((a, b) => (a.shutdown_day - b.shutdown_day) || a.machine_code.localeCompare(b.machine_code)).forEach(r =>
        L2.add([r.shutdown_day || '', r.due_date, (plans.plan.get(r.machine_id) || {}).shutdown_group || '', r.machine_code, r.machine_name, r.status], r.shutdown_day || 0));

      const sum = await buildSummary(orgId, year + '-01-01', year + '-12-31');
      const L3 = listSheet('Compliance', 'Compliance', [['Group', 28], ['Planned', 11], ['Due so far', 11], ['Done', 10], ['On time', 10], ['Overdue', 10], ['Done %', 10], ['On time %', 11]], false);
      const line = (n, x) => L3.add([n, x.planned, x.due, x.dueDone, x.dueOnTime, x.overdue, x.donePct == null ? '' : x.donePct / 100, x.onTimePct == null ? '' : x.onTimePct / 100]);
      sum.groups.forEach(g => line(g.group, g));
      line('TOTAL', sum.total).font = { bold: true };
      L3.ws.getColumn(7).numFmt = '0.0%'; L3.ws.getColumn(8).numFmt = '0.0%';
      if (sum.overdueList.length) {
        L3.add([]); const hh = L3.add(['Overdue visits (oldest first)', 'Code', 'Level', 'Due date', 'Days late']); hh.font = { bold: true };
        sum.overdueList.forEach(o => L3.add([o.machine, o.code, o.levelName, o.dueDate, o.daysLate]));
      }

      const K = listSheet('Key', 'Key', [['Letter', 12], ['Meaning', 60]], false);
      Object.keys(LEVEL_NAME).forEach(k => { const r = K.add([k, LEVEL_NAME[k]]); r.getCell(1).fill = solid(FILL[k]); r.getCell(1).alignment = { horizontal: 'center' }; });
      K.add(['Green', 'Done']).getCell(1).fill = solid('FFC6EFCE');
      K.add(['Red', 'Overdue']).getCell(1).fill = solid('FFFFC7CE');

      const safe = String(org.name || 'CMMS').replace(/[^A-Za-z0-9]+/g, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}_PM_Schedule_${year}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: 'Could not build Excel file: ' + e.message }); else res.end(); }
  });

  // distinct groups for the filter dropdown
  app.get('/api/pm/groups', requirePermission('view_machines'), async (req, res) => {
    try {
      const rows = await dbAll(`SELECT DISTINCT m.department AS g FROM pm_schedule p JOIN machines m ON m.id = p.machine_id WHERE p.organization_id = $1 ORDER BY 1`, [req.session.user.organizationId]);
      res.json(rows.map(r => r.g).filter(Boolean));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
