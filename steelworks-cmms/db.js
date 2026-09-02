const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Set it to your Postgres connection string before starting the server.');
}

// SSL is OFF by default because Render's *internal* database URL (same private
// network as the app) typically doesn't need or support it. If you switch to
// an *external* connection string (e.g. for local development against a
// remote Postgres), set PGSSL=true.
const useSSL = process.env.PGSSL === 'true' || process.env.PGSSL === '1';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

// Fresh schema only - no migration from the old SQLite version. organization_id
// is a normal column from the start on every relevant table.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_code TEXT NOT NULL UNIQUE,
      tagline TEXT,
      logo_url TEXT,
      logo_mime_type TEXT,
      doc_no_log TEXT,
      doc_effective_date_log TEXT,
      doc_rev_log TEXT,
      doc_issue_log TEXT,
      doc_no_excel TEXT,
      doc_effective_date_excel TEXT,
      doc_rev_excel TEXT,
      approved_by TEXT,
      header_display_mode TEXT NOT NULL DEFAULT 'logo_name_tagline',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      organization_id TEXT REFERENCES organizations(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      department TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'Running',
      photo_url TEXT,
      next_pm_date TEXT,
      organization_id TEXT REFERENCES organizations(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      organization_id TEXT,
      log_type TEXT NOT NULL,
      reported_by TEXT,
      priority TEXT,
      technician TEXT NOT NULL,
      downtime_hours REAL NOT NULL DEFAULT 0,
      findings TEXT NOT NULL,
      actions_taken TEXT NOT NULL,
      parts_used TEXT,
      status TEXT NOT NULL DEFAULT 'Pending',
      logged_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT,
      reviewed_by_role TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_machine ON logs(machine_id);
    CREATE INDEX IF NOT EXISTS idx_logs_logged_at ON logs(logged_at);
    CREATE INDEX IF NOT EXISTS idx_logs_org ON logs(organization_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      log_id TEXT NOT NULL REFERENCES logs(id),
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_by TEXT,
      uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_log ON attachments(log_id);

    CREATE TABLE IF NOT EXISTS settings (
      organization_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (organization_id, key)
    );

    CREATE TABLE IF NOT EXISTS schedule_overrides (
      organization_id TEXT NOT NULL,
      date TEXT NOT NULL,
      hours REAL NOT NULL,
      note TEXT,
      updated_by TEXT,
      updated_at TEXT,
      PRIMARY KEY (organization_id, date)
    );
  `);

  // Postgres-native idempotent column migrations. This database stopped being
  // "always fresh" the moment real data got imported - from here on, new
  // columns need ADD COLUMN IF NOT EXISTS, the same way the old SQLite
  // version self-healed, or they'll silently never apply to the live table.
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS header_display_mode TEXT NOT NULL DEFAULT 'logo_name_tagline';`);
}

module.exports = { pool, ensureSchema };
