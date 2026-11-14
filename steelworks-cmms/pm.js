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
      const org = await dbGet('SELECT name FROM organizations WHERE id = $1', [orgId]);
      const yrs = await dbAll(`SELECT DISTINCT EXTRACT(YEAR FROM due_date)::int AS y FROM pm_schedule WHERE organization_id = $1 ORDER BY 1`, [orgId]);
      const year = pickYear(yrs.map(r => r.y), req);
      const group = String(req.query.group || '').trim();
      const rows = await yearRows(orgId, year, group);
      const td = today();
      const plans = await loadPlans(orgId);
      const wb = new ExcelJS.Workbook();
      wb.creator = (org && org.name ? org.name : 'CMMS') + ' - CMMS';
      const NAVY = 'FF0B2545';
      const head = (ws, rowNo) => { const r = ws.getRow(rowNo); r.font = { bold: true, color: { argb: 'FFFFFFFF' } }; r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; r.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; };
      const FILL = { W: 'FFDDEBF7', M: 'FFBDD7EE', Q: 'FFC6E0B4', H: 'FFFFE699', A: 'FFF4B183', S: 'FFD9C3E8' };
      const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
      const thin = { style: 'thin', color: { argb: 'FFBFBFBF' } };
      const title = `${org && org.name ? org.name : ''} - Preventive Maintenance ${year}${group ? ' - ' + group : ''}`;

      // 1. chart: machines down, weeks across
      const ws = wb.addWorksheet('PM Chart', { views: [{ state: 'frozen', xSplit: 3, ySplit: 4 }] });
      const jan1 = new Date(year + '-01-01T00:00:00Z');
      const dow = (jan1.getUTCDay() + 6) % 7;
      const first = new Date(jan1.getTime() - dow * 86400000);
      const nWeeks = Math.floor((new Date(year + '-12-31T00:00:00Z') - first) / 86400000 / 7) + 1;
      ws.getCell('A1').value = title; ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
      ws.getCell('A2').value = 'Each column is a week (starting Monday). Letters: W weekly, M monthly, Q quarterly, H half-yearly, A annual, S annual at shutdown. Green = done, red = overdue.';
      ws.getCell('A2').font = { italic: true, size: 9 };
      ws.getRow(3).values = ['Code', 'Machine', 'Group'];
      ws.getRow(4).values = ['', '', ''];
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      let lastMonth = -1;
      for (let w = 0; w < nWeeks; w++) {
        const ds = new Date(first.getTime() + w * 7 * 86400000);
        const c = 4 + w;
        const mo = ds.getUTCMonth() + (ds.getUTCFullYear() < year ? -12 : 0);
        if (ds.getUTCFullYear() === year && ds.getUTCMonth() !== lastMonth) { ws.getRow(3).getCell(c).value = monthNames[ds.getUTCMonth()]; lastMonth = ds.getUTCMonth(); }
        ws.getRow(4).getCell(c).value = String(ds.getUTCDate()).padStart(2, '0') + '/' + String(ds.getUTCMonth() + 1).padStart(2, '0');
        ws.getColumn(c).width = 5.2;
      }
      ws.getColumn(1).width = 12; ws.getColumn(2).width = 34; ws.getColumn(3).width = 20;
      head(ws, 3); head(ws, 4);
      ws.getRow(4).font = { bold: true, size: 8, color: { argb: 'FFFFFFFF' } };
      const byM = new Map();
      rows.forEach(r => { if (!byM.has(r.machine_id)) byM.set(r.machine_id, { r0: r, v: [] }); byM.get(r.machine_id).v.push(r); });
      let rowNo = 5;
      for (const m of byM.values()) {
        const row = ws.getRow(rowNo++);
        row.getCell(1).value = m.r0.machine_code; row.getCell(2).value = m.r0.machine_name; row.getCell(3).value = m.r0.machine_group || '';
        const weeks = new Map();
        m.v.forEach(v => {
          const w = Math.floor((new Date(v.due_date + 'T00:00:00Z') - first) / 86400000 / 7);
          if (!weeks.has(w)) weeks.set(w, []); weeks.get(w).push(v);
        });
        for (const [w, list] of weeks) {
          list.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
          const cell = row.getCell(4 + w);
          cell.value = list.map(x => x.level).join('');
          const open = list.filter(x => x.status === 'Planned' || x.status === 'In progress');
          const overdue = open.some(x => x.due_date < td);
          const allDone = list.every(x => x.status === 'Done' || x.status === 'Skipped');
          cell.fill = solid(overdue ? 'FFFFC7CE' : allDone ? 'FFC6EFCE' : FILL[list[0].level]);
          cell.font = { bold: true, size: 9, color: { argb: overdue ? 'FF9C0006' : 'FF1F2937' } };
          cell.alignment = { horizontal: 'center' };
          cell.border = { top: thin, left: thin, bottom: thin, right: thin };
        }
      }
      ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, rowNo - 1), column: 3 } };
      ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 8 };

      // 2. flat list
      const wl = wb.addWorksheet('PM Schedule', { views: [{ state: 'frozen', ySplit: 1 }] });
      wl.columns = [
        { header: 'Machine code', key: 'c', width: 14 }, { header: 'Machine', key: 'n', width: 36 }, { header: 'Group', key: 'g', width: 22 },
        { header: 'Due date', key: 'd', width: 12 }, { header: 'Level', key: 'l', width: 16 }, { header: 'Status', key: 's', width: 12 },
        { header: 'Done on', key: 'dn', width: 12 }, { header: 'Originally planned', key: 'o', width: 16 }, { header: 'Note', key: 'nt', width: 36 }
      ];
      head(wl, 1);
      rows.forEach(r => wl.addRow({
        c: r.machine_code, n: r.machine_name, g: r.machine_group || '', d: r.due_date, l: LEVEL_NAME[r.level] || r.level,
        s: (r.status === 'Planned' && r.due_date < td) ? 'Overdue' : r.status,
        dn: r.done_at ? new Date(r.done_at).toLocaleDateString('en-CA', { timeZone: TZ }) : '', o: r.orig_date !== r.due_date ? r.orig_date : '', nt: r.note || ''
      }));
      wl.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 9 } };

      // 3. shutdown plan
      const wsd = wb.addWorksheet('Shutdown Plan', { views: [{ state: 'frozen', ySplit: 1 }] });
      wsd.columns = [
        { header: 'Day', width: 6 }, { header: 'Date', width: 12 }, { header: 'Work package', width: 34 }, { header: 'Machine code', width: 14 },
        { header: 'Machine', width: 36 }, { header: 'Status', width: 12 }
      ];
      head(wsd, 1);
      rows.filter(r => r.level === 'S').sort((a, b) => (a.shutdown_day - b.shutdown_day) || a.machine_code.localeCompare(b.machine_code)).forEach(r =>
        wsd.addRow([r.shutdown_day || '', r.due_date, (plans.plan.get(r.machine_id) || {}).shutdown_group || '', r.machine_code, r.machine_name, r.status]));

      // 4. compliance for the year so far
      const sum = await buildSummary(orgId, year + '-01-01', year + '-12-31');
      const wc = wb.addWorksheet('Compliance');
      wc.columns = [{ header: 'Group', width: 28 }, { header: 'Planned', width: 11 }, { header: 'Due so far', width: 11 }, { header: 'Done', width: 10 }, { header: 'On time', width: 10 }, { header: 'Overdue', width: 10 }, { header: 'Done %', width: 10 }, { header: 'On time %', width: 11 }];
      head(wc, 1);
      const line = (n, x) => wc.addRow([n, x.planned, x.due, x.dueDone, x.dueOnTime, x.overdue, x.donePct == null ? '' : x.donePct / 100, x.onTimePct == null ? '' : x.onTimePct / 100]);
      sum.groups.forEach(g => line(g.group, g));
      const tr = line('TOTAL', sum.total); tr.font = { bold: true };
      wc.getColumn(7).numFmt = '0.0%'; wc.getColumn(8).numFmt = '0.0%';
      if (sum.overdueList.length) {
        wc.addRow([]); const h = wc.addRow(['Overdue visits (oldest first)', 'Code', 'Level', 'Due date', 'Days late']); h.font = { bold: true };
        sum.overdueList.forEach(o => wc.addRow([o.machine, o.code, o.levelName, o.dueDate, o.daysLate]));
      }

      // 5. key
      const wk = wb.addWorksheet('Key');
      wk.columns = [{ width: 10 }, { width: 70 }];
      wk.addRow(['Letter', 'Meaning']); head(wk, 1);
      Object.keys(LEVEL_NAME).forEach(k => { const r = wk.addRow([k, LEVEL_NAME[k]]); r.getCell(1).fill = solid(FILL[k]); r.getCell(1).alignment = { horizontal: 'center' }; });
      wk.addRow(['Green', 'Done']).getCell(1).fill = solid('FFC6EFCE');
      wk.addRow(['Red', 'Overdue']).getCell(1).fill = solid('FFFFC7CE');

      const safe = String(org && org.name || 'CMMS').replace(/[^A-Za-z0-9]+/g, '_');
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
