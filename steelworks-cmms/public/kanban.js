// ============ KANBAN BOARDS ============
// Trello-style boards for tracking projects and maintenance work. Depends on
// helpers from app.js (apiGet/apiPost/apiPut/apiDelete, escapeHtml, showToast,
// switchView, switchToRawView, machinesCache, loadMachinesCache, sortMachines,
// openMachineDetail, openLogDetail, currentUser).
(function(){
const KB = {
  boards: [], board: null, columns: [], cards: [], members: [], labels: [],
  users: null, filter: { q:'', mine:false, label:'' }, modalEl: null, modalPushed: false, dirty: false, openCardId: null
};
const COLORS = ['#0B2545','#2f7fd1','#2e9e6b','#e0a526','#d16b2f','#d64545','#8e5bd1','#4b5563'];
const PRIORITY_CLASS = { Low:'p-low', Medium:'p-med', High:'p-high', Urgent:'p-urg' };
const $ = (id) => document.getElementById(id);
const esc = (s) => escapeHtml(s == null ? '' : String(s));
const initials = (name) => String(name||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase() || '?';
const isOwner = () => KB.board && KB.board.myRole === 'owner';
const todayStr = () => new Date().toISOString().slice(0,10);
function fmtD(d){ try{ return fmtDate(d); }catch(e){ return d; } }
function colorFor(id){ let h=0; for(const ch of String(id)) h=(h*31+ch.charCodeAt(0))>>>0; return COLORS[h%COLORS.length]; }
function avatar(m, size){
  return `<span class="kb-avatar" title="${esc(m.name)}" style="background:${colorFor(m.id)};${size?`width:${size}px;height:${size}px;font-size:${Math.round(size*0.42)}px;`:''}">${esc(initials(m.name))}</span>`;
}
async function ensureUsers(){
  if(!KB.users){ try{ KB.users = await apiGet('/kanban/users'); }catch(e){ KB.users = []; } }
  return KB.users;
}

// ---------- modal ----------
function openModal(html, cls){
  closeModal(true);
  const el = document.createElement('div');
  el.className = 'kb-overlay';
  el.innerHTML = `<div class="kb-modal ${cls||''}" role="dialog" aria-modal="true"><button type="button" class="kb-modal-x" aria-label="Close" data-kb-close>&times;</button>${html}</div>`;
  el.addEventListener('mousedown', (e)=>{ if(e.target === el) closeModal(); });
  el.addEventListener('click', (e)=>{ if(e.target.closest('[data-kb-close]')) closeModal(); });
  document.body.appendChild(el);
  document.body.classList.add('kb-modal-open');
  KB.modalEl = el;
  // A history entry so the phone Back button closes the pop-up, not the board.
  history.pushState({ orbView:'kanban-modal', id: KB.board ? KB.board.id : null }, '', location.pathname + location.search + '#kanban-modal');
  KB.modalPushed = true;
  return el.firstElementChild;
}
function underlyingState(){
  const boardActive = $('view-kanban-board') && $('view-kanban-board').classList.contains('active') && KB.board;
  return boardActive ? { orbView:'kanban-board', id: KB.board.id } : { orbView:'kanban', id:null };
}
function closeModal(silent){
  if(!KB.modalEl) return;
  KB.modalEl.remove(); KB.modalEl = null;
  document.body.classList.remove('kb-modal-open');
  if(KB.modalPushed){
    KB.modalPushed = false;
    if(history.state && history.state.orbView === 'kanban-modal'){
      if(!silent){ window.kbSuppressPop = true; history.back(); }
      else { const u = underlyingState(); history.replaceState(u, '', location.pathname + location.search + '#' + u.orbView + (u.id ? '/' + u.id : '')); }
    }
  }
  if(!silent && KB.dirty && KB.board){ KB.dirty = false; refreshBoard(); }
  KB.openCardId = null;
}
window.kbModalOpen = () => !!KB.modalEl;
window.addEventListener('popstate', ()=>{
  if(KB.modalEl){
    // Back pressed while a pop-up is open: close it, stay on the board.
    KB.modalEl.remove(); KB.modalEl = null; KB.modalPushed = false; KB.openCardId = null;
    document.body.classList.remove('kb-modal-open');
    if(KB.dirty && KB.board){ KB.dirty = false; refreshBoard(); }
  }
});
document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape' && KB.modalEl) closeModal(); });

async function guarded(fn){
  try{ return await fn(); }catch(e){ if(e.message !== 'Session expired') showToast(e.message || 'Something went wrong'); return null; }
}

// ======================================================
// BOARD LIST
// ======================================================
async function loadKanbanBoards(){
  const grid = $('kbBoardGrid');
  if(!grid) return;
  grid.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
  const boards = await guarded(()=>apiGet('/kanban/boards'));
  if(!boards) { grid.innerHTML = '<div class="empty-state">Could not load boards.</div>'; return; }
  KB.boards = boards;
  const tiles = boards.map(b=>{
    const pct = b.totalCards ? Math.round(b.doneCards / b.totalCards * 100) : 0;
    return `
    <div class="kb-board-tile" onclick="kbOpenBoard('${b.id}')" style="--bc:${esc(b.color)};">
      <div class="kb-board-tile-bar"></div>
      <div class="kb-board-tile-body">
        <div class="kb-board-tile-name">${esc(b.name)}</div>
        <div class="kb-board-tile-desc">${esc(b.description) || '<span style="opacity:.6">No description</span>'}</div>
        <div class="kb-progress"><span style="width:${pct}%"></span></div>
        <div class="kb-board-tile-stats">
          <span>${b.doneCards}/${b.totalCards} done</span>
          ${b.overdueCards ? `<span class="kb-overdue-pill">${b.overdueCards} overdue</span>` : ''}
          ${!b.isMember ? '<span class="kb-view-pill">Admin view</span>' : ''}
        </div>
        <div class="kb-avatars">${b.members.slice(0,6).map(m=>avatar(m,26)).join('')}${b.members.length>6?`<span class="kb-avatar more">+${b.members.length-6}</span>`:''}</div>
      </div>
    </div>`;
  }).join('');
  grid.innerHTML = tiles + `<button type="button" class="kb-board-tile kb-board-new" onclick="kbNewBoard()"><span>+</span>Create new board</button>`;
}
window.loadKanbanBoards = loadKanbanBoards;

async function kbNewBoard(){
  const users = (await ensureUsers()).filter(u=>u.id !== currentUser.id);
  let color = COLORS[0];
  const m = openModal(`
    <h3 class="kb-modal-title">New board</h3>
    <label class="kb-label">Board name</label>
    <input id="kbNbName" class="kb-input" maxlength="120" placeholder="e.g. Crane Bay 11 power upgrade">
    <label class="kb-label">Description (optional)</label>
    <textarea id="kbNbDesc" class="kb-input" rows="2" maxlength="1000"></textarea>
    <label class="kb-label">Start with</label>
    <select id="kbNbTpl" class="kb-input">
      <option value="maintenance">Maintenance: To Do, In Progress, Waiting for Parts, Done</option>
      <option value="project">Project: Backlog, Planned, In Progress, Review, Done</option>
      <option value="blank">Blank: To Do, Done</option>
    </select>
    <label class="kb-label">Colour</label>
    <div class="kb-swatches" id="kbNbColors">${COLORS.map((c,i)=>`<button type="button" class="kb-swatch ${i===0?'on':''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
    <label class="kb-label">Add team members</label>
    <div class="kb-member-pick">${users.length ? users.map(u=>`<label class="kb-check-row"><input type="checkbox" value="${u.id}"> ${avatar(u,22)} <span>${esc(u.name)}</span> <small>${esc(u.role)}</small></label>`).join('') : '<div class="hint">No other users yet. You can add members later.</div>'}</div>
    <div class="kb-modal-actions"><button class="btn-ghost" data-kb-close>Cancel</button><button class="btn-primary" id="kbNbCreate">Create board</button></div>`);
  m.querySelector('#kbNbColors').addEventListener('click',(e)=>{
    const b = e.target.closest('.kb-swatch'); if(!b) return;
    color = b.dataset.c; m.querySelectorAll('.kb-swatch').forEach(s=>s.classList.toggle('on', s===b));
  });
  m.querySelector('#kbNbCreate').addEventListener('click', async ()=>{
    const name = m.querySelector('#kbNbName').value.trim();
    if(!name){ showToast('Give the board a name'); return; }
    const memberIds = [...m.querySelectorAll('.kb-member-pick input:checked')].map(i=>i.value);
    const r = await guarded(()=>apiPost('/kanban/boards',{ name, description:m.querySelector('#kbNbDesc').value, template:m.querySelector('#kbNbTpl').value, color, memberIds }));
    if(r){ closeModal(true); kbOpenBoard(r.id); }
  });
  setTimeout(()=>m.querySelector('#kbNbName').focus(), 50);
}
window.kbNewBoard = kbNewBoard;

// ======================================================
// BOARD
// ======================================================
function kbOpenBoard(id){ return openKanbanBoard(id); }
window.kbOpenBoard = kbOpenBoard;

async function openKanbanBoard(id){
  switchToRawView('kanban-board', id);
  KB.filter = { q:'', mine:false, label:'' };
  const area = $('kbBoardArea');
  area.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
  const ok = await loadBoardData(id);
  if(!ok){ area.innerHTML = '<div class="empty-state">This board is not available.<br><button class="btn-ghost" onclick="switchView(\'kanban\')" style="margin-top:12px;">Back to boards</button></div>'; return; }
  renderBoard();
}
window.openKanbanBoard = openKanbanBoard;

async function loadBoardData(id){
  const d = await guarded(()=>apiGet('/kanban/boards/'+id));
  if(!d) return false;
  KB.board = d.board; KB.columns = d.columns; KB.cards = d.cards; KB.members = d.members; KB.labels = d.board.labels || [];
  return true;
}
async function refreshBoard(){
  if(!KB.board) return;
  const scroller = $('kbColumns'); const sx = scroller ? scroller.scrollLeft : 0;
  const bodies = [...document.querySelectorAll('.kb-col-body')].map(b=>b.scrollTop);
  if(await loadBoardData(KB.board.id)){
    renderBoard();
    const s2 = $('kbColumns'); if(s2) s2.scrollLeft = sx;
    document.querySelectorAll('.kb-col-body').forEach((b,i)=>{ if(bodies[i]) b.scrollTop = bodies[i]; });
  }
}

function cardMatches(c){
  const f = KB.filter;
  if(f.mine && !c.assigneeIds.includes(currentUser.id)) return false;
  if(f.label && !c.labelIds.includes(f.label)) return false;
  if(f.q){
    const q = f.q.toLowerCase();
    if(!(c.title.toLowerCase().includes(q) || (c.description||'').toLowerCase().includes(q) || (c.machineCode||'').toLowerCase().includes(q))) return false;
  }
  return true;
}

function renderBoard(){
  const b = KB.board;
  const area = $('kbBoardArea');
  const total = KB.cards.length, done = KB.cards.filter(c=>c.done).length;
  area.innerHTML = `
    <div class="kb-board-head" style="--bc:${esc(b.color)}">
      <button class="btn-ghost small" onclick="switchView('kanban')">&larr; Boards</button>
      <div class="kb-board-title"><h2>${esc(b.name)}</h2><span class="kb-board-sub">${done}/${total} done${b.description?' &middot; '+esc(b.description):''}</span></div>
      <div class="kb-head-actions">
        <div class="kb-avatars" onclick="kbMembers()" title="Members" style="cursor:pointer">${KB.members.slice(0,5).map(m=>avatar(m,28)).join('')}${KB.members.length>5?`<span class="kb-avatar more">+${KB.members.length-5}</span>`:''}</div>
        <button class="btn-ghost small" onclick="kbMembers()">Members</button>
        <button class="btn-ghost small" onclick="kbFromCmms()">+ From CMMS</button>
        ${isOwner()?'<button class="btn-ghost small" onclick="kbSettings()">Settings</button>':''}
      </div>
    </div>
    <div class="kb-filters">
      <input id="kbSearch" class="kb-input kb-search" placeholder="Search cards or machine code" value="${esc(KB.filter.q)}">
      <label class="kb-check-row kb-mine"><input type="checkbox" id="kbMine" ${KB.filter.mine?'checked':''}> My cards</label>
      <select id="kbLabelFilter" class="kb-input kb-lblsel"><option value="">All labels</option>${KB.labels.map(l=>`<option value="${esc(l.id)}" ${KB.filter.label===l.id?'selected':''}>${esc(l.name)}</option>`).join('')}</select>
    </div>
    <div class="kb-columns" id="kbColumns">
      ${KB.columns.map((col,i)=>renderColumn(col,i)).join('')}
      ${isOwner()?`<div class="kb-col kb-col-new"><button type="button" class="kb-add-col" onclick="kbAddColumn()">+ Add column</button></div>`:''}
    </div>`;
  $('kbSearch').addEventListener('input',(e)=>{ KB.filter.q = e.target.value; rerenderColumnsOnly(); });
  $('kbMine').addEventListener('change',(e)=>{ KB.filter.mine = e.target.checked; rerenderColumnsOnly(); });
  $('kbLabelFilter').addEventListener('change',(e)=>{ KB.filter.label = e.target.value; rerenderColumnsOnly(); });
  bindDrag();
}
function rerenderColumnsOnly(){
  const sc = $('kbColumns'); const sx = sc.scrollLeft;
  sc.innerHTML = KB.columns.map((col,i)=>renderColumn(col,i)).join('') + (isOwner()?`<div class="kb-col kb-col-new"><button type="button" class="kb-add-col" onclick="kbAddColumn()">+ Add column</button></div>`:'');
  sc.scrollLeft = sx;
}

function renderColumn(col, idx){
  const cards = KB.cards.filter(c=>c.columnId===col.id).sort((a,b)=>a.position-b.position);
  const shown = cards.filter(cardMatches);
  return `
  <div class="kb-col" data-col="${col.id}">
    <div class="kb-col-head">
      <span class="kb-col-name">${esc(col.name)}${col.isDone?' <span class="kb-donetag" title="Cards moved here are marked done">&#10003;</span>':''}</span>
      <span class="kb-col-count">${shown.length}${shown.length!==cards.length?'/'+cards.length:''}</span>
      ${isOwner()?`<button type="button" class="kb-col-menu" onclick="kbColumnMenu('${col.id}')" aria-label="Column options">&#8943;</button>`:''}
    </div>
    <div class="kb-col-body" data-col="${col.id}">
      ${shown.map(cardHtml).join('')}
    </div>
    <div class="kb-col-foot">
      <button type="button" class="kb-add-card" onclick="kbAddCard('${col.id}', this)">+ Add a card</button>
    </div>
  </div>`;
}

function cardHtml(c){
  const lbls = c.labelIds.map(id=>KB.labels.find(l=>l.id===id)).filter(Boolean);
  const asg = c.assigneeIds.map(id=>KB.members.find(m=>m.id===id)).filter(Boolean);
  const overdue = c.dueDate && !c.done && c.dueDate < todayStr();
  const dueSoon = c.dueDate && !c.done && !overdue && c.dueDate <= addDaysStr(todayStr(), 2);
  return `
  <div class="kb-card ${c.done?'is-done':''}" data-card="${c.id}">
    ${lbls.length?`<div class="kb-card-labels">${lbls.map(l=>`<span style="background:${esc(l.color)}" title="${esc(l.name)}">${esc(l.name)}</span>`).join('')}</div>`:''}
    <div class="kb-card-main">
      <input type="checkbox" class="kb-card-check" data-done="${c.id}" ${c.done?'checked':''} aria-label="Mark done">
      <div class="kb-card-title">${esc(c.title)}</div>
    </div>
    <div class="kb-card-meta">
      ${c.priority?`<span class="kb-prio ${PRIORITY_CLASS[c.priority]||''}">${esc(c.priority)}</span>`:''}
      ${c.dueDate?`<span class="kb-due ${overdue?'late':dueSoon?'soon':''}" title="Due date">&#128197; ${esc(fmtD(c.dueDate))}</span>`:''}
      ${c.machineCode?`<span class="kb-chip" title="${esc(c.machineName)}">&#128736; ${esc(c.machineCode)}</span>`:''}
      ${c.logId?'<span class="kb-chip" title="Linked to a maintenance log">&#128196; Log</span>':''}
      ${c.checklistTotal?`<span class="kb-chip ${c.checklistDone===c.checklistTotal?'ok':''}">&#9745; ${c.checklistDone}/${c.checklistTotal}</span>`:''}
      ${c.commentCount?`<span class="kb-chip">&#128172; ${c.commentCount}</span>`:''}
      ${c.attachmentCount?`<span class="kb-chip">&#128206; ${c.attachmentCount}</span>`:''}
      <span class="kb-card-asg">${asg.slice(0,3).map(m=>avatar(m,24)).join('')}${asg.length>3?`<span class="kb-avatar more" style="width:24px;height:24px">+${asg.length-3}</span>`:''}</span>
    </div>
  </div>`;
}
function addDaysStr(d, n){ const x = new Date(d+'T00:00:00Z'); x.setUTCDate(x.getUTCDate()+n); return x.toISOString().slice(0,10); }

// ---------- add card / column ----------
function kbAddCard(columnId, btn){
  const foot = btn.parentElement;
  foot.innerHTML = `<textarea class="kb-input kb-newcard" rows="2" maxlength="200" placeholder="Card title&hellip;"></textarea>
    <div class="kb-newcard-actions"><button class="btn-primary small">Add</button><button type="button" class="btn-ghost small kb-x">Cancel</button></div>`;
  const ta = foot.querySelector('textarea');
  ta.focus();
  const reset = ()=>{ foot.innerHTML = `<button type="button" class="kb-add-card" onclick="kbAddCard('${columnId}', this)">+ Add a card</button>`; };
  const submit = async ()=>{
    const title = ta.value.trim(); if(!title){ reset(); return; }
    const r = await guarded(()=>apiPost('/kanban/boards/'+KB.board.id+'/cards',{ columnId, title }));
    if(r) await refreshBoard();
  };
  foot.querySelector('.btn-primary').addEventListener('click', submit);
  foot.querySelector('.kb-x').addEventListener('click', reset);
  ta.addEventListener('keydown',(e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); submit(); } if(e.key==='Escape') reset(); });
}
window.kbAddCard = kbAddCard;

async function kbAddColumn(){
  const name = prompt('Column name');
  if(!name || !name.trim()) return;
  const r = await guarded(()=>apiPost('/kanban/boards/'+KB.board.id+'/columns',{ name }));
  if(r) refreshBoard();
}
window.kbAddColumn = kbAddColumn;

function kbColumnMenu(colId){
  const col = KB.columns.find(c=>c.id===colId); if(!col) return;
  const idx = KB.columns.findIndex(c=>c.id===colId);
  const m = openModal(`
    <h3 class="kb-modal-title">Column: ${esc(col.name)}</h3>
    <label class="kb-label">Name</label>
    <input id="kbColName" class="kb-input" value="${esc(col.name)}" maxlength="60">
    <label class="kb-check-row" style="margin:12px 0"><input type="checkbox" id="kbColDone" ${col.isDone?'checked':''}> Cards moved into this column are marked done</label>
    <div class="kb-modal-actions" style="justify-content:flex-start;gap:8px;flex-wrap:wrap">
      <button class="btn-ghost small" id="kbColLeft" ${idx===0?'disabled':''}>&larr; Move left</button>
      <button class="btn-ghost small" id="kbColRight" ${idx===KB.columns.length-1?'disabled':''}>Move right &rarr;</button>
    </div>
    <div class="kb-modal-actions"><button class="btn-ghost kb-danger" id="kbColDel">Delete column</button><span style="flex:1"></span><button class="btn-primary" id="kbColSave">Save</button></div>`);
  const reorder = async (dir)=>{
    const ids = KB.columns.map(c=>c.id); const j = idx+dir; [ids[idx], ids[j]] = [ids[j], ids[idx]];
    const r = await guarded(()=>apiPut('/kanban/boards/'+KB.board.id+'/columns/reorder',{ ids }));
    if(r){ closeModal(); await refreshBoard(); }
  };
  m.querySelector('#kbColLeft').onclick = ()=>reorder(-1);
  m.querySelector('#kbColRight').onclick = ()=>reorder(1);
  m.querySelector('#kbColSave').onclick = async ()=>{
    const r = await guarded(()=>apiPut('/kanban/boards/'+KB.board.id+'/columns/'+colId,{ name:m.querySelector('#kbColName').value, isDone:m.querySelector('#kbColDone').checked }));
    if(r){ closeModal(); await refreshBoard(); }
  };
  m.querySelector('#kbColDel').onclick = async ()=>{
    if(!confirm('Delete the column "'+col.name+'"?')) return;
    const r = await guarded(()=>apiDelete('/kanban/boards/'+KB.board.id+'/columns/'+colId));
    if(r){ closeModal(); await refreshBoard(); }
  };
}
window.kbColumnMenu = kbColumnMenu;

// ======================================================
// DRAG AND DROP (pointer based: works with mouse and touch)
// ======================================================
let dragSt = null;
let dragDocBound = false;
const HOLD_MS = 220;
function bindDrag(){
  const root = $('kbColumns'); if(!root) return;

  root.addEventListener('click', async (e)=>{
    if(window.__kbJustDragged){ return; }
    const chk = e.target.closest('.kb-card-check');
    if(chk){
      e.stopPropagation();
      const id = chk.dataset.done; const done = chk.checked;
      const r = await guarded(()=>apiPut('/kanban/cards/'+id,{ done }));
      if(r) refreshBoard(); else chk.checked = !done;
      return;
    }
    const card = e.target.closest('.kb-card');
    if(card) openCard(card.dataset.card);
  });

  root.addEventListener('pointerdown', (e)=>{
    if(e.button !== undefined && e.button !== 0) return;
    if(e.target.closest('.kb-card-check') || e.target.closest('.kb-col-menu')) return;
    let card = e.target.closest('.kb-card');
    let colHead = null;
    if(!card && isOwner()){
      const h = e.target.closest('.kb-col-head');
      if(h) colHead = h.closest('.kb-col');
    }
    if(!card && !colHead) return;
    dragSt = { card: card || colHead, isCol: !!colHead, id:e.pointerId, x0:e.clientX, y0:e.clientY, touch: e.pointerType === 'touch', dragging:false, timer:null, ghost:null, ph:null };
    if(dragSt.touch){
      const mine = dragSt;
      dragSt.timer = setTimeout(()=>{ if(dragSt === mine && !mine.dragging) startDrag(e.clientX, e.clientY); }, HOLD_MS);
    }
  });

  if(dragDocBound) return;
  dragDocBound = true;
  document.addEventListener('pointermove', onMove, { passive:true });
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', cancel);
  // Once a drag has begun the page must not scroll under the finger.
  document.addEventListener('touchmove', (e)=>{ if(dragSt && dragSt.dragging && e.cancelable) e.preventDefault(); }, { passive:false });
}
function startDrag(x, y){
  const st = dragSt; if(!st) return;
  st.dragging = true;
  const r = st.card.getBoundingClientRect();
  st.ox = x - r.left; st.oy = y - r.top;
  const ghost = st.card.cloneNode(true);
  ghost.classList.add('kb-ghost');
  ghost.style.width = r.width + 'px';
  document.body.appendChild(ghost);
  st.ghost = ghost;
  const ph = document.createElement('div'); ph.className = 'kb-placeholder';
  if(st.isCol){ ph.classList.add('kb-col-ph'); ph.style.width = r.width + 'px'; ph.style.height = Math.min(r.height, 140) + 'px'; ghost.classList.add('kb-ghost-col'); }
  else ph.style.height = r.height + 'px';
  st.card.parentNode.insertBefore(ph, st.card);
  st.card.style.display = 'none';
  st.ph = ph;
  if(navigator.vibrate) try{ navigator.vibrate(12); }catch(e){}
  const sc0 = $('kbColumns'); if(sc0) sc0.classList.add('kb-dragging'); // snap points would fight the auto-scroll
  place(x, y);
}
function placeColumn(x, y){
  const st = dragSt;
  const sc = $('kbColumns');
  const others = [...sc.querySelectorAll('.kb-col[data-col]')].filter(c=>c!==st.card);
  let before = null;
  for(const c of others){ const r = c.getBoundingClientRect(); if(x < r.left + r.width/2){ before = c; break; } }
  if(before) sc.insertBefore(st.ph, before);
  else { const add = sc.querySelector('.kb-col-new'); if(add) sc.insertBefore(st.ph, add); else sc.appendChild(st.ph); }
  const sr = sc.getBoundingClientRect();
  st.scrollDir = x < sr.left + 50 ? -1 : (x > sr.right - 50 ? 1 : 0);
  if(st.scrollDir && !st.raf){
    const tick = ()=>{ if(!dragSt || !dragSt.dragging || !dragSt.scrollDir){ if(dragSt) dragSt.raf = null; return; } sc.scrollLeft += dragSt.scrollDir * 14; dragSt.raf = requestAnimationFrame(tick); };
    st.raf = requestAnimationFrame(tick);
  }
}
function place(x, y){
  const st = dragSt; if(!st) return;
  st.ghost.style.left = (x - st.ox) + 'px'; st.ghost.style.top = (y - st.oy) + 'px';
  if(st.isCol){ placeColumn(x, y); return; }
  st.ghost.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y);
  st.ghost.style.visibility = '';
  const hit = el && el.closest ? el.closest('.kb-col') : null;
  const target = hit ? hit.querySelector('.kb-col-body') : null;
  if(target){
    const cards = [...target.querySelectorAll('.kb-card')].filter(c=>c!==st.card);
    let before = null;
    for(const c of cards){ const rr = c.getBoundingClientRect(); if(y < rr.top + rr.height/2){ before = c; break; } }
    if(before) target.insertBefore(st.ph, before); else target.appendChild(st.ph);
  }
  const sc = $('kbColumns'); const sr = sc.getBoundingClientRect();
  st.scrollDir = x < sr.left + 50 ? -1 : (x > sr.right - 50 ? 1 : 0);
  if(st.scrollDir && !st.raf){
    const tick = ()=>{ if(!dragSt || !dragSt.dragging || !dragSt.scrollDir){ if(dragSt) dragSt.raf = null; return; } sc.scrollLeft += dragSt.scrollDir * 14; dragSt.raf = requestAnimationFrame(tick); };
    st.raf = requestAnimationFrame(tick);
  }
}
function onMove(e){
  const st = dragSt;
  if(!st || e.pointerId !== st.id) return;
  const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
  if(!st.dragging){
    const moved = Math.hypot(dx, dy);
    if(st.touch){ if(moved > 9){ clearTimeout(st.timer); dragSt = null; } return; } // finger moved first: it's a scroll
    if(moved > 5) startDrag(e.clientX, e.clientY);
    return;
  }
  place(e.clientX, e.clientY);
}
async function onUp(e){
  const s = dragSt;
  if(!s || e.pointerId !== s.id) return;
  clearTimeout(s.timer);
  if(!s.dragging){ dragSt = null; return; }
  dragSt = null;
  cancelAnimationFrame(s.raf);
  { const sc1 = $('kbColumns'); if(sc1) sc1.classList.remove('kb-dragging'); }
  if(s.isCol){
    const sc = $('kbColumns');
    const order = [];
    [...sc.children].forEach(n=>{ if(n===s.ph) order.push(s.card.dataset.col); else if(n!==s.card && n.dataset && n.dataset.col) order.push(n.dataset.col); });
    s.ghost.remove(); s.ph.remove(); s.card.style.display = '';
    window.__kbJustDragged = true; setTimeout(()=>{ window.__kbJustDragged = false; }, 80);
    const cur = KB.columns.map(c=>c.id);
    if(order.length === cur.length && order.join() !== cur.join()){
      await guarded(()=>apiPut('/kanban/boards/'+KB.board.id+'/columns/reorder',{ ids: order }));
    }
    refreshBoard();
    return;
  }
  const colEl = s.ph.closest('.kb-col-body');
  const columnId = colEl ? colEl.dataset.col : null;
  const index = colEl ? [...colEl.children].filter(n=>n.classList.contains('kb-card') || n===s.ph).indexOf(s.ph) : 0;
  s.ghost.remove(); s.ph.remove(); s.card.style.display = '';
  window.__kbJustDragged = true; setTimeout(()=>{ window.__kbJustDragged = false; }, 80);
  if(columnId){
    const cid = s.card.dataset.card;
    const cur = KB.cards.find(c=>c.id===cid);
    const filtered = KB.filter.q || KB.filter.mine || KB.filter.label;
    const idx = filtered ? 9999 : index;
    const origIdx = cur ? KB.cards.filter(c=>c.columnId===cur.columnId).sort((a,b)=>a.position-b.position).findIndex(c=>c.id===cid) : -1;
    if(cur && (cur.columnId !== columnId || filtered || origIdx !== index)){
      await guarded(()=>apiPost('/kanban/cards/'+cid+'/move',{ columnId, index: idx }));
    }
  }
  refreshBoard();
}
function cancel(){
  const st = dragSt; if(!st) return;
  clearTimeout(st.timer);
  { const sc2 = $('kbColumns'); if(sc2) sc2.classList.remove('kb-dragging'); }
  if(st.dragging){ cancelAnimationFrame(st.raf); st.ghost.remove(); st.ph.remove(); st.card.style.display = ''; }
  dragSt = null;
}

// ======================================================
// CARD DETAIL
// ======================================================
async function openCard(cardId){
  const d = await guarded(()=>apiGet('/kanban/cards/'+cardId));
  if(!d) return;
  if(!machinesCache || !machinesCache.length) await loadMachinesCache();
  KB.openCardId = cardId;
  renderCard(d, true);
}
window.kbOpenCard = openCard;

function renderCard(d, fresh){
  const c = d.card;
  const col = KB.columns.find(x=>x.id===c.columnId);
  const doneItems = d.checklist.filter(i=>i.done).length;
  const pct = d.checklist.length ? Math.round(doneItems/d.checklist.length*100) : 0;
  const machines = sortMachines(machinesCache || []);
  const html = `
    <div class="kb-card-modal">
      <div class="kb-cm-head">
        <input type="checkbox" id="kbCmDone" ${c.done?'checked':''} aria-label="Mark done" class="kb-big-check">
        <input id="kbCmTitle" class="kb-cm-title" value="${esc(c.title)}" maxlength="200">
      </div>
      <div class="kb-cm-sub">in column <b>${esc(col?col.name:'')}</b>${c.done&&c.completedAt?` &middot; completed ${esc(fmtD(c.completedAt.slice(0,10)))}`:''}</div>
      <div class="kb-cm-grid">
        <div>
          <label class="kb-label">Move to column</label>
          <select id="kbCmCol" class="kb-input">${KB.columns.map(x=>`<option value="${x.id}" ${x.id===c.columnId?'selected':''}>${esc(x.name)}</option>`).join('')}</select>
        </div>
        <div>
          <label class="kb-label">Priority</label>
          <select id="kbCmPrio" class="kb-input"><option value="">None</option>${['Low','Medium','High','Urgent'].map(p=>`<option ${c.priority===p?'selected':''}>${p}</option>`).join('')}</select>
        </div>
        <div>
          <label class="kb-label">Due date</label>
          <input type="date" id="kbCmDue" class="kb-input" value="${esc(c.dueDate)}">
        </div>
        <div>
          <label class="kb-label">Machine</label>
          <select id="kbCmMachine" class="kb-input"><option value="">None</option>${machineOptions(machines, c.machineId)}</select>
        </div>
      </div>
      ${d.machine || d.log ? `<div class="kb-links">
        ${d.machine?`<button type="button" class="kb-linkbtn" id="kbOpenMachine">&#128736; Open ${esc(d.machine.code)}</button>`:''}
        ${d.log?`<button type="button" class="kb-linkbtn" id="kbOpenLog">&#128196; Linked log (${esc(d.log.status)}): ${esc((d.log.findings||'').slice(0,60))}</button>`:''}
      </div>`:''}
      <label class="kb-label">Assigned to</label>
      <div class="kb-pills" id="kbCmAsg">${KB.members.map(m=>`<button type="button" class="kb-pill ${c.assigneeIds.includes(m.id)?'on':''}" data-id="${m.id}">${avatar(m,20)} ${esc(m.name)}</button>`).join('')}</div>
      <label class="kb-label">Labels</label>
      <div class="kb-pills" id="kbCmLbl">${KB.labels.length?KB.labels.map(l=>`<button type="button" class="kb-pill kb-lbl ${c.labelIds.includes(l.id)?'on':''}" data-id="${esc(l.id)}" style="--lc:${esc(l.color)}">${esc(l.name)}</button>`).join(''):'<span class="hint">No labels on this board.</span>'}</div>
      <label class="kb-label">Description</label>
      <textarea id="kbCmDesc" class="kb-input" rows="3" maxlength="5000" placeholder="Add more detail&hellip;">${esc(c.description)}</textarea>

      <label class="kb-label">Checklist ${d.checklist.length?`<span class="kb-muted">${doneItems}/${d.checklist.length}</span>`:''}</label>
      ${d.checklist.length?`<div class="kb-progress"><span style="width:${pct}%"></span></div>`:''}
      <div class="kb-checklist">${d.checklist.map(i=>`
        <div class="kb-cl-row ${i.done?'done':''}"><input type="checkbox" data-cl="${i.id}" ${i.done?'checked':''}><span class="kb-cl-text">${esc(i.text)}</span><button type="button" class="kb-icon-btn" data-cldel="${i.id}" aria-label="Delete item">&times;</button></div>`).join('')}</div>
      <div class="kb-inline-add"><input id="kbClNew" class="kb-input" maxlength="300" placeholder="Add an item"><button class="btn-ghost small" id="kbClAdd">Add</button></div>

      <label class="kb-label">Attachments</label>
      <div class="kb-attachments">${d.attachments.map(a=>`
        <div class="kb-att">
          ${/^image\//.test(a.mimeType)?`<a href="/api/kanban/attachments/${a.id}" target="_blank" rel="noopener"><img src="/api/kanban/attachments/${a.id}" alt="${esc(a.filename)}"></a>`:`<a class="kb-att-file" href="/api/kanban/attachments/${a.id}" target="_blank" rel="noopener">&#128196;</a>`}
          <div class="kb-att-name" title="${esc(a.filename)}">${esc(a.filename)}</div>
          <button type="button" class="kb-icon-btn" data-attdel="${a.id}" aria-label="Delete attachment">&times;</button>
        </div>`).join('')}</div>
      <div class="kb-inline-add"><input type="file" id="kbAttFile" accept="image/*,application/pdf"><span class="kb-muted">Images or PDF, 3 MB max</span></div>

      <label class="kb-label">Comments</label>
      <div class="kb-comments">${d.comments.map(cm=>`
        <div class="kb-comment">${avatar({id:cm.userId||'x',name:cm.userName||'?'},28)}
          <div><b>${esc(cm.userName)}</b> <span class="kb-muted">${esc(fmtDateTimeShort(cm.createdAt))}</span>
          <div class="kb-comment-body">${esc(cm.body)}</div>
          ${(cm.userId===currentUser.id||isOwner())?`<button type="button" class="kb-link-del" data-cmdel="${cm.id}">Delete</button>`:''}</div>
        </div>`).join('') || '<div class="hint">No comments yet.</div>'}</div>
      <div class="kb-inline-add"><textarea id="kbCmNew" class="kb-input" rows="2" maxlength="2000" placeholder="Write a comment&hellip;"></textarea><button class="btn-primary small" id="kbCmPost">Post</button></div>

      <div class="kb-modal-actions"><button class="btn-ghost kb-danger" id="kbCmDel">Delete card</button><span style="flex:1"></span><button class="btn-primary" data-kb-close>Close</button></div>
    </div>`;
  let m;
  if(fresh || !KB.modalEl){ m = openModal(html, 'kb-modal-wide'); }
  else {
    m = KB.modalEl.firstElementChild;
    const keep = m.scrollTop;
    m.innerHTML = '<button type="button" class="kb-modal-x" aria-label="Close" data-kb-close>&times;</button>' + html;
    m.scrollTop = keep;
  }
  wireCard(m, d);
}
function machineOptions(machines, selectedId){
  let out = '', last = null;
  machines.forEach(mc=>{
    const d = mc.department || 'Other';
    if(d !== last){ if(last !== null) out += '</optgroup>'; out += `<optgroup label="${esc(d)}">`; last = d; }
    out += `<option value="${mc.id}" ${mc.id===selectedId?'selected':''}>${esc(mc.code)} – ${esc(mc.name)}</option>`;
  });
  return out + (last !== null ? '</optgroup>' : '');
}
function fmtDateTimeShort(iso){
  try{ const d = new Date(iso); return d.toLocaleDateString(undefined,{day:'2-digit',month:'short'}) + ' ' + d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; }
}

function wireCard(m, d){
  const c = d.card; const id = c.id;
  const save = async (patch)=>{ const r = await guarded(()=>apiPut('/kanban/cards/'+id, patch)); if(r) KB.dirty = true; return r; };
  const reload = async ()=>{ const nd = await guarded(()=>apiGet('/kanban/cards/'+id)); if(nd) renderCard(nd, false); };
  const q = (s)=>m.querySelector(s);
  q('#kbCmTitle').addEventListener('change', ()=>{ const v = q('#kbCmTitle').value.trim(); if(v) save({ title:v }); else q('#kbCmTitle').value = c.title; });
  q('#kbCmDone').addEventListener('change', async (e)=>{ if(await save({ done:e.target.checked })) reload(); });
  q('#kbCmPrio').addEventListener('change', (e)=>save({ priority:e.target.value }));
  q('#kbCmDue').addEventListener('change', (e)=>save({ dueDate:e.target.value }));
  q('#kbCmDesc').addEventListener('change', (e)=>save({ description:e.target.value }));
  q('#kbCmMachine').addEventListener('change', async (e)=>{ if(await save({ machineId:e.target.value })) reload(); });
  q('#kbCmCol').addEventListener('change', async (e)=>{
    const r = await guarded(()=>apiPost('/kanban/cards/'+id+'/move',{ columnId:e.target.value, index:9999 }));
    if(r){ KB.dirty = true; reload(); }
  });
  q('#kbCmAsg').addEventListener('click', async (e)=>{
    const b = e.target.closest('.kb-pill'); if(!b) return;
    b.classList.toggle('on');
    const ids = [...q('#kbCmAsg').querySelectorAll('.kb-pill.on')].map(x=>x.dataset.id);
    await save({ assigneeIds: ids });
  });
  const lblBox = q('#kbCmLbl');
  if(lblBox) lblBox.addEventListener('click', async (e)=>{
    const b = e.target.closest('.kb-pill'); if(!b) return;
    b.classList.toggle('on');
    await save({ labelIds: [...lblBox.querySelectorAll('.kb-pill.on')].map(x=>x.dataset.id) });
  });
  const om = q('#kbOpenMachine'); if(om) om.onclick = ()=>{ closeModal(true); openMachineDetail(d.machine.id); };
  const ol = q('#kbOpenLog'); if(ol) ol.onclick = ()=>{ closeModal(true); window._logDetailBackView = 'kanban-board'; openLogDetail(d.log.id); };

  // checklist
  m.querySelectorAll('[data-cl]').forEach(cb=>cb.addEventListener('change', async ()=>{ if(await save2('/kanban/cards/'+id+'/checklist/'+cb.dataset.cl, { done:cb.checked })) reload(); }));
  m.querySelectorAll('[data-cldel]').forEach(b=>b.addEventListener('click', async ()=>{ if(await guarded(()=>apiDelete('/kanban/cards/'+id+'/checklist/'+b.dataset.cldel))){ KB.dirty = true; reload(); } }));
  const addCl = async ()=>{
    const t = q('#kbClNew').value.trim(); if(!t) return;
    if(await guarded(()=>apiPost('/kanban/cards/'+id+'/checklist',{ text:t }))){ KB.dirty = true; reload(); }
  };
  q('#kbClAdd').addEventListener('click', addCl);
  q('#kbClNew').addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); addCl(); } });
  async function save2(url, patch){ const r = await guarded(()=>apiPut(url, patch)); if(r) KB.dirty = true; return r; }

  // comments
  q('#kbCmPost').addEventListener('click', async ()=>{
    const t = q('#kbCmNew').value.trim(); if(!t) return;
    if(await guarded(()=>apiPost('/kanban/cards/'+id+'/comments',{ body:t }))){ KB.dirty = true; reload(); }
  });
  m.querySelectorAll('[data-cmdel]').forEach(b=>b.addEventListener('click', async ()=>{ if(await guarded(()=>apiDelete('/kanban/cards/'+id+'/comments/'+b.dataset.cmdel))){ KB.dirty = true; reload(); } }));

  // attachments
  q('#kbAttFile').addEventListener('change', async (e)=>{
    const f = e.target.files[0]; if(!f) return;
    if(f.size > 3*1024*1024){ showToast('File is too large (3 MB maximum)'); e.target.value = ''; return; }
    const fd = new FormData(); fd.append('file', f);
    try{
      const res = await fetch(API+'/kanban/cards/'+id+'/attachments',{ method:'POST', credentials:'same-origin', body:fd });
      await handleApiResponse(res);
      KB.dirty = true; showToast('Attached'); reload();
    }catch(err){ if(err.message!=='Session expired') showToast(err.message); e.target.value = ''; }
  });
  m.querySelectorAll('[data-attdel]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Remove this attachment?')) return;
    if(await guarded(()=>apiDelete('/kanban/attachments/'+b.dataset.attdel))){ KB.dirty = true; reload(); }
  }));

  q('#kbCmDel').addEventListener('click', async ()=>{
    if(!confirm('Delete this card? This cannot be undone.')) return;
    if(await guarded(()=>apiDelete('/kanban/cards/'+id))){ KB.dirty = true; closeModal(); }
  });
}

// ======================================================
// MEMBERS
// ======================================================
async function kbMembers(){
  const users = await ensureUsers();
  const draw = ()=>{
    const m = KB.modalEl && KB.modalEl.firstElementChild;
    const inBoard = new Set(KB.members.map(x=>x.id));
    const addable = users.filter(u=>!inBoard.has(u.id));
    const html = `
      <h3 class="kb-modal-title">Members of ${esc(KB.board.name)}</h3>
      <div class="kb-mem-list">${KB.members.map(x=>`
        <div class="kb-mem-row">${avatar(x,32)}<div class="kb-mem-name">${esc(x.name)}<small>${esc(x.userRole)}</small></div>
          <span class="kb-role-tag ${x.role}">${x.role==='owner'?'Owner':'Member'}</span>
          ${isOwner()?`<button class="btn-ghost small" data-role="${x.id}" data-to="${x.role==='owner'?'member':'owner'}">${x.role==='owner'?'Make member':'Make owner'}</button>
          <button class="btn-ghost small kb-danger" data-rm="${x.id}">Remove</button>`:(x.id===currentUser.id?`<button class="btn-ghost small kb-danger" data-rm="${x.id}">Leave</button>`:'')}
        </div>`).join('')}</div>
      ${isOwner()?`<label class="kb-label">Add a team member</label>
      <div class="kb-inline-add"><select id="kbAddMem" class="kb-input">${addable.length?addable.map(u=>`<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join(''):'<option value="">Everyone is already on this board</option>'}</select><button class="btn-primary small" id="kbAddMemBtn" ${addable.length?'':'disabled'}>Add</button></div>`:''}
      <div class="kb-modal-actions"><button class="btn-primary" data-kb-close>Done</button></div>`;
    if(m){ m.innerHTML = '<button type="button" class="kb-modal-x" aria-label="Close" data-kb-close>&times;</button>' + html; wire(m); }
    else wire(openModal(html));
  };
  const wire = (m)=>{
    const reload = async ()=>{ KB.dirty = true; if(await loadBoardData(KB.board.id)) draw(); };
    m.querySelectorAll('[data-role]').forEach(b=>b.onclick = async ()=>{ if(await guarded(()=>apiPut('/kanban/boards/'+KB.board.id+'/members/'+b.dataset.role,{ role:b.dataset.to }))) reload(); });
    m.querySelectorAll('[data-rm]').forEach(b=>b.onclick = async ()=>{
      const self = b.dataset.rm === currentUser.id;
      if(!confirm(self ? 'Leave this board?' : 'Remove this member from the board?')) return;
      if(await guarded(()=>apiDelete('/kanban/boards/'+KB.board.id+'/members/'+b.dataset.rm))){
        if(self && !isAdminRoleClient()){ closeModal(true); switchView('kanban'); }
        else reload();
      }
    });
    const add = m.querySelector('#kbAddMemBtn');
    if(add) add.onclick = async ()=>{
      const v = m.querySelector('#kbAddMem').value; if(!v) return;
      if(await guarded(()=>apiPost('/kanban/boards/'+KB.board.id+'/members',{ userId:v }))) reload();
    };
  };
  draw();
}
function isAdminRoleClient(){ return currentUser && ['Management','Maintenance HOD'].includes(currentUser.role); }
window.kbMembers = kbMembers;

// ======================================================
// BOARD SETTINGS
// ======================================================
function kbSettings(){
  let color = KB.board.color; let labels = KB.labels.map(l=>({ ...l }));
  const m = openModal('', '');
  const draw = ()=>{
    m.innerHTML = `<button type="button" class="kb-modal-x" aria-label="Close" data-kb-close>&times;</button>
      <h3 class="kb-modal-title">Board settings</h3>
      <label class="kb-label">Name</label><input id="kbStName" class="kb-input" maxlength="120" value="${esc(KB.board.name)}">
      <label class="kb-label">Description</label><textarea id="kbStDesc" class="kb-input" rows="2" maxlength="1000">${esc(KB.board.description)}</textarea>
      <label class="kb-label">Colour</label>
      <div class="kb-swatches">${COLORS.map(c=>`<button type="button" class="kb-swatch ${c===color?'on':''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <label class="kb-label">Labels</label>
      <div id="kbStLabels">${labels.map((l,i)=>`<div class="kb-lbl-row"><input type="color" value="${esc(l.color)}" data-lc="${i}"><input class="kb-input" value="${esc(l.name)}" data-ln="${i}" maxlength="30"><button type="button" class="kb-icon-btn" data-ld="${i}" aria-label="Remove label">&times;</button></div>`).join('')}</div>
      <button type="button" class="btn-ghost small" id="kbStAddLbl">+ Add label</button>
      <div class="kb-modal-actions"><button class="btn-ghost kb-danger" id="kbStDel">Delete board</button><span style="flex:1"></span><button class="btn-primary" id="kbStSave">Save</button></div>`;
    m.querySelectorAll('.kb-swatch').forEach(b=>b.onclick = ()=>{ color = b.dataset.c; m.querySelectorAll('.kb-swatch').forEach(s=>s.classList.toggle('on', s===b)); });
    m.querySelectorAll('[data-ln]').forEach(i=>i.oninput = ()=>{ labels[+i.dataset.ln].name = i.value; });
    m.querySelectorAll('[data-lc]').forEach(i=>i.oninput = ()=>{ labels[+i.dataset.lc].color = i.value; });
    m.querySelectorAll('[data-ld]').forEach(b=>b.onclick = ()=>{ labels.splice(+b.dataset.ld,1); sync(); draw(); });
    m.querySelector('#kbStAddLbl').onclick = ()=>{ sync(); labels.push({ id:'lb'+Date.now(), name:'New label', color:'#2f7fd1' }); draw(); };
    m.querySelector('#kbStSave').onclick = async ()=>{
      sync();
      const r = await guarded(()=>apiPut('/kanban/boards/'+KB.board.id,{ name:m.querySelector('#kbStName').value, description:m.querySelector('#kbStDesc').value, color, labels }));
      if(r){ KB.dirty = false; closeModal(true); await refreshBoard(); }
    };
    m.querySelector('#kbStDel').onclick = async ()=>{
      if(!confirm('Delete the whole board "'+KB.board.name+'" with all its cards? This cannot be undone.')) return;
      const r = await guarded(()=>apiDelete('/kanban/boards/'+KB.board.id));
      if(r){ closeModal(true); KB.board = null; switchView('kanban'); }
    };
  };
  const sync = ()=>{
    labels = [...m.querySelectorAll('.kb-lbl-row')].map((row,i)=>({ ...labels[i], name: row.querySelector('[data-ln]').value, color: row.querySelector('[data-lc]').value }));
  };
  draw();
}
window.kbSettings = kbSettings;

// ======================================================
// CREATE CARDS FROM CMMS WORK
// ======================================================
async function kbFromCmms(){
  const s = await guarded(()=>apiGet('/kanban/suggestions'));
  if(!s) return;
  const firstCol = KB.columns.find(c=>!c.isDone) || KB.columns[0];
  const m = openModal(`
    <h3 class="kb-modal-title">Create cards from CMMS work</h3>
    <div class="hint" style="margin-bottom:8px">Cards are added to <b>${esc(firstCol.name)}</b> and linked to the machine.</div>
    <div class="kb-tabs"><button class="kb-tab on" data-t="logs">Pending logs (${s.pendingLogs.length})</button><button class="kb-tab" data-t="pm">Overdue PM (${s.overduePm.length})</button></div>
    <div id="kbSug" class="kb-sug"></div>
    <div class="kb-modal-actions"><button class="btn-primary" data-kb-close>Done</button></div>`);
  let tab = 'logs';
  const used = new Set(KB.cards.filter(c=>c.logId).map(c=>c.logId));
  const usedPm = new Set(KB.cards.filter(c=>c.machineId && /^Overdue PM/i.test(c.title)).map(c=>c.machineId));
  const draw = ()=>{
    const box = m.querySelector('#kbSug');
    if(tab === 'logs'){
      box.innerHTML = s.pendingLogs.length ? s.pendingLogs.map(l=>`
        <div class="kb-sug-row"><div><b>${esc(l.machineCode)}</b> &middot; ${esc(l.machineName)}<div class="kb-muted">${esc(fmtD(l.date))} &middot; ${esc((l.findings||'').slice(0,90))}</div></div>
        <button class="btn-primary small" data-log="${l.logId}" ${used.has(l.logId)?'disabled':''}>${used.has(l.logId)?'Added':'Add card'}</button></div>`).join('') : '<div class="hint">No pending logs.</div>';
      box.querySelectorAll('[data-log]').forEach(b=>b.onclick = async ()=>{
        const l = s.pendingLogs.find(x=>x.logId===b.dataset.log);
        const r = await guarded(()=>apiPost('/kanban/boards/'+KB.board.id+'/cards',{ columnId:firstCol.id, title:`${l.machineCode}: ${(l.findings||'Pending breakdown').slice(0,100)}`, description:`Pending log from ${l.date} on ${l.machineName} (${l.machineCode}).\n\n${l.findings||''}`, priority:'High', machineId:l.machineId, logId:l.logId }));
        if(r){ used.add(l.logId); KB.dirty = true; draw(); }
      });
    } else {
      box.innerHTML = s.overduePm.length ? s.overduePm.map(p=>`
        <div class="kb-sug-row"><div><b>${esc(p.machineCode)}</b> &middot; ${esc(p.machineName)}<div class="kb-muted">PM was due ${esc(fmtD(p.nextPmDate))}</div></div>
        <button class="btn-primary small" data-pm="${p.machineId}" ${usedPm.has(p.machineId)?'disabled':''}>${usedPm.has(p.machineId)?'Added':'Add card'}</button></div>`).join('') : '<div class="hint">No overdue PM.</div>';
      box.querySelectorAll('[data-pm]').forEach(b=>b.onclick = async ()=>{
        const p = s.overduePm.find(x=>x.machineId===b.dataset.pm);
        const r = await guarded(()=>apiPost('/kanban/boards/'+KB.board.id+'/cards',{ columnId:firstCol.id, title:`Overdue PM: ${p.machineCode} ${p.machineName}`, description:`Preventive maintenance was due ${p.nextPmDate}.`, priority:'Medium', dueDate:todayStr(), machineId:p.machineId }));
        if(r){ usedPm.add(p.machineId); KB.dirty = true; draw(); }
      });
    }
  };
  m.querySelectorAll('.kb-tab').forEach(t=>t.onclick = ()=>{ tab = t.dataset.t; m.querySelectorAll('.kb-tab').forEach(x=>x.classList.toggle('on', x===t)); draw(); });
  draw();
}
window.kbFromCmms = kbFromCmms;

})();
