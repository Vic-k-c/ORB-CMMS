const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const ROLES = ['Technician', 'Maintenance Supervisor', 'Management', 'Maintenance HOD'];
// Maintenance HOD has identical access to Management - just a distinct title
// for org charts that prefer that terminology. Any check that used to be
// requireRole('Management') alone now uses requireRole(...FULL_ADMIN_ROLES).
const FULL_ADMIN_ROLES = ['Management', 'Maintenance HOD'];

// ================= DB HELPERS =================
// Postgres via 'pg' is fully async, unlike the old better-sqlite3 (synchronous)
// version - every route handler in this file is now async and awaits these.
async function dbGet(sql, params = []) {
  const r = await db.pool.query(sql, params);
  return r.rows[0] || null;
}
async function dbAll(sql, params = []) {
  const r = await db.pool.query(sql, params);
  return r.rows;
}
async function dbRun(sql, params = []) {
  return db.pool.query(sql, params);
}
// Postgres returns COUNT(*)/BIGINT as a STRING (to avoid precision loss for
// very large numbers) - unlike SQLite, which returned a plain JS number. Every
// count in this file is passed through this to avoid silent string/number bugs.
function toInt(v) { return v === null || v === undefined ? 0 : parseInt(v, 10); }
async function withTransaction(fn) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const uploadsDir = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadsDir, req.params.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${crypto.randomInt(1000, 9999)}-${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
  fileFilter: (req, file, cb) => {
    const allowed = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    if (!allowed) return cb(new Error('Only images and PDF files are allowed'));
    cb(null, true);
  }
});

// Logos are stored directly in Postgres (organizations.logo_data), not on
// local disk. This matters specifically because Render's free-tier web
// service has no persistent disk - anything written to the local filesystem
// is wiped whenever the service redeploys or spins down after ~15 minutes
// idle, which is exactly why uploaded logos kept vanishing before this.
// Restricted to PNG/JPEG only (not arbitrary image types) because both
// jsPDF (client-side PDF generation) and ExcelJS (server-side Excel
// generation) only reliably embed those two formats.
const logoStorage = multer.memoryStorage();
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB - it's a logo, not a work photo
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg'].includes(file.mimetype);
    if (!allowed) return cb(new Error('Logo must be a PNG or JPEG image'));
    cb(null, true);
  }
});

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'steelworks-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hour shift
}));
app.use(express.static(path.join(__dirname, 'public')));

function genId(prefix) {
  const ts = Date.now().toString().slice(-6);
  const rand = crypto.randomInt(1000, 9999);
  return `${prefix}-${ts}${rand}`;
}
function nowISO() { return new Date().toISOString(); }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtDateForExcel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function round2(n) { return Math.round(n * 100) / 100; }

// Embeds the organization's uploaded logo (if any) into cell A1 of a worksheet.
// Reads straight from disk - no CORS concern since this runs server-side.
function addLetterheadLogo(workbook, sheet, org) {
  if (!org.logo_data) return;
  const extension = org.logo_mime_type === 'image/png' ? 'png' : 'jpeg';
  const imageId = workbook.addImage({ buffer: org.logo_data, extension });
  sheet.addImage(imageId, { tl: { col: 0.1, row: 0.1 }, ext: { width: 70, height: 70 } });
}

// Text shown next to the logo in Excel letterheads, matching the same three
// modes the app header and PDFs use. The document-control box (doc no,
// effective date, rev, approved by) is unaffected by this - that's compliance
// information, not a branding preference, so it always shows in full.
function getLetterheadBrandText(org) {
  const mode = org.header_display_mode || 'logo_name_tagline';
  if (mode === 'logo_only') return '';
  if (mode === 'logo_tagline') return org.tagline || '';
  return `${org.name}\n${org.tagline || ''}`;
}

// ================= MACHINE METRICS (downtime, failures, MTTR, MTBF) =================
// Standard definitions used here:
//   Cumulative downtime = sum of downtime_hours across ALL logs (Preventive + Breakdown) in the period
//   Number of failures  = count of Breakdown-type logs in the period
//   Scheduled hours     = for each day in the period: a per-date override if one exists, else the
//                          organization's default operating hours/day (set in Settings)
//   Operating time      = scheduled hours minus cumulative downtime (floored at 0)
//   MTTR                = breakdown-only downtime / number of failures
//   MTBF                = operating time / number of failures
// All of these are scoped to one organization - everything here takes organizationId explicitly.
async function getDefaultOperatingHours(organizationId) {
  const row = await dbGet("SELECT value FROM settings WHERE organization_id = $1 AND key = 'default_operating_hours'", [organizationId]);
  return row ? parseFloat(row.value) : 9;
}

async function getScheduledHours(organizationId, fromDate, toDate) {
  const defaultHours = await getDefaultOperatingHours(organizationId);
  const overrides = await dbAll('SELECT date, hours FROM schedule_overrides WHERE organization_id = $1 AND date BETWEEN $2 AND $3', [organizationId, fromDate, toDate]);
  const overrideMap = {};
  overrides.forEach(o => { overrideMap[o.date] = o.hours; });
  let total = 0;
  let cursor = fromDate;
  while (cursor <= toDate) {
    total += (overrideMap[cursor] !== undefined) ? overrideMap[cursor] : defaultHours;
    cursor = addDays(cursor, 1);
  }
  return total;
}

async function computeMachineMetrics(organizationId, machineId, fromDate, toDate) {
  const logs = await dbAll(`
    SELECT log_type, downtime_hours FROM logs
    WHERE organization_id = $1 AND machine_id = $2 AND LEFT(logged_at,10) BETWEEN $3 AND $4
  `, [organizationId, machineId, fromDate, toDate]);

  const cumulativeDowntimeHours = logs.reduce((s, l) => s + (l.downtime_hours || 0), 0);
  const breakdownLogs = logs.filter(l => l.log_type === 'Breakdown');
  const numberOfFailures = breakdownLogs.length;
  const breakdownDowntimeHours = breakdownLogs.reduce((s, l) => s + (l.downtime_hours || 0), 0);

  const scheduledHours = await getScheduledHours(organizationId, fromDate, toDate);
  const operatingTimeHours = Math.max(0, scheduledHours - cumulativeDowntimeHours);

  const mttr = numberOfFailures > 0 ? breakdownDowntimeHours / numberOfFailures : null;
  const mtbf = numberOfFailures > 0 ? operatingTimeHours / numberOfFailures : null;

  return {
    fromDate, toDate,
    cumulativeDowntimeHours: round2(cumulativeDowntimeHours),
    numberOfFailures,
    scheduledHours: round2(scheduledHours),
    operatingTimeHours: round2(operatingTimeHours),
    mttr: mttr !== null ? round2(mttr) : null,
    mtbf: mtbf !== null ? round2(mtbf) : null
  };
}

function resolvePeriod(query) {
  const mode = query.mode || 'monthly';
  const today = todayISO();
  if (mode === 'daily') {
    const date = query.date || today;
    return { fromDate: date, toDate: date };
  }
  if (mode === 'yearly') {
    const year = query.year || today.slice(0, 4);
    return { fromDate: `${year}-01-01`, toDate: `${year}-12-31` };
  }
  if (mode === 'custom') {
    return { fromDate: query.from || today, toDate: query.to || today };
  }
  // monthly (default)
  const year = query.year || today.slice(0, 4);
  const month = (query.month || (new Date().getMonth() + 1)).toString().padStart(2, '0');
  const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
  return { fromDate: `${year}-${month}-01`, toDate: `${year}-${month}-${daysInMonth.toString().padStart(2, '0')}` };
}

// ================= BOOTSTRAP DEFAULT ACCOUNTS =================
// The default org-level admin (kept from before multi-org support existed).
// This only fires on a truly empty database - safe to keep for local/fresh installs.
async function bootstrapOrgAdmin() {
  const countRow = await dbGet('SELECT COUNT(*) as c FROM users');
  if (toInt(countRow.c) === 0) {
    const anyOrg = await dbGet('SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1');
    const u = {
      id: genId('USR'), name: 'Default Administrator', username: 'admin',
      password_hash: bcrypt.hashSync('admin123', 10), role: 'Management',
      organization_id: anyOrg ? anyOrg.id : null, created_at: nowISO()
    };
    await dbRun(
      `INSERT INTO users (id, name, username, password_hash, role, organization_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.id, u.name, u.username, u.password_hash, u.role, u.organization_id, u.created_at]
    );
    console.log('No users found - created default account: username "admin", password "admin123". Change this immediately after first login.');
  }
}

// The platform-level Super Admin, who is not tied to any organization and whose only
// job is to create organizations (and their first Management account).
async function bootstrapSuperAdmin() {
  const countRow = await dbGet("SELECT COUNT(*) as c FROM users WHERE role = 'Super Admin'");
  if (toInt(countRow.c) === 0) {
    const u = {
      id: genId('USR'), name: 'Platform Super Admin', username: 'superadmin',
      password_hash: bcrypt.hashSync('superadmin123', 10), role: 'Super Admin', created_at: nowISO()
    };
    await dbRun(
      `INSERT INTO users (id, name, username, password_hash, role, organization_id, created_at) VALUES ($1,$2,$3,$4,$5,NULL,$6)`,
      [u.id, u.name, u.username, u.password_hash, u.role, u.created_at]
    );
    console.log('Created default Super Admin account: username "superadmin", password "superadmin123" (leave Organization Code blank to log in). Change this immediately - this account can create every organization on this server.');
  }
}

// If there are truly zero organizations (a brand-new Postgres database), seed one
// so bootstrapOrgAdmin above has somewhere to attach the default admin account.
async function bootstrapDefaultOrganization() {
  const countRow = await dbGet('SELECT COUNT(*) as c FROM organizations');
  if (toInt(countRow.c) === 0) {
    const orgId = genId('ORG');
    await dbRun(`
      INSERT INTO organizations (id, name, org_code, tagline, active, created_at)
      VALUES ($1, $2, $3, $4, true, $5)
    `, [orgId, 'My Organization', 'DEFAULT', '', nowISO()]);
    await dbRun("INSERT INTO settings (organization_id, key, value) VALUES ($1, 'default_operating_hours', '9')", [orgId]);
    console.log('No organizations found - created a starter organization (code "DEFAULT"). Rename it via Admin -> Organization Branding once logged in.');
  }
}

// ================= AUTH MIDDLEWARE =================
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}
// Guards the regular (org-scoped) part of the app against Super Admin accounts,
// which intentionally have no organizationId and shouldn't see any org's data.
async function requireOrgContext(req, res, next) {
  if (!req.session.user.organizationId) {
    return res.status(403).json({ error: 'This account is not linked to an organization. Super Admin accounts use the Organizations panel instead.' });
  }
  try {
    const org = await dbGet('SELECT active FROM organizations WHERE id = $1', [req.session.user.organizationId]);
    if (!org || !org.active) {
      return res.status(403).json({ error: 'This organization has been deactivated. Contact your platform administrator.' });
    }
    next();
  } catch (e) { res.status(500).json({ error: 'Server error checking organization status' }); }
}

// ================= AUTH ROUTES (no auth required) =================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password, orgCode } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    let organizationId = null;
    if (orgCode && orgCode.trim()) {
      const org = await dbGet('SELECT * FROM organizations WHERE org_code = $1', [orgCode.trim().toUpperCase()]);
      if (!org) return res.status(401).json({ error: 'Invalid organization code' });
      if (!org.active) return res.status(403).json({ error: 'This organization has been deactivated. Contact your platform administrator.' });
      organizationId = org.id;
    }

    const user = organizationId
      ? await dbGet('SELECT * FROM users WHERE username = $1 AND organization_id = $2', [username.trim(), organizationId])
      : await dbGet('SELECT * FROM users WHERE username = $1 AND organization_id IS NULL', [username.trim()]);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username, password, or organization code' });
    }
    req.session.user = {
      id: user.id, name: user.name, username: user.username, role: user.role,
      organizationId: user.organization_id
    };
    res.json(req.session.user);
  } catch (e) { res.status(500).json({ error: 'Login failed: ' + e.message }); }
});

app.get('/api/auth/me', (req, res) => {
  res.json(req.session.user || null);
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Public on purpose: lets the login page show a remembered organization's
// logo before authentication happens (the browser remembers the last org
// code used on this device via localStorage, not the server). Org codes
// aren't secret - they're already required at every login - so serving
// just a non-sensitive logo image for one is a narrow, low-risk exception
// to the "everything needs a session" rule. Nothing else about that
// organization is exposed here.
app.get('/api/public/org-logo/:orgCode', async (req, res) => {
  try {
    const org = await dbGet('SELECT logo_data, logo_mime_type FROM organizations WHERE org_code = $1', [req.params.orgCode.trim().toUpperCase()]);
    if (!org || !org.logo_data) return res.status(404).json({ error: 'No logo' });
    res.setHeader('Content-Type', org.logo_mime_type || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(org.logo_data);
  } catch (e) { res.status(404).json({ error: 'No logo' }); }
});

// Everything below this line requires a logged-in session
app.use('/api', requireAuth);

// ================= SUPER ADMIN: ORGANIZATIONS =================
// Deliberately placed before requireOrgContext - Super Admin has no organizationId.

app.get('/api/super-admin/organizations', requireRole('Super Admin'), async (req, res) => {
  try {
    const orgs = await dbAll('SELECT * FROM organizations ORDER BY created_at DESC');
    const withCounts = [];
    for (const o of orgs) {
      const mc = await dbGet('SELECT COUNT(*) as c FROM machines WHERE organization_id = $1', [o.id]);
      const uc = await dbGet('SELECT COUNT(*) as c FROM users WHERE organization_id = $1', [o.id]);
      withCounts.push({ ...toOrgJSON(o), machineCount: toInt(mc.c), userCount: toInt(uc.c) });
    }
    res.json(withCounts);
  } catch (e) { res.status(500).json({ error: 'Could not list organizations: ' + e.message }); }
});

app.post('/api/super-admin/organizations', requireRole('Super Admin'), async (req, res) => {
  try {
    const { name, orgCode, tagline, adminName, adminUsername, adminPassword } = req.body;
    if (!name || !orgCode || !adminName || !adminUsername || !adminPassword) {
      return res.status(400).json({ error: "Organization name, org code, and the first admin's details are all required" });
    }
    const code = orgCode.trim().toUpperCase();
    if (await dbGet('SELECT id FROM organizations WHERE org_code = $1', [code])) {
      return res.status(400).json({ error: 'That organization code is already taken' });
    }
    if (await dbGet('SELECT id FROM users WHERE username = $1', [adminUsername.trim()])) {
      return res.status(400).json({ error: 'That username is already taken system-wide' });
    }

    const orgId = genId('ORG');
    const org = {
      id: orgId, name: name.trim(), org_code: code, tagline: (tagline || '').trim(), logo_url: null,
      doc_no_log: '', doc_effective_date_log: '', doc_rev_log: '', doc_issue_log: '',
      doc_no_excel: '', doc_effective_date_excel: '', doc_rev_excel: '',
      approved_by: '', active: true, created_at: nowISO()
    };
    const adminUser = {
      id: genId('USR'), name: adminName.trim(), username: adminUsername.trim(),
      password_hash: bcrypt.hashSync(adminPassword, 10), role: 'Management',
      organization_id: orgId, created_at: nowISO()
    };

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO organizations (id, name, org_code, tagline, logo_url, doc_no_log, doc_effective_date_log, doc_rev_log, doc_issue_log, doc_no_excel, doc_effective_date_excel, doc_rev_excel, approved_by, active, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [org.id, org.name, org.org_code, org.tagline, org.logo_url, org.doc_no_log, org.doc_effective_date_log, org.doc_rev_log, org.doc_issue_log, org.doc_no_excel, org.doc_effective_date_excel, org.doc_rev_excel, org.approved_by, org.active, org.created_at]);
      await client.query(`
        INSERT INTO users (id, name, username, password_hash, role, organization_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [adminUser.id, adminUser.name, adminUser.username, adminUser.password_hash, adminUser.role, adminUser.organization_id, adminUser.created_at]);
      await client.query(`INSERT INTO settings (organization_id, key, value) VALUES ($1, 'default_operating_hours', '9')`, [orgId]);
    });

    res.status(201).json({ organization: toOrgJSON(org), adminUsername: adminUser.username });
  } catch (e) { res.status(500).json({ error: 'Could not create organization: ' + e.message }); }
});

app.put('/api/super-admin/organizations/:id', requireRole('Super Admin'), async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM organizations WHERE id = $1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Organization not found' });
    const { name, active } = req.body;
    const updated = {
      id: existing.id,
      name: name !== undefined ? name.trim() : existing.name,
      active: active !== undefined ? !!active : existing.active
    };
    await dbRun('UPDATE organizations SET name = $1, active = $2 WHERE id = $3', [updated.name, updated.active, updated.id]);
    res.json(toOrgJSON(await dbGet('SELECT * FROM organizations WHERE id = $1', [existing.id])));
  } catch (e) { res.status(500).json({ error: 'Could not update organization: ' + e.message }); }
});

// Narrow, read-only view for the password-reset flow: name/username/role only,
// never operational data (machines, logs, etc.) - Super Admin doesn't manage those.
app.get('/api/super-admin/organizations/:id/users', requireRole('Super Admin'), async (req, res) => {
  try {
    const org = await dbGet('SELECT id FROM organizations WHERE id = $1', [req.params.id]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const rows = await dbAll('SELECT id, name, username, role FROM users WHERE organization_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json(rows.map(toUserJSON));
  } catch (e) { res.status(500).json({ error: 'Could not list users: ' + e.message }); }
});

app.post('/api/super-admin/organizations/:id/reset-password', requireRole('Super Admin'), async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) return res.status(400).json({ error: 'userId and newPassword are required' });
    const user = await dbGet('SELECT * FROM users WHERE id = $1 AND organization_id = $2', [userId, req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found in that organization' });
    await dbRun('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(newPassword, 10), userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not reset password: ' + e.message }); }
});

// Everything below this line requires the account to belong to an organization
app.use('/api', requireOrgContext);

// ================= ORGANIZATION BRANDING (own org only) =================

app.get('/api/branding', async (req, res) => {
  try {
    const org = await dbGet('SELECT * FROM organizations WHERE id = $1', [req.session.user.organizationId]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    const branded = toOrgJSON(org);
    res.json({ ...branded, companyName: branded.name });
  } catch (e) { res.status(500).json({ error: 'Could not load branding: ' + e.message }); }
});

app.put('/api/organization/branding', requireRole(...FULL_ADMIN_ROLES), async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM organizations WHERE id = $1', [req.session.user.organizationId]);
    if (!existing) return res.status(404).json({ error: 'Organization not found' });
    const {
      name, tagline, docNoLog, docEffectiveDateLog, docRevLog, docIssueLog,
      docNoExcel, docEffectiveDateExcel, docRevExcel, approvedBy, headerDisplayMode
    } = req.body;
    const validModes = ['logo_only', 'logo_name_tagline', 'logo_tagline'];
    if (headerDisplayMode !== undefined && !validModes.includes(headerDisplayMode)) {
      return res.status(400).json({ error: 'Invalid headerDisplayMode' });
    }
    const updated = {
      name: name !== undefined ? name.trim() : existing.name,
      tagline: tagline !== undefined ? tagline.trim() : existing.tagline,
      doc_no_log: docNoLog !== undefined ? docNoLog.trim() : existing.doc_no_log,
      doc_effective_date_log: docEffectiveDateLog !== undefined ? docEffectiveDateLog.trim() : existing.doc_effective_date_log,
      doc_rev_log: docRevLog !== undefined ? docRevLog.trim() : existing.doc_rev_log,
      doc_issue_log: docIssueLog !== undefined ? docIssueLog.trim() : existing.doc_issue_log,
      doc_no_excel: docNoExcel !== undefined ? docNoExcel.trim() : existing.doc_no_excel,
      doc_effective_date_excel: docEffectiveDateExcel !== undefined ? docEffectiveDateExcel.trim() : existing.doc_effective_date_excel,
      doc_rev_excel: docRevExcel !== undefined ? docRevExcel.trim() : existing.doc_rev_excel,
      approved_by: approvedBy !== undefined ? approvedBy.trim() : existing.approved_by,
      header_display_mode: headerDisplayMode !== undefined ? headerDisplayMode : existing.header_display_mode
    };
    await dbRun(`
      UPDATE organizations SET name=$1, tagline=$2, doc_no_log=$3, doc_effective_date_log=$4, doc_rev_log=$5,
        doc_issue_log=$6, doc_no_excel=$7, doc_effective_date_excel=$8, doc_rev_excel=$9, approved_by=$10, header_display_mode=$11
      WHERE id=$12
    `, [updated.name, updated.tagline, updated.doc_no_log, updated.doc_effective_date_log, updated.doc_rev_log,
        updated.doc_issue_log, updated.doc_no_excel, updated.doc_effective_date_excel, updated.doc_rev_excel, updated.approved_by, updated.header_display_mode, existing.id]);
    res.json(toOrgJSON(await dbGet('SELECT * FROM organizations WHERE id = $1', [existing.id])));
  } catch (e) { res.status(500).json({ error: 'Could not update branding: ' + e.message }); }
});

// Logo is a real uploaded file (PNG/JPEG), not a pasted URL - avoids CORS
// problems when embedding it into client-generated PDFs or server-generated
// Excel files, since it's always served from our own origin.
app.get('/api/organization/logo', async (req, res) => {
  try {
    const org = await dbGet('SELECT logo_data, logo_mime_type FROM organizations WHERE id = $1', [req.session.user.organizationId]);
    if (!org || !org.logo_data) return res.status(404).json({ error: 'No logo uploaded' });
    res.setHeader('Content-Type', org.logo_mime_type || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(org.logo_data);
  } catch (e) { res.status(500).json({ error: 'Could not load logo: ' + e.message }); }
});

app.post('/api/organization/logo', requireRole(...FULL_ADMIN_ROLES), (req, res) => {
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No logo file received' });
    try {
      const orgId = req.session.user.organizationId;
      await dbRun('UPDATE organizations SET logo_data = $1, logo_mime_type = $2 WHERE id = $3',
        [req.file.buffer, req.file.mimetype, orgId]);
      res.status(201).json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not save logo: ' + e.message }); }
  });
});

app.delete('/api/organization/logo', requireRole(...FULL_ADMIN_ROLES), async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    await dbRun('UPDATE organizations SET logo_data = NULL, logo_mime_type = NULL WHERE id = $1', [orgId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not remove logo: ' + e.message }); }
});

// ================= USER MANAGEMENT (Management only, own org) =================

app.get('/api/users', requireRole(...FULL_ADMIN_ROLES), async (req, res) => {
  try {
    const rows = await dbAll('SELECT id, name, username, role, created_at FROM users WHERE organization_id = $1 ORDER BY created_at ASC', [req.session.user.organizationId]);
    res.json(rows.map(toUserJSON));
  } catch (e) { res.status(500).json({ error: 'Could not list users: ' + e.message }); }
});

app.post('/api/users', requireRole(...FULL_ADMIN_ROLES), async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    if (!name || !username || !password || !role) return res.status(400).json({ error: 'All fields are required' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (await dbGet('SELECT id FROM users WHERE username = $1', [username.trim()])) {
      return res.status(400).json({ error: 'That username is already taken' });
    }
    const user = {
      id: genId('USR'), name: name.trim(), username: username.trim(),
      password_hash: bcrypt.hashSync(password, 10), role,
      organization_id: req.session.user.organizationId, created_at: nowISO()
    };
    await dbRun(`
      INSERT INTO users (id, name, username, password_hash, role, organization_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [user.id, user.name, user.username, user.password_hash, user.role, user.organization_id, user.created_at]);
    res.status(201).json(toUserJSON(user));
  } catch (e) { res.status(500).json({ error: 'Could not create user: ' + e.message }); }
});

app.put('/api/users/:id', requireRole(...FULL_ADMIN_ROLES), async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM users WHERE id = $1 AND organization_id = $2', [req.params.id, req.session.user.organizationId]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    const { name, role, password } = req.body;
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role && !FULL_ADMIN_ROLES.includes(role) && FULL_ADMIN_ROLES.includes(existing.role)) {
      const mgmtCount = await dbGet("SELECT COUNT(*) as c FROM users WHERE role = ANY($1) AND organization_id = $2", [FULL_ADMIN_ROLES, req.session.user.organizationId]);
      if (toInt(mgmtCount.c) <= 1) return res.status(400).json({ error: 'Cannot demote the last full-admin (Management/Maintenance HOD) account' });
    }
    const updated = {
      name: name !== undefined ? name.trim() : existing.name,
      role: role || existing.role,
      password_hash: password ? bcrypt.hashSync(password, 10) : existing.password_hash
    };
    await dbRun('UPDATE users SET name=$1, role=$2, password_hash=$3 WHERE id=$4', [updated.name, updated.role, updated.password_hash, req.params.id]);
    res.json(toUserJSON(await dbGet('SELECT * FROM users WHERE id = $1', [req.params.id])));
  } catch (e) { res.status(500).json({ error: 'Could not update user: ' + e.message }); }
});

app.delete('/api/users/:id', requireRole(...FULL_ADMIN_ROLES), async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM users WHERE id = $1 AND organization_id = $2', [req.params.id, req.session.user.organizationId]);
    if (!existing) return res.status(404).json({ error: 'User not found' });
    if (FULL_ADMIN_ROLES.includes(existing.role)) {
      const mgmtCount = await dbGet("SELECT COUNT(*) as c FROM users WHERE role = ANY($1) AND organization_id = $2", [FULL_ADMIN_ROLES, req.session.user.organizationId]);
      if (toInt(mgmtCount.c) <= 1) return res.status(400).json({ error: 'Cannot delete the last full-admin (Management/Maintenance HOD) account' });
    }
    if (req.session.user.id === req.params.id) return res.status(400).json({ error: "You can't delete your own account while logged in" });
    await dbRun('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not delete user: ' + e.message }); }
});

// ================= MACHINES (own org only) =================

app.get('/api/machines', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM machines WHERE organization_id = $1 ORDER BY created_at DESC', [req.session.user.organizationId]);
    res.json(rows.map(toMachineJSON));
  } catch (e) { res.status(500).json({ error: 'Could not list machines: ' + e.message }); }
});

// Registered before '/api/machines/:id' on purpose: Express matches routes in
// order, and ':id' would otherwise swallow this path (treating "metrics-matrix"
// as an id) before this handler is ever reached.
app.get('/api/machines/metrics-matrix', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const { fromDate, toDate } = resolvePeriod(req.query);
    const { department } = req.query;
    const machines = department
      ? await dbAll('SELECT * FROM machines WHERE organization_id = $1 AND department = $2 ORDER BY name ASC', [orgId, department])
      : await dbAll('SELECT * FROM machines WHERE organization_id = $1 ORDER BY name ASC', [orgId]);
    const rows = [];
    for (const m of machines) {
      rows.push({ machineId: m.id, machineName: m.name, machineCode: m.code, ...(await computeMachineMetrics(orgId, m.id, fromDate, toDate)) });
    }
    res.json({ fromDate, toDate, rows });
  } catch (e) { res.status(500).json({ error: 'Could not load performance matrix: ' + e.message }); }
});

app.get('/api/machines/metrics-matrix/export/excel', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const org = await dbGet('SELECT * FROM organizations WHERE id = $1', [orgId]);
    const { fromDate, toDate } = resolvePeriod(req.query);
    const { department } = req.query;
    const machines = department
      ? await dbAll('SELECT * FROM machines WHERE organization_id = $1 AND department = $2 ORDER BY name ASC', [orgId, department])
      : await dbAll('SELECT * FROM machines WHERE organization_id = $1 ORDER BY name ASC', [orgId]);
    const rows = [];
    for (const m of machines) {
      rows.push({ machineName: m.name, machineCode: m.code, ...(await computeMachineMetrics(orgId, m.id, fromDate, toDate)) });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = `${org.name} - STEELWORKS CMMS`;
    const sheet = workbook.addWorksheet('Machine Performance');

    sheet.columns = [
      { width: 26 }, { width: 22 }, { width: 14 }, { width: 22 }, { width: 14 }, { width: 20 }
    ];

    sheet.mergeCells('B1:C3');
    const brandCell = sheet.getCell('B1');
    brandCell.value = getLetterheadBrandText(org);
    brandCell.font = { bold: true, size: 14, color: { argb: 'FF0B2545' } };
    brandCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    addLetterheadLogo(workbook, sheet, org);

    sheet.mergeCells('D1:F1');
    sheet.getCell('D1').value = `Document No. ${org.doc_no_excel || 'N/A'}`;
    sheet.mergeCells('D2:F2');
    sheet.getCell('D2').value = `Effective Date: ${org.doc_effective_date_excel || 'N/A'}        Rev: ${org.doc_rev_excel || 'N/A'}`;
    sheet.mergeCells('D3:F3');
    sheet.getCell('D3').value = `Approved By: ${org.approved_by || 'N/A'}`;
    ['D1', 'D2', 'D3'].forEach(addr => {
      sheet.getCell(addr).font = { size: 10 };
      sheet.getCell(addr).alignment = { vertical: 'middle' };
      sheet.getCell(addr).border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
    });

    sheet.mergeCells('A5:F5');
    const titleCell = sheet.getCell('A5');
    titleCell.value = 'MACHINE PERFORMANCE REPORT';
    titleCell.font = { bold: true, size: 14, color: { argb: 'FF0B2545' } };
    titleCell.alignment = { horizontal: 'center' };

    sheet.mergeCells('A6:F6');
    const periodCell = sheet.getCell('A6');
    periodCell.value = `PERIOD: ${fmtDateForExcel(fromDate)} to ${fmtDateForExcel(toDate)}${department ? '  |  DEPARTMENT: ' + department.toUpperCase() : ''}`;
    periodCell.font = { bold: true, size: 11 };

    const headerRowNum = 8;
    const headers = ['MACHINE', 'CUMULATIVE DOWNTIME (HR)', '# FAILURES', 'MTTR (HR)', 'MTBF (HR)', 'OPERATING TIME (HR)'];
    const headerRow = sheet.getRow(headerRowNum);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
    headerRow.height = 30;

    let r = headerRowNum + 1;
    rows.forEach(row => {
      const dataRow = sheet.getRow(r);
      const values = [
        `${row.machineName} (${row.machineCode})`,
        row.cumulativeDowntimeHours,
        row.numberOfFailures,
        row.mttr !== null ? row.mttr : 'N/A',
        row.mtbf !== null ? row.mtbf : 'N/A',
        row.operatingTimeHours
      ];
      values.forEach((v, i) => {
        const cell = dataRow.getCell(i + 1);
        cell.value = v;
        cell.alignment = { vertical: 'top' };
        cell.border = { top: { style: 'thin', color: { argb: 'FFE2E5EA' } }, bottom: { style: 'thin', color: { argb: 'FFE2E5EA' } }, left: { style: 'thin', color: { argb: 'FFE2E5EA' } }, right: { style: 'thin', color: { argb: 'FFE2E5EA' } } };
      });
      r++;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="machine-performance-${fromDate}_to_${toDate}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Could not export: ' + e.message }); }
});

app.get('/api/machines/:id', async (req, res) => {
  try {
    const m = await dbGet('SELECT * FROM machines WHERE id = $1 AND organization_id = $2', [req.params.id, req.session.user.organizationId]);
    if (!m) return res.status(404).json({ error: 'Machine not found' });
    const logs = (await dbAll('SELECT * FROM logs WHERE machine_id = $1 ORDER BY logged_at DESC', [req.params.id])).map(toLogJSON);
    await attachAttachmentsToLogs(logs);
    res.json({ ...toMachineJSON(m), logs });
  } catch (e) { res.status(500).json({ error: 'Could not load machine: ' + e.message }); }
});

app.post('/api/machines', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const { name, code, department, location, status, photoUrl, nextPmDate } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
    const m = {
      id: genId('MC'), name: name.trim(), code: code.trim(),
      department: (department || '').trim(), location: (location || '').trim(),
      status: status || 'Running', photo_url: (photoUrl || '').trim(),
      next_pm_date: nextPmDate || null, organization_id: req.session.user.organizationId, created_at: nowISO()
    };
    await dbRun(`
      INSERT INTO machines (id, name, code, department, location, status, photo_url, next_pm_date, organization_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [m.id, m.name, m.code, m.department, m.location, m.status, m.photo_url, m.next_pm_date, m.organization_id, m.created_at]);
    res.status(201).json(toMachineJSON(m));
  } catch (e) { res.status(500).json({ error: 'Could not create machine: ' + e.message }); }
});

app.put('/api/machines/:id', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM machines WHERE id = $1 AND organization_id = $2', [req.params.id, req.session.user.organizationId]);
    if (!existing) return res.status(404).json({ error: 'Machine not found' });
    const { name, code, department, location, status, photoUrl, nextPmDate } = req.body;
    const updated = {
      name: (name || existing.name).trim(),
      code: (code || existing.code).trim(),
      department: department !== undefined ? department.trim() : existing.department,
      location: location !== undefined ? location.trim() : existing.location,
      status: status || existing.status,
      photo_url: photoUrl !== undefined ? photoUrl.trim() : existing.photo_url,
      next_pm_date: nextPmDate !== undefined ? (nextPmDate || null) : existing.next_pm_date
    };
    await dbRun(`
      UPDATE machines SET name=$1, code=$2, department=$3, location=$4, status=$5, photo_url=$6, next_pm_date=$7 WHERE id=$8
    `, [updated.name, updated.code, updated.department, updated.location, updated.status, updated.photo_url, updated.next_pm_date, req.params.id]);
    res.json(toMachineJSON(await dbGet('SELECT * FROM machines WHERE id = $1', [req.params.id])));
  } catch (e) { res.status(500).json({ error: 'Could not update machine: ' + e.message }); }
});

// ================= MACHINE METRICS ENDPOINTS =================

app.get('/api/machines/:id/metrics', async (req, res) => {
  try {
    const m = await dbGet('SELECT * FROM machines WHERE id = $1 AND organization_id = $2', [req.params.id, req.session.user.organizationId]);
    if (!m) return res.status(404).json({ error: 'Machine not found' });
    const fromDate = m.created_at.slice(0, 10);
    const toDate = todayISO();
    res.json(await computeMachineMetrics(req.session.user.organizationId, req.params.id, fromDate, toDate));
  } catch (e) { res.status(500).json({ error: 'Could not load metrics: ' + e.message }); }
});

// ================= OPERATING SCHEDULE (Supervisor/Management only, own org) =================

app.get('/api/settings', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    res.json({ defaultOperatingHours: await getDefaultOperatingHours(req.session.user.organizationId) });
  } catch (e) { res.status(500).json({ error: 'Could not load settings: ' + e.message }); }
});

app.put('/api/settings', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const hours = parseFloat(req.body.defaultOperatingHours);
    if (isNaN(hours) || hours < 0 || hours > 24) return res.status(400).json({ error: 'defaultOperatingHours must be between 0 and 24' });
    await dbRun(`
      INSERT INTO settings (organization_id, key, value) VALUES ($1, 'default_operating_hours', $2)
      ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value
    `, [req.session.user.organizationId, hours.toString()]);
    res.json({ defaultOperatingHours: hours });
  } catch (e) { res.status(500).json({ error: 'Could not save settings: ' + e.message }); }
});

app.get('/api/schedule-overrides', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const orgId = req.session.user.organizationId;
    const rows = (from && to)
      ? await dbAll('SELECT * FROM schedule_overrides WHERE organization_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date DESC', [orgId, from, to])
      : await dbAll('SELECT * FROM schedule_overrides WHERE organization_id = $1 ORDER BY date DESC LIMIT 100', [orgId]);
    res.json(rows.map(r => ({ date: r.date, hours: r.hours, note: r.note, updatedBy: r.updated_by, updatedAt: r.updated_at })));
  } catch (e) { res.status(500).json({ error: 'Could not load overrides: ' + e.message }); }
});

app.post('/api/schedule-overrides', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const { date, hours, note } = req.body;
    if (!date || hours === undefined || hours === null) return res.status(400).json({ error: 'date and hours are required' });
    const h = parseFloat(hours);
    if (isNaN(h) || h < 0 || h > 24) return res.status(400).json({ error: 'hours must be between 0 and 24' });
    const row = {
      organization_id: req.session.user.organizationId,
      date, hours: h, note: (note || '').trim(),
      updated_by: req.session.user.name, updated_at: nowISO()
    };
    await dbRun(`
      INSERT INTO schedule_overrides (organization_id, date, hours, note, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (organization_id, date) DO UPDATE SET hours=EXCLUDED.hours, note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at
    `, [row.organization_id, row.date, row.hours, row.note, row.updated_by, row.updated_at]);
    res.status(201).json({ date: row.date, hours: row.hours, note: row.note, updatedBy: row.updated_by, updatedAt: row.updated_at });
  } catch (e) { res.status(500).json({ error: 'Could not save override: ' + e.message }); }
});

app.delete('/api/schedule-overrides/:date', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    await dbRun('DELETE FROM schedule_overrides WHERE date = $1 AND organization_id = $2', [req.params.date, req.session.user.organizationId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not delete override: ' + e.message }); }
});

// ================= LOGS (own org only) =================

app.get('/api/logs', async (req, res) => {
  try {
    const { machineId, logType, status } = req.query;
    let sql = `
      SELECT l.*, m.name as machine_name, m.code as machine_code, m.department as machine_department, m.location as machine_location
      FROM logs l JOIN machines m ON m.id = l.machine_id WHERE l.organization_id = $1
    `;
    const params = [req.session.user.organizationId];
    if (machineId) { params.push(machineId); sql += ` AND l.machine_id = $${params.length}`; }
    if (logType) { params.push(logType); sql += ` AND l.log_type = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND l.status = $${params.length}`; }
    sql += ' ORDER BY l.logged_at DESC';
    const rows = (await dbAll(sql, params)).map(toLogJSON);
    await attachAttachmentsToLogs(rows);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Could not load logs: ' + e.message }); }
});

// Any logged-in role (Technician included) can submit a log
app.post('/api/logs', async (req, res) => {
  try {
    const {
      machineId, logType, reportedBy, priority, technician,
      downtimeHours, findings, actionsTaken, partsUsed, status, loggedAt
    } = req.body;

    if (!machineId || !logType || !technician || !findings || !actionsTaken || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['Preventive', 'Breakdown'].includes(logType)) {
      return res.status(400).json({ error: 'logType must be Preventive or Breakdown' });
    }
    if (!['Pending', 'Completed'].includes(status)) {
      return res.status(400).json({ error: 'status must be Pending or Completed' });
    }
    let loggedAtFinal = nowISO();
    if (loggedAt) {
      const parsed = new Date(loggedAt);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid date of maintenance' });
      loggedAtFinal = parsed.toISOString();
    }
    const orgId = req.session.user.organizationId;
    const machine = await dbGet('SELECT * FROM machines WHERE id = $1 AND organization_id = $2', [machineId, orgId]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });

    const log = {
      id: genId('LOG'), machine_id: machineId, organization_id: orgId, log_type: logType,
      reported_by: (reportedBy || '').trim(), priority: priority || null, technician: technician.trim(),
      downtime_hours: parseFloat(downtimeHours) || 0, findings: findings.trim(), actions_taken: actionsTaken.trim(),
      parts_used: (partsUsed || '').trim(), status, logged_at: loggedAtFinal
    };

    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO logs (id, machine_id, organization_id, log_type, reported_by, priority, technician, downtime_hours, findings, actions_taken, parts_used, status, logged_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `, [log.id, log.machine_id, log.organization_id, log.log_type, log.reported_by, log.priority, log.technician, log.downtime_hours, log.findings, log.actions_taken, log.parts_used, log.status, log.logged_at]);

      if (logType === 'Breakdown') {
        const newStatus = status === 'Completed' ? 'Running' : 'Down';
        await client.query('UPDATE machines SET status = $1 WHERE id = $2', [newStatus, machineId]);
      } else if (logType === 'Preventive' && status === 'Completed') {
        const nextPm = addDays(todayISO(), 30);
        await client.query('UPDATE machines SET status = $1, next_pm_date = $2 WHERE id = $3', ['Running', nextPm, machineId]);
      }
    });

    res.status(201).json(toLogJSON({ ...log, machine_name: machine.name, machine_code: machine.code, machine_department: machine.department, machine_location: machine.location }));
  } catch (e) { res.status(500).json({ error: 'Could not create log: ' + e.message }); }
});

// Correct a log's content after submission. Supervisor/Management only.
// Does NOT allow editing logged_at (the timestamp) - kept out to avoid
// timezone-conversion bugs in a form; use a direct DB correction for that.
// Does NOT allow setting status to 'Reviewed' - that stays exclusive to the
// dedicated review endpoint below, so the review audit trail (who/when)
// can't be bypassed by just editing a dropdown. If a log is already
// Reviewed, its status is left untouched regardless of what's submitted here.
app.put('/api/logs/:id', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const existing = await dbGet('SELECT * FROM logs WHERE id = $1 AND organization_id = $2', [req.params.id, orgId]);
    if (!existing) return res.status(404).json({ error: 'Log not found' });

    const { machineId, logType, reportedBy, priority, technician, downtimeHours, findings, actionsTaken, partsUsed, status, loggedAt } = req.body;

    let machineIdFinal = existing.machine_id;
    if (machineId && machineId !== existing.machine_id) {
      const machine = await dbGet('SELECT id FROM machines WHERE id = $1 AND organization_id = $2', [machineId, orgId]);
      if (!machine) return res.status(404).json({ error: 'Machine not found' });
      machineIdFinal = machineId;
    }
    if (logType && !['Preventive', 'Breakdown'].includes(logType)) {
      return res.status(400).json({ error: 'logType must be Preventive or Breakdown' });
    }
    if (status !== undefined && !['Pending', 'Completed'].includes(status)) {
      return res.status(400).json({ error: "status can only be set to Pending or Completed here - use the Review action to mark a log Reviewed" });
    }
    let loggedAtFinal = existing.logged_at;
    if (loggedAt) {
      const parsed = new Date(loggedAt);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid date of maintenance' });
      loggedAtFinal = parsed.toISOString();
    }

    const updated = {
      machine_id: machineIdFinal,
      log_type: logType || existing.log_type,
      reported_by: reportedBy !== undefined ? reportedBy.trim() : existing.reported_by,
      priority: priority !== undefined ? (priority || null) : existing.priority,
      technician: technician !== undefined ? technician.trim() : existing.technician,
      downtime_hours: downtimeHours !== undefined ? (parseFloat(downtimeHours) || 0) : existing.downtime_hours,
      findings: findings !== undefined ? findings.trim() : existing.findings,
      actions_taken: actionsTaken !== undefined ? actionsTaken.trim() : existing.actions_taken,
      parts_used: partsUsed !== undefined ? partsUsed.trim() : existing.parts_used,
      status: (status !== undefined && existing.status !== 'Reviewed') ? status : existing.status,
      logged_at: loggedAtFinal
    };

    await dbRun(`
      UPDATE logs SET machine_id=$1, log_type=$2, reported_by=$3, priority=$4, technician=$5,
        downtime_hours=$6, findings=$7, actions_taken=$8, parts_used=$9, status=$10, logged_at=$11
      WHERE id=$12
    `, [updated.machine_id, updated.log_type, updated.reported_by, updated.priority, updated.technician,
        updated.downtime_hours, updated.findings, updated.actions_taken, updated.parts_used, updated.status, updated.logged_at, req.params.id]);

    const result = await dbGet(`
      SELECT l.*, m.name as machine_name, m.code as machine_code, m.department as machine_department, m.location as machine_location
      FROM logs l JOIN machines m ON m.id = l.machine_id WHERE l.id = $1
    `, [req.params.id]);
    res.json(toLogJSON(result));
  } catch (e) { res.status(500).json({ error: 'Could not update log: ' + e.message }); }
});

// Supervisor/Management marks a Completed log as Reviewed (third status, terminal)
app.patch('/api/logs/:id/review', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const log = await dbGet('SELECT * FROM logs WHERE id = $1 AND organization_id = $2', [req.params.id, orgId]);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    if (log.status !== 'Completed') {
      return res.status(400).json({ error: 'Only logs with status Completed can be reviewed' });
    }
    const reviewedAt = nowISO();
    await dbRun('UPDATE logs SET status = $1, reviewed_by = $2, reviewed_at = $3, reviewed_by_role = $4 WHERE id = $5',
      ['Reviewed', req.session.user.name, reviewedAt, req.session.user.role, req.params.id]);
    const updated = await dbGet(`
      SELECT l.*, m.name as machine_name, m.code as machine_code, m.department as machine_department, m.location as machine_location
      FROM logs l JOIN machines m ON m.id = l.machine_id WHERE l.id = $1
    `, [req.params.id]);
    res.json(toLogJSON(updated));
  } catch (e) { res.status(500).json({ error: 'Could not review log: ' + e.message }); }
});

// ================= ATTACHMENTS (scoped via parent log's org) =================

app.post('/api/logs/:id/attachments', async (req, res) => {
  try {
    const log = await dbGet('SELECT id FROM logs WHERE id = $1 AND organization_id = $2', [req.params.id, req.session.user.organizationId]);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    upload.array('files', 5)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      const files = req.files || [];
      if (files.length === 0) return res.status(400).json({ error: 'No files received' });
      try {
        const created = [];
        for (const f of files) {
          const row = {
            id: genId('ATT'), log_id: req.params.id, filename: f.filename, original_name: f.originalname,
            mime_type: f.mimetype, size_bytes: f.size, uploaded_by: req.session.user.name, uploaded_at: nowISO()
          };
          await dbRun(`
            INSERT INTO attachments (id, log_id, filename, original_name, mime_type, size_bytes, uploaded_by, uploaded_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `, [row.id, row.log_id, row.filename, row.original_name, row.mime_type, row.size_bytes, row.uploaded_by, row.uploaded_at]);
          created.push(toAttachmentJSON(row));
        }
        res.status(201).json(created);
      } catch (dbErr) { res.status(500).json({ error: 'Could not save attachment: ' + dbErr.message }); }
    });
  } catch (e) { res.status(500).json({ error: 'Could not upload attachment: ' + e.message }); }
});

app.get('/api/logs/:id/attachments', async (req, res) => {
  try {
    const log = await dbGet('SELECT id FROM logs WHERE id = $1 AND organization_id = $2', [req.params.id, req.session.user.organizationId]);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    const rows = await dbAll('SELECT * FROM attachments WHERE log_id = $1 ORDER BY uploaded_at ASC', [req.params.id]);
    res.json(rows.map(toAttachmentJSON));
  } catch (e) { res.status(500).json({ error: 'Could not list attachments: ' + e.message }); }
});

app.get('/api/attachments/:id/file', async (req, res) => {
  try {
    const a = await dbGet(`
      SELECT att.* FROM attachments att JOIN logs l ON l.id = att.log_id
      WHERE att.id = $1 AND l.organization_id = $2
    `, [req.params.id, req.session.user.organizationId]);
    if (!a) return res.status(404).json({ error: 'Attachment not found' });
    const filePath = path.join(uploadsDir, a.log_id, a.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', a.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${a.original_name.replace(/"/g, '')}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { res.status(500).json({ error: 'Could not load attachment: ' + e.message }); }
});

app.delete('/api/attachments/:id', requireRole('Maintenance Supervisor', 'Management', 'Maintenance HOD'), async (req, res) => {
  try {
    const a = await dbGet(`
      SELECT att.* FROM attachments att JOIN logs l ON l.id = att.log_id
      WHERE att.id = $1 AND l.organization_id = $2
    `, [req.params.id, req.session.user.organizationId]);
    if (!a) return res.status(404).json({ error: 'Attachment not found' });
    const filePath = path.join(uploadsDir, a.log_id, a.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await dbRun('DELETE FROM attachments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not delete attachment: ' + e.message }); }
});

// ================= DASHBOARD (own org only) =================

app.get('/api/dashboard', async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const today = todayISO();
    const weekAhead = addDays(today, 7);
    const weekAgoStart = addDays(today, -6) + 'T00:00:00.000Z';
    const monthPrefix = today.slice(0, 7);

    const pmDueSoonRow = await dbGet(`
      SELECT COUNT(*) as c FROM machines
      WHERE organization_id = $1 AND next_pm_date IS NOT NULL AND next_pm_date != '' AND next_pm_date BETWEEN $2 AND $3
    `, [orgId, today, weekAhead]);

    const totalMachinesRow = await dbGet('SELECT COUNT(*) as c FROM machines WHERE organization_id = $1', [orgId]);
    const machinesDownRow = await dbGet("SELECT COUNT(*) as c FROM machines WHERE organization_id = $1 AND status = 'Down'", [orgId]);
    const logsThisMonthRow = await dbGet('SELECT COUNT(*) as c FROM logs WHERE organization_id = $1 AND LEFT(logged_at,7) = $2', [orgId, monthPrefix]);
    const pendingLogsRow = await dbGet("SELECT COUNT(*) as c FROM logs WHERE organization_id = $1 AND status = 'Pending'", [orgId]);
    const awaitingReviewRow = await dbGet("SELECT COUNT(*) as c FROM logs WHERE organization_id = $1 AND status = 'Completed'", [orgId]);

    const trendRows = await dbAll(`
      SELECT LEFT(logged_at,10) as day, log_type, COUNT(*) as cnt
      FROM logs WHERE organization_id = $1 AND logged_at >= $2 GROUP BY day, log_type
    `, [orgId, weekAgoStart]);

    const weeklyTrends = [];
    for (let i = 6; i >= 0; i--) {
      const day = addDays(today, -i);
      const pv = trendRows.find(r => r.day === day && r.log_type === 'Preventive');
      const bd = trendRows.find(r => r.day === day && r.log_type === 'Breakdown');
      weeklyTrends.push({ day, preventive: pv ? toInt(pv.cnt) : 0, breakdown: bd ? toInt(bd.cnt) : 0 });
    }

    const compliance = await dbGet(`
      SELECT
        SUM(CASE WHEN next_pm_date IS NOT NULL AND next_pm_date != '' AND next_pm_date < $1 THEN 1 ELSE 0 END) as overdue,
        SUM(CASE WHEN next_pm_date IS NOT NULL AND next_pm_date != '' AND next_pm_date >= $1 THEN 1 ELSE 0 END) as onschedule
      FROM machines WHERE organization_id = $2
    `, [today, orgId]);

    const recentLogs = (await dbAll(`
      SELECT l.*, m.name as machine_name, m.code as machine_code, m.department as machine_department, m.location as machine_location
      FROM logs l JOIN machines m ON m.id = l.machine_id
      WHERE l.organization_id = $1
      ORDER BY l.logged_at DESC LIMIT 5
    `, [orgId])).map(toLogJSON);

    const machinesAttention = (await dbAll(`
      SELECT * FROM machines
      WHERE organization_id = $1 AND (status != 'Running' OR (next_pm_date IS NOT NULL AND next_pm_date != '' AND next_pm_date < $2))
      ORDER BY (status != 'Running') DESC, next_pm_date ASC
      LIMIT 6
    `, [orgId, today])).map(toMachineJSON);

    res.json({
      pmDueSoon: toInt(pmDueSoonRow.c),
      totalMachines: toInt(totalMachinesRow.c),
      machinesDown: toInt(machinesDownRow.c),
      logsThisMonth: toInt(logsThisMonthRow.c),
      pendingLogs: toInt(pendingLogsRow.c),
      awaitingReview: toInt(awaitingReviewRow.c),
      weeklyTrends,
      pmCompliance: { onSchedule: toInt(compliance.onschedule), overdue: toInt(compliance.overdue) },
      recentLogs,
      machinesAttention
    });
  } catch (e) { res.status(500).json({ error: 'Could not load dashboard: ' + e.message }); }
});

// ================= REPORTS (own org only) =================

app.get('/api/reports/daily', async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const date = req.query.date || todayISO();
    const logs = (await dbAll(`
      SELECT l.*, m.name as machine_name, m.code as machine_code, m.department as machine_department, m.location as machine_location
      FROM logs l JOIN machines m ON m.id = l.machine_id
      WHERE l.organization_id = $1 AND LEFT(l.logged_at,10) = $2 ORDER BY l.logged_at DESC
    `, [orgId, date])).map(toLogJSON);
    await attachAttachmentsToLogs(logs);
    const preventiveCount = logs.filter(l => l.logType === 'Preventive').length;
    const breakdownCount = logs.filter(l => l.logType === 'Breakdown').length;
    const totalDowntime = logs.reduce((sum, l) => sum + (l.downtimeHours || 0), 0);
    res.json({ date, totalLogs: logs.length, preventiveCount, breakdownCount, totalDowntime, logs });
  } catch (e) { res.status(500).json({ error: 'Could not load daily report: ' + e.message }); }
});

app.get('/api/reports/monthly', async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const year = req.query.year || todayISO().slice(0, 4);
    const month = (req.query.month || (new Date().getMonth() + 1)).toString().padStart(2, '0');
    const prefix = `${year}-${month}`;
    const rows = await dbAll(`
      SELECT LEFT(logged_at,10) as day, log_type, COUNT(*) as cnt, SUM(downtime_hours) as hrs
      FROM logs WHERE organization_id = $1 AND LEFT(logged_at,7) = $2 GROUP BY day, log_type
    `, [orgId, prefix]);

    const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
    const dailyBreakdown = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const day = `${prefix}-${d.toString().padStart(2, '0')}`;
      const pv = rows.find(r => r.day === day && r.log_type === 'Preventive');
      const bd = rows.find(r => r.day === day && r.log_type === 'Breakdown');
      dailyBreakdown.push({ day, preventive: pv ? toInt(pv.cnt) : 0, breakdown: bd ? toInt(bd.cnt) : 0 });
    }
    const totalLogs = rows.reduce((s, r) => s + toInt(r.cnt), 0);
    const totalDowntime = rows.reduce((s, r) => s + (r.hrs || 0), 0);
    const preventiveCount = rows.filter(r => r.log_type === 'Preventive').reduce((s, r) => s + toInt(r.cnt), 0);
    const breakdownCount = rows.filter(r => r.log_type === 'Breakdown').reduce((s, r) => s + toInt(r.cnt), 0);

    res.json({ year, month, dailyBreakdown, totalLogs, totalDowntime, preventiveCount, breakdownCount });
  } catch (e) { res.status(500).json({ error: 'Could not load monthly report: ' + e.message }); }
});

app.get('/api/reports/yearly', async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const year = req.query.year || todayISO().slice(0, 4);
    const rows = await dbAll(`
      SELECT SUBSTRING(logged_at FROM 6 FOR 2) as mo, log_type, COUNT(*) as cnt, SUM(downtime_hours) as hrs
      FROM logs WHERE organization_id = $1 AND LEFT(logged_at,4) = $2 GROUP BY mo, log_type
    `, [orgId, year]);

    const monthlyBreakdown = [];
    for (let m = 1; m <= 12; m++) {
      const mo = m.toString().padStart(2, '0');
      const pv = rows.find(r => r.mo === mo && r.log_type === 'Preventive');
      const bd = rows.find(r => r.mo === mo && r.log_type === 'Breakdown');
      monthlyBreakdown.push({ month: mo, preventive: pv ? toInt(pv.cnt) : 0, breakdown: bd ? toInt(bd.cnt) : 0 });
    }
    const totalLogs = rows.reduce((s, r) => s + toInt(r.cnt), 0);
    const totalDowntime = rows.reduce((s, r) => s + (r.hrs || 0), 0);
    const preventiveCount = rows.filter(r => r.log_type === 'Preventive').reduce((s, r) => s + toInt(r.cnt), 0);
    const breakdownCount = rows.filter(r => r.log_type === 'Breakdown').reduce((s, r) => s + toInt(r.cnt), 0);

    res.json({ year, monthlyBreakdown, totalLogs, totalDowntime, preventiveCount, breakdownCount });
  } catch (e) { res.status(500).json({ error: 'Could not load yearly report: ' + e.message }); }
});

// ================= EXCEL EXPORT (own org only) =================

app.get('/api/logs/export/excel', async (req, res) => {
  try {
    const orgId = req.session.user.organizationId;
    const org = await dbGet('SELECT * FROM organizations WHERE id = $1', [orgId]);
    const { month, from, to } = req.query;
    let whereClause = 'WHERE l.organization_id = $1';
    let params = [orgId];
    let periodLabel = '';

    if (month) {
      params.push(month);
      whereClause += ` AND LEFT(l.logged_at,7) = $${params.length}`;
      const [y, m] = month.split('-');
      const monthNames = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
      periodLabel = `${monthNames[parseInt(m) - 1]}, ${y}`;
    } else if (from && to) {
      params.push(from, to);
      whereClause += ` AND LEFT(l.logged_at,10) BETWEEN $${params.length - 1} AND $${params.length}`;
      periodLabel = `${fmtDateForExcel(from)} to ${fmtDateForExcel(to)}`;
    } else {
      return res.status(400).json({ error: 'Provide either ?month=YYYY-MM or ?from=YYYY-MM-DD&to=YYYY-MM-DD' });
    }

    const rows = await dbAll(`
      SELECT l.*, m.name as machine_name, m.code as machine_code, m.department as machine_department
      FROM logs l JOIN machines m ON m.id = l.machine_id
      ${whereClause}
      ORDER BY l.logged_at ASC
    `, params);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = `${org.name} - STEELWORKS CMMS`;
    const sheet = workbook.addWorksheet('Maintenance Logs');

    sheet.columns = [
      { width: 12 }, { width: 26 }, { width: 10 }, { width: 10 }, { width: 12 },
      { width: 14 }, { width: 42 }, { width: 16 }, { width: 18 }, { width: 12 }
    ];

    sheet.mergeCells('B1:D3');
    const brandCell = sheet.getCell('B1');
    brandCell.value = getLetterheadBrandText(org);
    brandCell.font = { bold: true, size: 14, color: { argb: 'FF0B2545' } };
    brandCell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    addLetterheadLogo(workbook, sheet, org);

    sheet.mergeCells('E1:J1');
    sheet.getCell('E1').value = `Document No. ${org.doc_no_excel || 'N/A'}`;
    sheet.mergeCells('E2:J2');
    sheet.getCell('E2').value = `Effective Date: ${org.doc_effective_date_excel || 'N/A'}        Rev: ${org.doc_rev_excel || 'N/A'}`;
    sheet.mergeCells('E3:J3');
    sheet.getCell('E3').value = `Approved By: ${org.approved_by || 'N/A'}`;
    ['E1', 'E2', 'E3'].forEach(addr => {
      sheet.getCell(addr).font = { size: 10 };
      sheet.getCell(addr).alignment = { vertical: 'middle' };
      sheet.getCell(addr).border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
    });

    sheet.mergeCells('A5:J5');
    const titleCell = sheet.getCell('A5');
    titleCell.value = 'MAINTENANCE LOGS';
    titleCell.font = { bold: true, size: 14, color: { argb: 'FF0B2545' } };
    titleCell.alignment = { horizontal: 'center' };

    sheet.mergeCells('A6:J6');
    const periodCell = sheet.getCell('A6');
    periodCell.value = `PERIOD: ${periodLabel}`;
    periodCell.font = { bold: true, size: 11 };

    const headerRowNum = 8;
    const headers = ['DATE', 'MACHINE', 'START TIME', 'END TIME', 'DOWN TIME (HR)', 'DEPARTMENT', 'DESCRIPTION OF MAINTENANCE', 'SPARES CHANGED', 'PERFORMED BY', 'REMARKS'];
    const headerRow = sheet.getRow(headerRowNum);
    headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2545' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    });
    headerRow.height = 30;

    let r = headerRowNum + 1;
    rows.forEach(row => {
      const l = toLogJSON(row);
      const endDate = new Date(l.loggedAt);
      const startDate = new Date(endDate.getTime() - (l.downtimeHours || 0) * 3600000);
      const remarksMap = { Pending: 'In Progress', Completed: 'Done', Reviewed: 'Done (Reviewed)' };
      const dataRow = sheet.getRow(r);
      const values = [
        new Date(l.loggedAt.slice(0, 10)),
        `${l.machineName}${row.machine_code ? ' (' + row.machine_code + ')' : ''}`,
        startDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
        endDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
        l.downtimeHours,
        row.machine_department || '',
        l.actionsTaken || l.findings || '',
        l.partsUsed || 'NIL',
        l.technician,
        remarksMap[l.status] || l.status
      ];
      values.forEach((v, i) => {
        const cell = dataRow.getCell(i + 1);
        cell.value = v;
        cell.alignment = { vertical: 'top', wrapText: i === 6 };
        cell.border = { top: { style: 'thin', color: { argb: 'FFE2E5EA' } }, bottom: { style: 'thin', color: { argb: 'FFE2E5EA' } }, left: { style: 'thin', color: { argb: 'FFE2E5EA' } }, right: { style: 'thin', color: { argb: 'FFE2E5EA' } } };
      });
      dataRow.getCell(1).numFmt = 'd/m/yyyy';
      r++;
    });

    const filenameSuffix = month ? month : `${from}_to_${to}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="maintenance-logs-${filenameSuffix}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: 'Could not export: ' + e.message }); }
});

// ================= helpers =================

function toMachineJSON(row) {
  return {
    id: row.id, name: row.name, code: row.code, department: row.department,
    location: row.location, status: row.status, photoUrl: row.photo_url,
    nextPmDate: row.next_pm_date, createdAt: row.created_at
  };
}
function toLogJSON(row) {
  return {
    id: row.id, machineId: row.machine_id, machineName: row.machine_name, machineCode: row.machine_code,
    machineDepartment: row.machine_department, machineLocation: row.machine_location,
    logType: row.log_type, reportedBy: row.reported_by, priority: row.priority, technician: row.technician,
    downtimeHours: row.downtime_hours, findings: row.findings, actionsTaken: row.actions_taken,
    partsUsed: row.parts_used, status: row.status, loggedAt: row.logged_at,
    reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, reviewedByRole: row.reviewed_by_role
  };
}
function toUserJSON(row) {
  return { id: row.id, name: row.name, username: row.username, role: row.role, createdAt: row.created_at };
}
function toAttachmentJSON(row) {
  return {
    id: row.id, logId: row.log_id, originalName: row.original_name,
    mimeType: row.mime_type, sizeBytes: row.size_bytes,
    uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at,
    url: `/api/attachments/${row.id}/file`
  };
}
function toOrgJSON(row) {
  return {
    id: row.id, name: row.name, orgCode: row.org_code, tagline: row.tagline,
    active: row.active === undefined || row.active === null ? true : !!row.active,
    hasLogo: !!row.logo_data,
    logoUrl: row.logo_data ? '/api/organization/logo' : null,
    headerDisplayMode: row.header_display_mode || 'logo_name_tagline',
    docNoLog: row.doc_no_log, docEffectiveDateLog: row.doc_effective_date_log, docRevLog: row.doc_rev_log, docIssueLog: row.doc_issue_log,
    docNoExcel: row.doc_no_excel, docEffectiveDateExcel: row.doc_effective_date_excel, docRevExcel: row.doc_rev_excel,
    approvedBy: row.approved_by, createdAt: row.created_at
  };
}
async function attachAttachmentsToLogs(logs) {
  if (logs.length === 0) return;
  const ids = logs.map(l => l.id);
  const rows = await dbAll('SELECT * FROM attachments WHERE log_id = ANY($1) ORDER BY uploaded_at ASC', [ids]);
  const byLog = {};
  rows.forEach(r => {
    if (!byLog[r.log_id]) byLog[r.log_id] = [];
    byLog[r.log_id].push(toAttachmentJSON(r));
  });
  logs.forEach(l => { l.attachments = byLog[l.id] || []; });
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= STARTUP =================
// Schema + bootstrap must complete before the server starts accepting requests,
// since they're now async (unlike the old synchronous better-sqlite3 version
// that could do this at plain module-load time).
async function start() {
  await db.ensureSchema();
  await bootstrapDefaultOrganization();
  await bootstrapOrgAdmin();
  await bootstrapSuperAdmin();
  app.listen(PORT, () => {
    console.log(`STEELWORKS CMMS running at http://localhost:${PORT}`);
  });
}
start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
