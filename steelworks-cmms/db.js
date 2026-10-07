const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set. Set it to your Postgres connection string before starting the server.');
}

// SSL is OFF by default because Render's *internal* database URL (same private
// network as the app) typically doesn't need or support it. Neon (and most
// external Postgres providers) always require SSL - rather than relying on
// remembering to set PGSSL=true during a provider migration, this also
// auto-detects it from the connection string itself (Neon's URLs contain
// "neon.tech" and/or "sslmode=require"). PGSSL=true still forces it on
// explicitly if a provider isn't auto-detected.
const dbUrl = process.env.DATABASE_URL || '';
const autoDetectedSSL = /neon\.tech/i.test(dbUrl) || /sslmode=require/i.test(dbUrl);
const useSSL = process.env.PGSSL === 'true' || process.env.PGSSL === '1' || autoDetectedSSL;

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
      logo_data BYTEA,
      logo_favicon_data BYTEA,
      logo_width INTEGER,
      logo_height INTEGER,
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

    CREATE TABLE IF NOT EXISTS custom_roles (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      permissions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, name)
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      custom_role_id TEXT REFERENCES custom_roles(id),
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
      photo_data BYTEA,
      photo_mime_type TEXT,
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
      start_time TEXT,
      end_time TEXT,
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
      file_data BYTEA,
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
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_data BYTEA;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_favicon_data BYTEA;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_width INTEGER;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_height INTEGER;`);
  await pool.query(`ALTER TABLE logs ADD COLUMN IF NOT EXISTS start_time TEXT;`);
  await pool.query(`ALTER TABLE logs ADD COLUMN IF NOT EXISTS end_time TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS custom_roles (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      permissions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(organization_id, name)
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id TEXT REFERENCES custom_roles(id);`);
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS photo_data BYTEA;`);
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS photo_mime_type TEXT;`);
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS model TEXT;`);
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS serial_number TEXT;`);
  await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS power_rating TEXT;`);
  // Per-organization installable-app icon, uploaded by the Super Admin. Four
  // pre-sized PNGs so nothing is resized at request time. NULL = use the
  // default ORB CMMS icon.
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS app_icon_512 BYTEA;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS app_icon_192 BYTEA;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS app_icon_180 BYTEA;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS app_icon_64 BYTEA;`);
  await pool.query(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS app_icon_updated_at TEXT;`);
  await pool.query(`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS file_data BYTEA;`);

  // ---- Kanban boards ----
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      description TEXT,
      color TEXT,
      labels TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_members (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      added_at TEXT NOT NULL,
      PRIMARY KEY (board_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS board_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      is_done BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS board_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      priority TEXT,
      due_date TEXT,
      label_ids TEXT,
      assignee_ids TEXT,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      completed_at TEXT,
      machine_id TEXT,
      log_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_checklist (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS card_comments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
      user_id TEXT,
      user_name TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_attachments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      data BYTEA NOT NULL,
      uploaded_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_board_cards_board ON board_cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);
  `);
}

module.exports = { pool, ensureSchema };
