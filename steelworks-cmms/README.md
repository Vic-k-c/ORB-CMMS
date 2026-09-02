# STEELWORKS CMMS

A multi-tenant CMMS for steel fabrication plants — each **organization**
gets its own isolated machines, logs, users, and branding, all in one
deployment.

- **Dashboard** — PM-due-soon, machines down, total machines, logs this month, pending logs, awaiting review, a weekly trend chart, and a PM compliance chart
- **Machines** — photo-card registry, searchable/filterable, with a detail view showing full maintenance history and lifetime reliability metrics
- **Maintenance Logs** — every log, filterable, submitted via a machine-name dropdown (Preventive or Breakdown), with photo/PDF attachments and a supervisor review step
- **Reports** — daily / monthly / yearly, each with charts, summary figures, and a **Download PDF** button (organization letterhead, no document-code box)
- **Excel export** — maintenance logs and the machine performance matrix, each with the organization's own letterhead and document code
- **Admin** — user accounts (Technician / Maintenance Supervisor / Management) and organization branding, scoped to your own organization only

Color scheme: white background, navy blue primary, grey secondary text/borders, red reserved for alerts (Down, Breakdown, overdue).

## Multi-tenancy: organizations and Super Admin

Every organization is fully isolated — machines, logs, users, settings,
and branding never cross between organizations. There are two kinds of
accounts:

- **Regular accounts** (Technician / Maintenance Supervisor / Management)
  belong to exactly one organization and log in with an **Organization
  Code** alongside their username and password.
- **Super Admin** belongs to no organization. Its only job is creating new
  organizations (and their first Management account) from a dedicated
  panel — it never sees any organization's machines, logs, or data. Log
  in as Super Admin by leaving the Organization Code field **blank**.

**Your existing single-tenant data isn't lost.** On first run of this
version, `db.js` automatically creates an organization called "Zenith
Steel Fabricators Ltd" (code `ZSF`) seeded with the exact letterhead
values that used to be hardcoded, and attaches every existing machine,
log, and user account to it. This runs inside one atomic transaction, so
if anything fails partway through, nothing is left half-converted.

**First login after upgrading:**
```
Organization Code: ZSF
Username: admin
Password: admin123
```
(This is your existing account — nothing changed about it except it's
now attached to an organization.)

**Super Admin login** (new — leave Organization Code blank):
```
Username: superadmin
Password: superadmin123
```
**Change both passwords immediately** — Super Admin can create
organizations for anyone, and the default org admin can manage all of
Zenith's data.

**Note:** the login page itself no longer displays these default
credentials as an on-screen hint (removed on request) — this README is
now the only place they're documented, so keep it handy until you've
changed both passwords.

### Creating a new organization

Log in as Super Admin → **+ New Organization** → fill in the
organization's name, a short login code (e.g. `ACME`), and the name/
username/password for its first Management user. That's the entire
account creation flow — no self-service sign-up exists by design.

### Organization branding

Each organization manages its **own** branding independently — Super
Admin does not set this up for them. From **Admin → Organization
Branding** (Management role only), an organization can set:
- Company name and tagline
- **Logo** — a real uploaded file (PNG/JPEG, up to 3MB), not a pasted
  URL. This matters: pasted third-party URLs would fail to embed in
  client-generated PDFs due to CORS restrictions on cross-origin images.
  An uploaded file is served from this app's own origin, so it embeds
  reliably in both PDFs (client-side, jsPDF) and Excel exports
  (server-side, ExcelJS).
- Document control fields for the log PDF (Document No., Effective Date,
  Rev, Issue) and the Excel export (Document No., Effective Date, Rev)
- Approved By

A brand-new organization starts with **no logo and blank document
codes** — there's nothing to invent on your behalf, so these fields stay
empty until that organization's own Management fills them in.

## Date of maintenance

The log form has a **Date of Maintenance** field, defaulting to today but
editable — useful for logging work a day or two late without the log
looking like it happened "now." Only the date is adjustable; the exact
time-of-day is always whatever moment the form was submitted (combined
with the chosen date via the browser's local timezone, then converted to
UTC for storage - avoids the timezone bugs a full date+time picker would
introduce). This also means editing a log can now correct its date too,
not just its content.

## App white-labeling

Once an organization uploads a logo (Admin -> Organization Branding), it
replaces the default "STEELWORKS CMMS" name/icon in the **app header**
with the organization's own logo — same file already used for document
letterheads, no separate upload.

**The login page itself has no branding text** (no "STEELWORKS CMMS"
name/icon) and shows a fixed background image
(`public/login-bg.jpg`) — swap that file to change it, same filename.

**Remembered organization logo:** the browser remembers the last
Organization Code successfully used on that device (via `localStorage`,
client-side only — the server has no concept of "this device") and
pre-fills it next time, showing that organization's logo above the
login form if one exists. This is a convenience for a shop-floor
terminal that's always logged into the same organization; it fails
silently (just doesn't show a logo) if nothing's remembered yet or that
organization has none uploaded. Powered by a narrow public endpoint,
`GET /api/public/org-logo/:orgCode` — deliberately unauthenticated so
the login page can use it before anyone signs in, but it only ever
returns a logo image, nothing else about the organization.

**Header Display** (same settings page) controls what text accompanies
the logo, useful when a logo image already has the company name/tagline
baked into the graphic:

| Mode | Logo | Title (company name) | Subtitle |
|---|:---:|:---:|---|
| Logo only | Yes | No | (blank) |
| Logo plus company name and tagline | Yes | Yes | Your tagline |
| Logo and tagline | Yes | No | Your tagline |

**This mode applies everywhere the logo appears**, not just the app
header: the individual log PDF, the Daily/Monthly/Yearly report PDFs,
and both Excel exports (maintenance logs and machine performance) all
show the same name/tagline treatment. One exception: the **document
control box** (Document No., Effective Date, Rev, Issue, Approved By)
always shows in full regardless of mode — that's compliance information,
not a branding preference, so "Logo only" doesn't hide it.

In the two modes that show a subtitle, your organization's **tagline
replaces** the app's generic "Maintenance Log & Work Order System" text
rather than appearing alongside it — the point is keeping header space
minimal regardless of which mode is picked. A live preview on the
settings page reflects whatever's currently typed/selected before you
save, using a cached logo request (or the icon fallback if none is
uploaded yet) so you can see the real effect immediately.

**On mobile screens** (768px and narrower), the logged-in user's name
and role move out of the compact header bar and into the hamburger menu
instead — opening the nav dropdown shows a small info row above the
Dashboard/Machines/etc. links. This was purely to save header space on
small screens; nothing about the information itself changed.

## Maintenance HOD role

A fourth role, `Maintenance HOD`, with **identical permissions to
Management** — it exists purely so organizations whose org chart uses
that title don't have to relabel it "Management." Anywhere the app
enforces "Management only," a Maintenance HOD account works exactly the
same way, including the safeguard that blocks deleting/demoting the last
full-admin account in an organization (that safeguard now counts
Management and Maintenance HOD together).

## Editing a submitted log

Maintenance Supervisor, Management, and Maintenance HOD can click **Edit**
on any log card to correct its details after submission — machine, type,
technician, downtime, findings, actions taken, parts, status
(Pending/Completed), and now the date of maintenance (see below).
Technicians cannot edit logs, including their own.

One thing is deliberately **not** editable through this form:
- **Reviewed status** — once a log is Reviewed, editing its content is
  still allowed, but its status can't be changed away from Reviewed
  through this form (the dropdown locks). That protects the review
  audit trail (who reviewed it, and when) from being silently
  overwritten by an unrelated content edit. Un-reviewing isn't built
  yet either, if that turns out to be needed.

## Log review workflow

A log's status has three stages, in order: **Pending → Completed → Reviewed**.
- Pending / Completed are set by whoever submits the log (any role).
- **Reviewed** is a separate step: a Maintenance Supervisor or Management
  user clicks **Mark Reviewed** on a Completed log, which records their
  name, role, and a timestamp. Only Completed logs can be reviewed.
- The per-log PDF includes a **Reviewed By** line (name, role, date) in
  the footer. There's no separate **Approved By** step in this version.

## File attachments

Any log entry can have photos or PDFs attached — a **+ Attach File**
button appears on every log card. Supervisor/Management users see a
small **×** on each attachment to delete it (removes the file from disk
too). Videos aren't accepted, to keep server storage light. Limit is
15MB per file; adjust `limits.fileSize` in `server.js` if you need more
room. Files live on disk under `data/uploads/<log-id>/`, alongside the
database — back both up together.

## Individual log PDFs

Follow the layout of the Breakdown Report Form, used for both Preventive
and Breakdown logs, pulling document code, effective date, rev, issue,
and approved-by from the logged-in user's own organization.

**Two fields in the per-log PDF are calculated, not technician-entered:**
Start Time and End Time are derived from the log's timestamp and downtime
hours (End = when the log was submitted, Start = End minus downtime),
since the log form only captures total downtime hours, not clock times.
The same approach is used for the Excel export's START TIME / END TIME
columns. Worth knowing if precise clock times matter for compliance.

## Machine reliability metrics

Every machine tracks five metrics: **cumulative downtime, number of
failures, MTTR, MTBF, and operating time**.

- **Cumulative downtime** = total downtime hours across all logs (Preventive + Breakdown) in the period
- **Number of failures** = count of Breakdown-type logs in the period
- **MTTR** (mean time to repair) = breakdown-only downtime ÷ number of failures
- **MTBF** (mean time between failures) = operating time ÷ number of failures
- **Operating time** = scheduled hours − cumulative downtime (floored at 0)

These are standard reliability-engineering definitions — flag it if a
plant defines any of them differently and the formulas in
`computeMachineMetrics()` in `server.js` can be adjusted.

**Two places these show up:**
- **Machine Detail page** (any role) — lifetime cumulative totals, from
  the machine's registration date to today.
- **Dashboard → Machine Performance** (Maintenance Supervisor,
  Management, and Maintenance HOD) — the same five metrics for every
  machine in that organization side by side, filterable by Daily /
  Monthly / Yearly / Custom Range **and** by department (e.g. just
  Cranes, just Compressors), with its own Excel export that reflects
  both filters.

**Operating schedule** is per-organization: one default (9 hours/day out
of the box), editable from the dashboard's **Manage Operating Schedule**
link. For any date that isn't a plain default day — a Sunday, a night
shift, a holiday — Supervisor/Management add a one-off override for that
specific date. There's no automatic weekly pattern; a Sunday only counts
as non-operating if someone actually adds an override for that date.

## Stack

- **Backend:** Node.js + Express + PostgreSQL (`pg`) + sessions
  (`express-session`) + password hashing (`bcryptjs`) + file uploads
  (`multer`) + Excel generation (`exceljs`) — all pure JS, no native
  compilation required
- **Frontend:** plain HTML/CSS/JS + Chart.js (dashboard/report charts) +
  jsPDF (PDF export), both loaded via CDN
- **Database:** PostgreSQL, connected via the `DATABASE_URL` environment
  variable. Schema is created automatically on startup (`db.js`'s
  `ensureSchema()`) — no separate migration step to run by hand.
- **Uploaded files:** log attachments under `data/uploads/`, organization
  logos under `data/logos/`, both auto-created on first run (these stay
  on local disk regardless of database choice — see the persistent-disk
  note under Render hosting below)

## Roles & permissions

| Action                        | Technician | Maintenance Supervisor | Management | Maintenance HOD | Super Admin |
|--------------------------------|:----------:|:-----------------------:|:----------:|:----------------:|:-----------:|
| View dashboard, machines, logs, reports (own org) | Yes | Yes | Yes | Yes | No |
| Submit a maintenance log       | Yes        | Yes                     | Yes        | Yes              | No |
| Attach files to a log          | Yes        | Yes                     | Yes        | Yes              | No |
| Download PDF / Excel reports   | Yes        | Yes                     | Yes        | Yes              | No |
| Mark a log as Reviewed         | No         | Yes                     | Yes        | Yes              | No |
| Edit a submitted log           | No         | Yes                     | Yes        | Yes              | No |
| Add / edit machines            | No         | Yes                     | Yes        | Yes              | No |
| Delete an attachment           | No         | Yes                     | Yes        | Yes              | No |
| View Dashboard performance matrix | No     | Yes                     | Yes        | Yes              | No |
| Edit operating schedule        | No         | Yes                     | Yes        | Yes              | No |
| Manage user accounts (own org) | No         | No                      | Yes        | Yes              | No |
| Edit organization branding     | No         | No                      | Yes        | Yes              | No |
| Create new organizations       | No         | No                      | No         | No               | Yes |

Note: `Maintenance HOD` and `Management` are functionally identical roles
- see "Maintenance HOD role" above for why this exists as a separate title
rather than an alias.

Note: usernames are **globally unique across the whole server**, not
just within an organization — so if one organization already has a user
named `admin`, no other organization can also use `admin` as a username.
This was a deliberate simplification to avoid a riskier database
rebuild; it can be revisited if it becomes a real problem.

## Requirements

- [Node.js](https://nodejs.org/) version 18 or later
- A PostgreSQL database (version 12+), with a connection string

```bash
node -v
```

## Install & run locally

```bash
cd steelworks-cmms
npm install
DATABASE_URL=postgres://user:password@host:port/dbname npm start
```
Or export `DATABASE_URL` in your shell/`.env` setup rather than inlining
it. Then open `http://localhost:3000`.

**This version starts fresh — there's no data migration from an older
SQLite-based version of this project.** On first run against an empty
database, the schema is created automatically, a starter organization
(code `DEFAULT`) is seeded, and two accounts are created:
```
Username: admin       Password: admin123      (org code: DEFAULT)
Username: superadmin  Password: superadmin123 (leave org code blank)
```
**Change both immediately.**

**No local Postgres yet?** The quickest way to get one:
```bash
docker run --name cmms-postgres -e POSTGRES_PASSWORD=devpassword -p 5432:5432 -d postgres
```
Then `DATABASE_URL=postgres://postgres:devpassword@localhost:5432/postgres`.

## Running on a different port

```bash
PORT=8080 npm start
```

## Session secret

Sessions are signed with `SESSION_SECRET`. A default is baked in for local
use, but if you deploy this anywhere reachable by others, set your own:
```bash
SESSION_SECRET=some-long-random-string npm start
```

## SSL for the Postgres connection

Off by default (`PGSSL` unset). This matches Render's **internal**
database URL, which runs on the same private network as the app and
typically doesn't need SSL. If you connect using an **external**
connection string instead (e.g. a remote Postgres reached from your own
PC), set:
```bash
PGSSL=true npm start
```
If the connection just hangs or errors out immediately, this is the
first thing to try flipping.

## Running on your local network

Express listens on all interfaces by default:
```
http://<this-computer's-LAN-IP>:3000
```
Find the LAN IP with `ipconfig` (Windows) or `ifconfig` / `ip addr`
(Mac/Linux). Allow inbound connections on the port in your firewall.

## Temporary hosting on Render

This project includes a `render.yaml` blueprint.

1. Push this folder to a GitHub repo.
2. Create a Postgres database in Render (or use one you already have).
3. In Render: **New +** → **Blueprint** → connect the repo. It reads
   `render.yaml` and configures build (`npm install`) and start
   (`npm start`) automatically.
4. Set the **`DATABASE_URL`** environment variable on the web service to
   your Postgres instance's **Internal Database URL** (same Render
   private network — no SSL needed, matches this project's default).
5. Click **Deploy**.

**Set `SESSION_SECRET`** as an environment variable too, if you deploy
somewhere other people can reach.

**Render's free-tier web service has no persistent local disk** — the
database itself (Postgres) persists your machines/logs/users/logo
independently of the web service, but **log attachments** (photos/PDFs
on maintenance logs) still live on the web service's local disk and
will be wiped on redeploy or after ~15 minutes idle. Organization logos
used to have this exact problem too — they're now stored directly in
Postgres (`organizations.logo_data`) specifically to survive redeploys,
so only attachments are still at risk. If attachments need to survive
long-term on Render's free tier, they'd need to move to an external
object store (e.g. S3-compatible storage) — not implemented here yet.

## Running as a background service (optional)

```bash
npm install -g pm2
pm2 start server.js --name cmms
pm2 save
```

## Project structure

```
steelworks-cmms/
├── server.js          Express app, auth, all REST API routes, Excel export
├── db.js              PostgreSQL connection pool, schema setup
├── package.json
├── render.yaml
├── .node-version
├── data/
│   ├── uploads/        Log attachment files (auto-created, local disk)
│   └── logos/           Organization logo files (auto-created, local disk)
└── public/
    ├── index.html      Login gate, Super Admin shell, regular app shell
    ├── style.css       White/navy/grey/red theme, mobile-responsive header
    └── app.js           Frontend logic, role gating, PDF/Excel generation
```

## API reference

Every route under `/api` except `/api/auth/login` and `/api/auth/me`
requires a logged-in session. Everything except the two
`/api/super-admin/organizations` routes additionally requires the
account to belong to an organization (Super Admin is blocked from all of
it, by design).

| Method | Endpoint                            | Access                  | Purpose |
|--------|---------------------------------------|--------------------------|---------|
| POST   | `/api/auth/login`                    | Public                  | Log in (`orgCode` optional - blank for Super Admin) |
| GET    | `/api/auth/me`                       | Public                  | Returns current session user or null |
| POST   | `/api/auth/logout`                   | Any logged-in user       | Ends the session |
| GET    | `/api/public/org-logo/:orgCode`      | Public                  | Logo image only, for the login page's remembered-org feature |
| GET    | `/api/super-admin/organizations`     | Super Admin              | List all organizations with counts |
| POST   | `/api/super-admin/organizations`     | Super Admin              | Create an organization + its first Management user |
| PUT    | `/api/super-admin/organizations/:id` | Super Admin              | Rename an organization / toggle active status |
| GET    | `/api/super-admin/organizations/:id/users` | Super Admin        | List an organization's users (name/username/role only) |
| POST   | `/api/super-admin/organizations/:id/reset-password` | Super Admin | Reset a specific user's password |
| GET    | `/api/branding`                      | Any org user             | Own organization's branding (for PDF letterheads) |
| PUT    | `/api/organization/branding`         | Management                | Update own organization's branding fields |
| GET    | `/api/organization/logo`             | Any org user             | Stream own organization's logo file |
| POST   | `/api/organization/logo`             | Management                | Upload/replace own organization's logo |
| DELETE | `/api/organization/logo`             | Management                | Remove own organization's logo |
| GET    | `/api/machines`                      | Any org user             | List own organization's machines |
| GET    | `/api/machines/:id`                  | Any org user             | One machine + maintenance history |
| POST   | `/api/machines`                      | Supervisor, Management   | Register a machine |
| PUT    | `/api/machines/:id`                  | Supervisor, Management   | Update a machine |
| GET    | `/api/machines/:id/metrics`          | Any org user              | Lifetime reliability metrics for one machine |
| GET    | `/api/machines/metrics-matrix`       | Supervisor, Management    | All machines' metrics for a period |
| GET    | `/api/machines/metrics-matrix/export/excel` | Supervisor, Management | Excel export of the performance matrix |
| GET    | `/api/logs`                          | Any org user             | List logs, `?machineId=&logType=&status=` |
| POST   | `/api/logs`                          | Any org user             | Submit a maintenance log (status: Pending/Completed) |
| PUT    | `/api/logs/:id`                      | Supervisor, Management, Maintenance HOD | Edit an existing log's content, including its date |
| PATCH  | `/api/logs/:id/review`               | Supervisor, Management   | Mark a Completed log as Reviewed |
| POST   | `/api/logs/:id/attachments`          | Any org user             | Upload up to 5 files (multipart/form-data, field `files`) |
| GET    | `/api/logs/:id/attachments`          | Any org user             | List a log's attachments |
| GET    | `/api/attachments/:id/file`          | Any org user             | Stream/view an attached file |
| DELETE | `/api/attachments/:id`               | Supervisor, Management   | Delete an attachment |
| GET    | `/api/logs/export/excel`             | Any org user             | `?month=YYYY-MM` or `?from=YYYY-MM-DD&to=YYYY-MM-DD` |
| GET    | `/api/dashboard`                     | Any org user             | All dashboard stats and chart data |
| GET    | `/api/reports/daily?date=`           | Any org user             | Daily report |
| GET    | `/api/reports/monthly?year=&month=`  | Any org user             | Monthly report |
| GET    | `/api/reports/yearly?year=`          | Any org user             | Yearly report |
| GET    | `/api/users`                         | Management               | List own organization's user accounts |
| POST   | `/api/users`                         | Management               | Create a user account (own org) |
| PUT    | `/api/users/:id`                     | Management               | Update name/role/password (own org) |
| DELETE | `/api/users/:id`                     | Management               | Delete a user account (own org) |
| GET    | `/api/settings`                      | Supervisor, Management    | Own organization's default operating hours/day |
| PUT    | `/api/settings`                      | Supervisor, Management    | Update default operating hours/day |
| GET    | `/api/schedule-overrides`            | Supervisor, Management    | List date overrides, optional `?from=&to=` |
| POST   | `/api/schedule-overrides`             | Supervisor, Management    | Add/update an override for one date |
| DELETE | `/api/schedule-overrides/:date`      | Supervisor, Management    | Remove an override |

## Notes / things you may want to extend

- **Super Admin can rename, deactivate, and reset a user's password** for
  any organization, but can't delete one entirely or see any of its
  operational data (machines, logs, etc.) — deliberately narrow, by
  design. Deactivating blocks that organization's users immediately,
  including anyone already logged in.
- **PDF export runs entirely in the browser** via jsPDF — no server-side
  PDF library, so no extra native dependencies or Render build risk.
  Chart images embedded in report PDFs are snapshots of the on-screen
  canvas at the moment you click Download.
- **Photos on machines are pasted URLs**, not uploads (unlike log
  attachments and organization logos, which are real uploads).
- **Sessions use the default in-memory store** — fine for a single-process
  local server, but sessions won't survive a server restart, and it isn't
  meant for multi-instance deployments.
- **Usernames are globally unique**, not per-organization — see the note
  under Roles & permissions above.
- **Parts used is free text**, not linked to an inventory table.
- **PM interval is a fixed 30 days** after completing a Preventive log —
  see `addDays(todayISO(), 30)` in `server.js`.
- **The last Management account in an organization can't be deleted or
  demoted**, so an organization can't accidentally lock itself out of
  Admin.
- **This version has no data migration path from the old SQLite-based
  version** — it's a fresh start on Postgres. If you have real data in an
  old `data/cmms.db` file you need preserved, that would need a one-off
  export/import script (not included) before switching.
- **Postgres `COUNT(*)` results are strings, not numbers** — handled via
  a `toInt()` helper used everywhere counts are read in `server.js`. If
  you add new aggregate queries, remember this or comparisons/arithmetic
  can silently misbehave (e.g. `"5" + 1` is the string `"51"`, not `6`).
