// Kanban boards: Trello-style boards, columns, cards, checklists, comments,
// attachments and per-board members. Mounted by server.js AFTER the global
// requireAuth / requireOrgContext middleware, so every route here already has
// an authenticated user that belongs to an organization.
//
// Access model: a board is visible to its members only. The board's creator
// is its 'owner' (owners can rename/delete the board, manage columns, labels
// and members). Everyone else on the board is a 'member' (create/edit/move
// cards, comment, check items, attach files). Management / HOD roles can open
// and manage every board in their organization so a board never gets orphaned.

const TEMPLATES = {
  maintenance: ['To Do', 'In Progress', 'Waiting for Parts', 'Done'],
  project: ['Backlog', 'Planned', 'In Progress', 'Review', 'Done'],
  blank: ['To Do', 'Done']
};
const DEFAULT_LABELS = [
  { id: 'lb1', name: 'Urgent', color: '#d64545' },
  { id: 'lb2', name: 'Electrical', color: '#e0a526' },
  { id: 'lb3', name: 'Mechanical', color: '#2f7fd1' },
  { id: 'lb4', name: 'Hydraulic', color: '#2e9e6b' },
  { id: 'lb5', name: 'Safety', color: '#8e5bd1' },
  { id: 'lb6', name: 'Parts / Procurement', color: '#d16b2f' }
];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const MAX_ATTACH_BYTES = 3 * 1024 * 1024;
const MAX_ATTACH_PER_CARD = 10;
const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i;

function parseJSON(text, fallback) {
  if (!text) return fallback;
  try { const v = JSON.parse(text); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
}

module.exports = function registerKanban(app, deps) {
  const { dbGet, dbAll, dbRun, genId, nowISO, multer, FULL_ADMIN_ROLES, withTransaction } = deps;
  const attachUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACH_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME.test(file.mimetype || '')) return cb(new Error('Only images (PNG, JPG, GIF, WebP) and PDF files can be attached'));
      cb(null, true);
    }
  });

  const orgOf = (req) => req.session.user.organizationId;
  const isAdminRole = (req) => FULL_ADMIN_ROLES.includes(req.session.user.role);
  const fail = (res, e, msg) => res.status(500).json({ error: msg + ': ' + e.message });

  // ---- access helpers ----
  // Returns { board, role } where role is 'owner' | 'member', or null.
  async function boardAccess(req, boardId) {
    const board = await dbGet('SELECT * FROM boards WHERE id = $1 AND organization_id = $2', [boardId, orgOf(req)]);
    if (!board) return null;
    const mem = await dbGet('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [boardId, req.session.user.id]);
    if (mem) return { board, role: isAdminRole(req) ? 'owner' : mem.role };
    if (isAdminRole(req)) return { board, role: 'owner' };
    return null;
  }
  async function cardWithAccess(req, cardId) {
    const card = await dbGet('SELECT * FROM board_cards WHERE id = $1', [cardId]);
    if (!card) return null;
    const acc = await boardAccess(req, card.board_id);
    return acc ? { card, ...acc } : null;
  }
  const needBoard = async (req, res) => {
    const acc = await boardAccess(req, req.params.id);
    if (!acc) { res.status(404).json({ error: 'Board not found or you are not a member of it' }); return null; }
    return acc;
  };
  const needOwner = async (req, res) => {
    const acc = await needBoard(req, res);
    if (!acc) return null;
    if (acc.role !== 'owner') { res.status(403).json({ error: 'Only the board owner can do that' }); return null; }
    return acc;
  };
  const needCard = async (req, res) => {
    const x = await cardWithAccess(req, req.params.cid);
    if (!x) { res.status(404).json({ error: 'Card not found or you are not a member of its board' }); return null; }
    return x;
  };

  // ---- shaping ----
  function cardJSON(c, extra) {
    return {
      id: c.id, boardId: c.board_id, columnId: c.column_id, title: c.title, description: c.description || '',
      position: c.position, priority: c.priority || '', dueDate: c.due_date || '',
      labelIds: parseJSON(c.label_ids, []), assigneeIds: parseJSON(c.assignee_ids, []),
      done: !!c.done, completedAt: c.completed_at || null,
      machineId: c.machine_id || null, logId: c.log_id || null,
      coverAttachmentId: c.cover_attachment_id || null,
      createdBy: c.created_by, createdAt: c.created_at,
      ...(extra || {})
    };
  }
  async function renumber(columnId, orderedIds) {
    for (let i = 0; i < orderedIds.length; i++) {
      await dbRun('UPDATE board_cards SET position = $1 WHERE id = $2', [i, orderedIds[i]]);
    }
  }
  async function validAssignees(req, ids, boardId) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    // Only people who are on the board can be assigned to its cards.
    const rows = await dbAll('SELECT user_id FROM board_members WHERE board_id = $1', [boardId]);
    const ok = new Set(rows.map(r => r.user_id));
    return [...new Set(ids.filter(i => ok.has(i)))];
  }
  async function validMachine(req, machineId) {
    if (!machineId) return null;
    const m = await dbGet('SELECT id FROM machines WHERE id = $1 AND organization_id = $2', [machineId, orgOf(req)]);
    return m ? m.id : null;
  }
  async function validLog(req, logId) {
    if (!logId) return null;
    const l = await dbGet('SELECT id FROM logs WHERE id = $1 AND organization_id = $2', [logId, orgOf(req)]);
    return l ? l.id : null;
  }
  function cleanDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null; }
  function cleanPriority(p) { return PRIORITIES.includes(p) ? p : null; }

  // ================= LOOKUPS =================
  app.get('/api/kanban/users', async (req, res) => {
    try {
      const rows = await dbAll('SELECT id, name, username, role FROM users WHERE organization_id = $1 ORDER BY name ASC', [orgOf(req)]);
      res.json(rows.map(r => ({ id: r.id, name: r.name, username: r.username, role: r.role })));
    } catch (e) { fail(res, e, 'Could not list users'); }
  });

  // Open work that can become a card in one tap: Pending logs and overdue PM.
  app.get('/api/kanban/suggestions', async (req, res) => {
    try {
      const org = orgOf(req);
      const today = new Date().toISOString().slice(0, 10);
      const pending = await dbAll(`
        SELECT l.id, l.findings, l.logged_at, l.start_time, l.machine_id, m.name AS machine_name, m.code AS machine_code
        FROM logs l JOIN machines m ON m.id = l.machine_id
        WHERE l.organization_id = $1 AND l.status = 'Pending'
        ORDER BY l.logged_at DESC LIMIT 40
      `, [org]);
      const overdue = await dbAll(`
        SELECT id, name, code, next_pm_date FROM machines
        WHERE organization_id = $1 AND next_pm_date IS NOT NULL AND next_pm_date != '' AND next_pm_date < $2
        ORDER BY next_pm_date ASC LIMIT 40
      `, [org, today]);
      res.json({
        pendingLogs: pending.map(r => ({
          logId: r.id, machineId: r.machine_id, machineName: r.machine_name, machineCode: r.machine_code,
          findings: r.findings, date: String(r.start_time || r.logged_at).slice(0, 10)
        })),
        overduePm: overdue.map(r => ({ machineId: r.id, machineName: r.name, machineCode: r.code, nextPmDate: r.next_pm_date }))
      });
    } catch (e) { fail(res, e, 'Could not load suggestions'); }
  });

  // ================= BOARDS =================
  app.get('/api/kanban/boards', async (req, res) => {
    try {
      const org = orgOf(req);
      const rows = isAdminRole(req)
        ? await dbAll('SELECT * FROM boards WHERE organization_id = $1 ORDER BY created_at ASC', [org])
        : await dbAll(`SELECT b.* FROM boards b JOIN board_members bm ON bm.board_id = b.id
                       WHERE b.organization_id = $1 AND bm.user_id = $2 ORDER BY b.created_at ASC`, [org, req.session.user.id]);
      const out = [];
      for (const b of rows) {
        const stats = await dbGet(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE done) AS done,
          COUNT(*) FILTER (WHERE NOT done AND due_date IS NOT NULL AND due_date <> '' AND due_date < $2) AS overdue
          FROM board_cards WHERE board_id = $1`, [b.id, new Date().toISOString().slice(0, 10)]);
        const members = await dbAll(`SELECT u.id, u.name FROM board_members bm JOIN users u ON u.id = bm.user_id WHERE bm.board_id = $1 ORDER BY u.name`, [b.id]);
        const mine = await dbGet('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [b.id, req.session.user.id]);
        out.push({
          id: b.id, name: b.name, description: b.description || '', color: b.color || '#0B2545',
          totalCards: parseInt(stats.total, 10), doneCards: parseInt(stats.done, 10), overdueCards: parseInt(stats.overdue, 10),
          members, myRole: isAdminRole(req) ? 'owner' : (mine ? mine.role : null), isMember: !!mine, createdAt: b.created_at
        });
      }
      res.json(out);
    } catch (e) { fail(res, e, 'Could not list boards'); }
  });

  app.post('/api/kanban/boards', async (req, res) => {
    try {
      const { name, description, color, template, memberIds } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Board name is required' });
      const org = orgOf(req);
      const cols = TEMPLATES[template] || TEMPLATES.maintenance;
      const id = genId('BRD');
      const now = nowISO();
      // Invited people must belong to the same organization.
      let invited = [];
      if (Array.isArray(memberIds) && memberIds.length) {
        const rows = await dbAll('SELECT id FROM users WHERE organization_id = $1 AND id = ANY($2::text[])', [org, memberIds]);
        invited = rows.map(r => r.id).filter(i => i !== req.session.user.id);
      }
      await withTransaction(async (client) => {
        await client.query('INSERT INTO boards (id, organization_id, name, description, color, labels, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, org, String(name).trim().slice(0, 120), String(description || '').slice(0, 1000), color || '#0B2545', JSON.stringify(DEFAULT_LABELS), req.session.user.id, now]);
        await client.query("INSERT INTO board_members (board_id, user_id, role, added_at) VALUES ($1,$2,'owner',$3)", [id, req.session.user.id, now]);
        for (const uid of invited) {
          await client.query("INSERT INTO board_members (board_id, user_id, role, added_at) VALUES ($1,$2,'member',$3)", [id, uid, now]);
        }
        for (let i = 0; i < cols.length; i++) {
          const isDone = cols[i] === 'Done';
          await client.query('INSERT INTO board_columns (id, board_id, name, position, is_done) VALUES ($1,$2,$3,$4,$5)',
            [genId('COL') + i, id, cols[i], i, isDone]);
        }
      });
      res.json({ id });
    } catch (e) { fail(res, e, 'Could not create board'); }
  });

  app.get('/api/kanban/boards/:id', async (req, res) => {
    try {
      const acc = await needBoard(req, res); if (!acc) return;
      const b = acc.board;
      const columns = await dbAll('SELECT * FROM board_columns WHERE board_id = $1 ORDER BY position ASC', [b.id]);
      const cards = await dbAll(`
        SELECT c.*,
          (SELECT COUNT(*) FROM card_checklist k WHERE k.card_id = c.id) AS cl_total,
          (SELECT COUNT(*) FROM card_checklist k WHERE k.card_id = c.id AND k.done) AS cl_done,
          (SELECT COUNT(*) FROM card_comments k WHERE k.card_id = c.id) AS comments,
          (SELECT COUNT(*) FROM card_attachments k WHERE k.card_id = c.id) AS attachments,
          m.code AS machine_code, m.name AS machine_name
        FROM board_cards c LEFT JOIN machines m ON m.id = c.machine_id
        WHERE c.board_id = $1 ORDER BY c.position ASC, c.created_at ASC`, [b.id]);
      const members = await dbAll(`SELECT u.id, u.name, u.role AS user_role, bm.role FROM board_members bm JOIN users u ON u.id = bm.user_id WHERE bm.board_id = $1 ORDER BY u.name`, [b.id]);
      res.json({
        board: { id: b.id, name: b.name, description: b.description || '', color: b.color || '#0B2545', labels: parseJSON(b.labels, []), myRole: acc.role },
        columns: columns.map(c => ({ id: c.id, name: c.name, position: c.position, isDone: !!c.is_done })),
        cards: cards.map(c => cardJSON(c, {
          checklistTotal: parseInt(c.cl_total, 10), checklistDone: parseInt(c.cl_done, 10),
          commentCount: parseInt(c.comments, 10), attachmentCount: parseInt(c.attachments, 10),
          machineCode: c.machine_code || null, machineName: c.machine_name || null
        })),
        members: members.map(m => ({ id: m.id, name: m.name, userRole: m.user_role, role: m.role }))
      });
    } catch (e) { fail(res, e, 'Could not load board'); }
  });

  app.put('/api/kanban/boards/:id', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      const { name, description, color, labels } = req.body || {};
      const b = acc.board;
      let labelsJson = b.labels;
      if (Array.isArray(labels)) {
        const clean = labels.slice(0, 20).map((l, i) => ({
          id: String(l.id || ('lb' + Date.now() + i)).slice(0, 30),
          name: String(l.name || '').trim().slice(0, 30),
          color: /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : '#888888'
        })).filter(l => l.name);
        labelsJson = JSON.stringify(clean);
      }
      await dbRun('UPDATE boards SET name = $1, description = $2, color = $3, labels = $4 WHERE id = $5', [
        name !== undefined ? String(name).trim().slice(0, 120) || b.name : b.name,
        description !== undefined ? String(description).slice(0, 1000) : b.description,
        color || b.color, labelsJson, b.id
      ]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not update board'); }
  });

  app.delete('/api/kanban/boards/:id', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      await dbRun('DELETE FROM boards WHERE id = $1', [acc.board.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not delete board'); }
  });

  // ---- members ----
  app.post('/api/kanban/boards/:id/members', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      const { userId } = req.body || {};
      const u = await dbGet('SELECT id FROM users WHERE id = $1 AND organization_id = $2', [userId, orgOf(req)]);
      if (!u) return res.status(400).json({ error: 'That user is not in your organization' });
      await dbRun(`INSERT INTO board_members (board_id, user_id, role, added_at) VALUES ($1,$2,'member',$3) ON CONFLICT DO NOTHING`, [acc.board.id, userId, nowISO()]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not add member'); }
  });
  app.put('/api/kanban/boards/:id/members/:uid', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      const role = req.body && req.body.role === 'owner' ? 'owner' : 'member';
      if (role === 'member') {
        const owners = await dbGet("SELECT COUNT(*) AS c FROM board_members WHERE board_id = $1 AND role = 'owner' AND user_id <> $2", [acc.board.id, req.params.uid]);
        if (parseInt(owners.c, 10) === 0) return res.status(400).json({ error: 'A board needs at least one owner' });
      }
      await dbRun('UPDATE board_members SET role = $1 WHERE board_id = $2 AND user_id = $3', [role, acc.board.id, req.params.uid]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not change role'); }
  });
  app.delete('/api/kanban/boards/:id/members/:uid', async (req, res) => {
    try {
      const acc = await needBoard(req, res); if (!acc) return;
      const leavingSelf = req.params.uid === req.session.user.id;
      if (!leavingSelf && acc.role !== 'owner') return res.status(403).json({ error: 'Only the board owner can remove members' });
      const target = await dbGet('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [acc.board.id, req.params.uid]);
      if (!target) return res.json({ ok: true });
      if (target.role === 'owner') {
        const owners = await dbGet("SELECT COUNT(*) AS c FROM board_members WHERE board_id = $1 AND role = 'owner'", [acc.board.id]);
        if (parseInt(owners.c, 10) <= 1) return res.status(400).json({ error: 'A board needs at least one owner. Make someone else an owner first.' });
      }
      await dbRun('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [acc.board.id, req.params.uid]);
      // Drop the removed person from card assignments on this board.
      const cards = await dbAll("SELECT id, assignee_ids FROM board_cards WHERE board_id = $1 AND assignee_ids LIKE $2", [acc.board.id, '%' + req.params.uid + '%']);
      for (const c of cards) {
        const next = parseJSON(c.assignee_ids, []).filter(i => i !== req.params.uid);
        await dbRun('UPDATE board_cards SET assignee_ids = $1 WHERE id = $2', [JSON.stringify(next), c.id]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not remove member'); }
  });

  // ================= COLUMNS =================
  app.post('/api/kanban/boards/:id/columns', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      const { name, isDone } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Column name is required' });
      const pos = await dbGet('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_columns WHERE board_id = $1', [acc.board.id]);
      const id = genId('COL');
      await dbRun('INSERT INTO board_columns (id, board_id, name, position, is_done) VALUES ($1,$2,$3,$4,$5)', [id, acc.board.id, String(name).trim().slice(0, 60), pos.p, !!isDone]);
      res.json({ id });
    } catch (e) { fail(res, e, 'Could not add column'); }
  });
  app.put('/api/kanban/boards/:id/columns/reorder', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      const ids = (req.body && req.body.ids) || [];
      const existing = await dbAll('SELECT id FROM board_columns WHERE board_id = $1', [acc.board.id]);
      const set = new Set(existing.map(r => r.id));
      if (!Array.isArray(ids) || ids.length !== set.size || !ids.every(i => set.has(i))) return res.status(400).json({ error: 'Column list does not match this board' });
      for (let i = 0; i < ids.length; i++) await dbRun('UPDATE board_columns SET position = $1 WHERE id = $2', [i, ids[i]]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not reorder columns'); }
  });
  app.put('/api/kanban/boards/:id/columns/:colId', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      const col = await dbGet('SELECT * FROM board_columns WHERE id = $1 AND board_id = $2', [req.params.colId, acc.board.id]);
      if (!col) return res.status(404).json({ error: 'Column not found' });
      const { name, isDone } = req.body || {};
      await dbRun('UPDATE board_columns SET name = $1, is_done = $2 WHERE id = $3', [
        name !== undefined ? (String(name).trim().slice(0, 60) || col.name) : col.name,
        isDone !== undefined ? !!isDone : col.is_done, col.id
      ]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not update column'); }
  });
  app.delete('/api/kanban/boards/:id/columns/:colId', async (req, res) => {
    try {
      const acc = await needOwner(req, res); if (!acc) return;
      const cols = await dbAll('SELECT id FROM board_columns WHERE board_id = $1 ORDER BY position', [acc.board.id]);
      if (cols.length <= 1) return res.status(400).json({ error: 'A board needs at least one column' });
      const n = await dbGet('SELECT COUNT(*) AS c FROM board_cards WHERE column_id = $1', [req.params.colId]);
      if (parseInt(n.c, 10) > 0) return res.status(400).json({ error: 'Move or delete the cards in this column first' });
      await dbRun('DELETE FROM board_columns WHERE id = $1 AND board_id = $2', [req.params.colId, acc.board.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not delete column'); }
  });

  // ================= CARDS =================
  app.post('/api/kanban/boards/:id/cards', async (req, res) => {
    try {
      const acc = await needBoard(req, res); if (!acc) return;
      const b = req.body || {};
      if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Card title is required' });
      const col = await dbGet('SELECT * FROM board_columns WHERE id = $1 AND board_id = $2', [b.columnId, acc.board.id]);
      if (!col) return res.status(400).json({ error: 'Pick a column for the card' });
      const pos = await dbGet('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_cards WHERE column_id = $1', [col.id]);
      const id = genId('CRD');
      const assignees = await validAssignees(req, b.assigneeIds, acc.board.id);
      const done = !!b.done || !!col.is_done;
      await dbRun(`INSERT INTO board_cards (id, board_id, column_id, title, description, position, priority, due_date, label_ids, assignee_ids, done, completed_at, machine_id, log_id, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
        id, acc.board.id, col.id, String(b.title).trim().slice(0, 200), String(b.description || '').slice(0, 5000), pos.p,
        cleanPriority(b.priority), cleanDate(b.dueDate), JSON.stringify(Array.isArray(b.labelIds) ? b.labelIds.slice(0, 20) : []),
        JSON.stringify(assignees), done, done ? nowISO() : null,
        await validMachine(req, b.machineId), await validLog(req, b.logId), req.session.user.id, nowISO()
      ]);
      res.json({ id });
    } catch (e) { fail(res, e, 'Could not create card'); }
  });

  app.get('/api/kanban/cards/:cid', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      const checklist = await dbAll('SELECT id, text, done, position FROM card_checklist WHERE card_id = $1 ORDER BY position, id', [x.card.id]);
      const comments = await dbAll('SELECT id, user_id, user_name, body, created_at FROM card_comments WHERE card_id = $1 ORDER BY created_at ASC', [x.card.id]);
      const attachments = await dbAll('SELECT id, filename, mime_type, size, uploaded_by, created_at FROM card_attachments WHERE card_id = $1 ORDER BY created_at ASC', [x.card.id]);
      let machine = null, log = null;
      if (x.card.machine_id) machine = await dbGet('SELECT id, name, code FROM machines WHERE id = $1', [x.card.machine_id]);
      if (x.card.log_id) log = await dbGet('SELECT id, findings, status, logged_at FROM logs WHERE id = $1', [x.card.log_id]);
      res.json({
        card: cardJSON(x.card),
        checklist: checklist.map(k => ({ id: k.id, text: k.text, done: !!k.done })),
        comments: comments.map(c => ({ id: c.id, userId: c.user_id, userName: c.user_name, body: c.body, createdAt: c.created_at })),
        attachments: attachments.map(a => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size, createdAt: a.created_at })),
        machine, log: log ? { id: log.id, findings: log.findings, status: log.status, loggedAt: log.logged_at } : null
      });
    } catch (e) { fail(res, e, 'Could not load card'); }
  });

  app.put('/api/kanban/cards/:cid', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      const c = x.card, b = req.body || {};
      const col = await dbGet('SELECT is_done FROM board_columns WHERE id = $1', [c.column_id]);
      const set = {};
      if (b.title !== undefined) set.title = String(b.title).trim().slice(0, 200) || c.title;
      if (b.description !== undefined) set.description = String(b.description).slice(0, 5000);
      if (b.priority !== undefined) set.priority = cleanPriority(b.priority);
      if (b.dueDate !== undefined) set.due_date = cleanDate(b.dueDate);
      if (b.labelIds !== undefined) set.label_ids = JSON.stringify(Array.isArray(b.labelIds) ? b.labelIds.slice(0, 20) : []);
      if (b.assigneeIds !== undefined) set.assignee_ids = JSON.stringify(await validAssignees(req, b.assigneeIds, c.board_id));
      if (b.machineId !== undefined) set.machine_id = await validMachine(req, b.machineId);
      if (b.logId !== undefined) set.log_id = await validLog(req, b.logId);
      if (b.coverAttachmentId !== undefined) {
        if (!b.coverAttachmentId) set.cover_attachment_id = null;
        else {
          const att = await dbGet('SELECT id, mime_type FROM card_attachments WHERE id = $1 AND card_id = $2', [String(b.coverAttachmentId), c.id]);
          if (!att || !/^image\//.test(att.mime_type || '')) return res.status(400).json({ error: 'Only an image attached to this card can be the cover' });
          set.cover_attachment_id = att.id;
        }
      }
      if (b.done !== undefined) {
        set.done = !!b.done;
        set.completed_at = b.done ? (c.completed_at || nowISO()) : null;
      }
      const keys = Object.keys(set);
      if (keys.length) {
        await dbRun(`UPDATE board_cards SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map(k => set[k]), c.id]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not update card'); }
  });

  // Move a card to a column at a given index (0 = top).
  app.post('/api/kanban/cards/:cid/move', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      const { columnId, index } = req.body || {};
      const col = await dbGet('SELECT * FROM board_columns WHERE id = $1 AND board_id = $2', [columnId, x.card.board_id]);
      if (!col) return res.status(400).json({ error: 'Column not found on this board' });
      const fromCol = x.card.column_id;
      const target = (await dbAll('SELECT id FROM board_cards WHERE column_id = $1 AND id <> $2 ORDER BY position ASC, created_at ASC', [col.id, x.card.id])).map(r => r.id);
      const at = Math.max(0, Math.min(target.length, parseInt(index, 10) || 0));
      target.splice(at, 0, x.card.id);
      await dbRun('UPDATE board_cards SET column_id = $1 WHERE id = $2', [col.id, x.card.id]);
      await renumber(col.id, target);
      if (fromCol !== col.id) {
        const left = (await dbAll('SELECT id FROM board_cards WHERE column_id = $1 ORDER BY position ASC, created_at ASC', [fromCol])).map(r => r.id);
        await renumber(fromCol, left);
        // Entering a "done" column completes the card; leaving one reopens it.
        if (col.is_done && !x.card.done) await dbRun('UPDATE board_cards SET done = TRUE, completed_at = $1 WHERE id = $2', [nowISO(), x.card.id]);
        const prev = await dbGet('SELECT is_done FROM board_columns WHERE id = $1', [fromCol]);
        if (!col.is_done && prev && prev.is_done && x.card.done) await dbRun('UPDATE board_cards SET done = FALSE, completed_at = NULL WHERE id = $1', [x.card.id]);
      }
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not move card'); }
  });

  app.delete('/api/kanban/cards/:cid', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      await dbRun('DELETE FROM board_cards WHERE id = $1', [x.card.id]);
      const left = (await dbAll('SELECT id FROM board_cards WHERE column_id = $1 ORDER BY position ASC', [x.card.column_id])).map(r => r.id);
      await renumber(x.card.column_id, left);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not delete card'); }
  });

  // ---- checklist ----
  app.post('/api/kanban/cards/:cid/checklist', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      const text = String((req.body && req.body.text) || '').trim().slice(0, 300);
      if (!text) return res.status(400).json({ error: 'Checklist item text is required' });
      const pos = await dbGet('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM card_checklist WHERE card_id = $1', [x.card.id]);
      const id = genId('CHK');
      await dbRun('INSERT INTO card_checklist (id, card_id, text, done, position) VALUES ($1,$2,$3,FALSE,$4)', [id, x.card.id, text, pos.p]);
      res.json({ id });
    } catch (e) { fail(res, e, 'Could not add item'); }
  });
  app.put('/api/kanban/cards/:cid/checklist/:iid', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      const it = await dbGet('SELECT * FROM card_checklist WHERE id = $1 AND card_id = $2', [req.params.iid, x.card.id]);
      if (!it) return res.status(404).json({ error: 'Item not found' });
      const b = req.body || {};
      await dbRun('UPDATE card_checklist SET text = $1, done = $2 WHERE id = $3', [
        b.text !== undefined ? (String(b.text).trim().slice(0, 300) || it.text) : it.text,
        b.done !== undefined ? !!b.done : it.done, it.id
      ]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not update item'); }
  });
  app.delete('/api/kanban/cards/:cid/checklist/:iid', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      await dbRun('DELETE FROM card_checklist WHERE id = $1 AND card_id = $2', [req.params.iid, x.card.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not delete item'); }
  });

  // ---- comments ----
  app.post('/api/kanban/cards/:cid/comments', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      const body = String((req.body && req.body.body) || '').trim().slice(0, 2000);
      if (!body) return res.status(400).json({ error: 'Comment cannot be empty' });
      const id = genId('CMT');
      await dbRun('INSERT INTO card_comments (id, card_id, user_id, user_name, body, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, x.card.id, req.session.user.id, req.session.user.name, body, nowISO()]);
      res.json({ id });
    } catch (e) { fail(res, e, 'Could not add comment'); }
  });
  app.delete('/api/kanban/cards/:cid/comments/:mid', async (req, res) => {
    try {
      const x = await needCard(req, res); if (!x) return;
      const cm = await dbGet('SELECT user_id FROM card_comments WHERE id = $1 AND card_id = $2', [req.params.mid, x.card.id]);
      if (!cm) return res.json({ ok: true });
      if (cm.user_id !== req.session.user.id && x.role !== 'owner') return res.status(403).json({ error: 'You can only delete your own comments' });
      await dbRun('DELETE FROM card_comments WHERE id = $1', [req.params.mid]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not delete comment'); }
  });

  // ---- attachments (stored in the database; images / PDF up to 3 MB) ----
  app.post('/api/kanban/cards/:cid/attachments', (req, res) => {
    attachUpload.single('file')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (3 MB maximum)' : err.message });
      try {
        const x = await needCard(req, res); if (!x) return;
        if (!req.file) return res.status(400).json({ error: 'No file received' });
        const n = await dbGet('SELECT COUNT(*) AS c FROM card_attachments WHERE card_id = $1', [x.card.id]);
        if (parseInt(n.c, 10) >= MAX_ATTACH_PER_CARD) return res.status(400).json({ error: 'A card can hold up to ' + MAX_ATTACH_PER_CARD + ' attachments' });
        const id = genId('ATT');
        await dbRun('INSERT INTO card_attachments (id, card_id, filename, mime_type, size, data, uploaded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, x.card.id, String(req.file.originalname || 'file').slice(0, 160), req.file.mimetype, req.file.size, req.file.buffer, req.session.user.id, nowISO()]);
        res.json({ id });
      } catch (e) { fail(res, e, 'Could not attach file'); }
    });
  });
  app.get('/api/kanban/attachments/:aid', async (req, res) => {
    try {
      const a = await dbGet('SELECT * FROM card_attachments WHERE id = $1', [req.params.aid]);
      if (!a) return res.status(404).json({ error: 'Attachment not found' });
      const x = await cardWithAccess(req, a.card_id);
      if (!x) return res.status(404).json({ error: 'Attachment not found' });
      res.set('Content-Type', a.mime_type || 'application/octet-stream');
      res.set('Content-Disposition', 'inline; filename="' + String(a.filename).replace(/[^\w.\- ]/g, '_') + '"');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(a.data);
    } catch (e) { fail(res, e, 'Could not load attachment'); }
  });
  app.delete('/api/kanban/attachments/:aid', async (req, res) => {
    try {
      const a = await dbGet('SELECT card_id FROM card_attachments WHERE id = $1', [req.params.aid]);
      if (!a) return res.json({ ok: true });
      const x = await cardWithAccess(req, a.card_id);
      if (!x) return res.status(404).json({ error: 'Attachment not found' });
      await dbRun('DELETE FROM card_attachments WHERE id = $1', [req.params.aid]);
      await dbRun('UPDATE board_cards SET cover_attachment_id = NULL WHERE id = $1 AND cover_attachment_id = $2', [a.card_id, req.params.aid]);
      res.json({ ok: true });
    } catch (e) { fail(res, e, 'Could not delete attachment'); }
  });
};
