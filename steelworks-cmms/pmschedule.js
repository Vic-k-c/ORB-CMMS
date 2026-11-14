// ================= PM SCHEDULE (client) =================
// Technicians see what is due, tap "Log this PM" (opens the normal log form
// already filled in as a Preventive log) and the schedule closes by itself.
(function () {
  const $ = id => document.getElementById(id);
    let tab = 'due', seqDue = 0, seqSum = 0, seqShut = 0, cache = {}, groupsLoaded = false, shutOpen = {};

  function localToday() { return window._pmToday || new Date().toLocaleDateString('en-CA'); }
  function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function fmt(d) {
    if (!d) return '';
    const x = new Date(d + 'T00:00:00');
    const yr = d.slice(0, 4) !== localToday().slice(0, 4);
    return x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: yr ? '2-digit' : undefined });
  }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
  const esc = s => escapeHtml(s == null ? '' : String(s));
  const canAct = () => hasPermission('submit_logs');

  // ---------- tabs ----------
  function setTab(t) {
    tab = t;
    document.querySelectorAll('#pmTabs button').forEach(b => b.classList.toggle('active', b.dataset.pmtab === t));
    $('pmTabDue').style.display = t === 'due' ? '' : 'none';
    $('pmTabCompliance').style.display = t === 'compliance' ? '' : 'none';
    $('pmTabShutdown').style.display = t === 'shutdown' ? '' : 'none';
    if (t === 'due') loadDue();
    if (t === 'compliance') loadSummary();
    if (t === 'shutdown') loadShutdown();
  }

  window.loadPmPage = async function () {
    if (!groupsLoaded) {
      try {
        const g = await apiGet('/pm/groups');
        $('pmGroup').innerHTML = '<option value="">All groups</option>' + g.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
        groupsLoaded = true;
      } catch (e) { /* list still works without the group filter */ }
    }
    if ($('pmImportBox')) $('pmImportBox').style.display = isManagement() ? '' : 'none';
    setTab(tab);
  };

  // ---------- due list ----------
  function filtersActive() {
    return $('pmGroup').value || $('pmLevel').value || $('pmSearch').value.trim() || $('pmScope').value !== 'week';
  }
  async function loadDue() {
    const my = ++seqDue;
    const qs = new URLSearchParams({ scope: $('pmScope').value, group: $('pmGroup').value, level: $('pmLevel').value, q: $('pmSearch').value.trim() });
    $('pmClear').classList.toggle('filter-active', !!filtersActive());
    $('pmList').innerHTML = '<div class="empty-state"><div class="big">Loading...</div></div>';
    let d;
    try { d = await apiGet('/pm/due?' + qs.toString()); }
    catch (e) { if (my === seqDue) $('pmList').innerHTML = `<div class="empty-state"><div class="big">Could not load PM list</div><div>${esc(e.message)}</div></div>`; return; }
    if (my !== seqDue) return;
    cache = {};
    d.rows.forEach(r => { cache[r.id] = r; });
    $('pmCount').textContent = d.rows.length ? d.rows.length + (d.rows.length >= 600 ? '+' : '') + ' visits' : '';
    if (!d.rows.length) {
      $('pmList').innerHTML = `<div class="empty-state"><div class="big">${$('pmScope').value === 'overdue' ? 'Nothing overdue' : 'No PM visits found'}</div>
        <div>${filtersActive() ? 'Try clearing the filters.' : 'If the schedule has never been loaded, a manager can import it.'}</div>
        ${isManagement() ? '<p><button type="button" class="btn-primary" data-pmact="import">Import PM schedule</button></p>' : ''}</div>`;
      return;
    }
    const today = d.today; window._pmToday = d.today;
    let lastDate = '';
    $('pmList').innerHTML = d.rows.map(r => {
      const head = r.dueDate !== lastDate ? `<div class="pm-date-head">${fmt(r.dueDate)}${r.dueDate === today ? ' <span class="pm-today">TODAY</span>' : ''}</div>` : '';
      lastDate = r.dueDate;
      return head + card(r, today);
    }).join('');
  }
  function card(r, today) {
    const open = r.status === 'Planned' || r.status === 'In progress';
    const late = open && r.dueDate < today ? daysBetween(r.dueDate, today) : 0;
    const dueTxt = late ? `<span class="pm-late">${late} day${late > 1 ? 's' : ''} overdue</span>` : (r.status === 'Done' ? '' : '');
    const stPill = r.status !== 'Planned' ? `<span class="pm-status pm-st-${r.status.replace(/\s/g, '')}">${esc(r.status)}</span>` : '';
    const tasks = r.tasks.length ? `<details class="pm-tasks"><summary>Checklist - ${r.tasks.length} tasks</summary><ul>${r.tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '';
    let actions = '';
    if (open && canAct()) {
      actions = `<button type="button" class="btn-primary" data-pmact="log" data-id="${r.id}">${r.status === 'In progress' ? 'Open PM log' : 'Log this PM'}</button>
        <button type="button" class="btn-ghost" data-pmact="move" data-id="${r.id}">Move</button>
        <button type="button" class="btn-ghost" data-pmact="skip" data-id="${r.id}">Skip</button>`;
      if (r.status === 'In progress' && r.logId) {
        actions = `<button type="button" class="btn-primary" data-pmact="viewlog" data-id="${r.id}">Open PM log</button>`;
      }
    } else if (r.status === 'Done') {
      actions = `<span class="pm-done-txt">&#10003; Done${r.doneBy ? ' by ' + esc(r.doneBy) : ''}</span>` + (r.logId ? ` <button type="button" class="btn-ghost" data-pmact="viewlog" data-id="${r.id}">View log</button>` : '');
    }
    return `<div class="pm-card ${late ? 'late' : ''}" data-id="${r.id}">
      <div class="pm-card-top">
        <span class="pm-lv pm-lv-${r.level}" title="${esc(r.levelName)}">${r.level}</span>
        <div class="pm-card-main">
          <div class="pm-machine">${esc(r.machineName)} <small>${esc(r.machineCode)}</small></div>
          <div class="pm-meta">${esc(r.group)}${r.location ? ' &middot; ' + esc(r.location) : ''} &middot; ${esc(r.levelName)}${r.team ? ' &middot; ' + esc(r.team) : ''}${r.hours ? ' &middot; ~' + r.hours + ' h' : ''}</div>
        </div>
        <div class="pm-card-side">${dueTxt}${stPill}</div>
      </div>
      ${r.note ? `<div class="pm-note">${esc(r.note)}</div>` : ''}
      ${tasks}
      <div class="pm-actions" id="pmAct${r.id}">${actions}</div>
    </div>`;
  }

  // inline move / skip forms
  function inlineForm(id, kind) {
    const r = cache[id]; if (!r) return;
    const box = $('pmAct' + id);
    if (kind === 'move') {
      box.innerHTML = `<input type="date" class="pm-in" id="pmNewDate${id}" value="${esc(r.dueDate)}">
        <input type="text" class="pm-in pm-in-wide" id="pmReason${id}" placeholder="Reason for moving (required)">
        <button type="button" class="btn-primary" data-pmact="movesave" data-id="${id}">Save</button>
        <button type="button" class="btn-ghost" data-pmact="cancel" data-id="${id}">Cancel</button>`;
    } else {
      box.innerHTML = `<input type="text" class="pm-in pm-in-wide" id="pmReason${id}" placeholder="Reason for skipping (required)">
        <button type="button" class="btn-primary" data-pmact="skipsave" data-id="${id}">Skip this PM</button>
        <button type="button" class="btn-ghost" data-pmact="cancel" data-id="${id}">Cancel</button>`;
    }
    const inp = $('pmReason' + id); if (inp) inp.focus();
  }

  async function logPm(r) {
    window._pmReturn = true;
    await openLogForm(r.machineId);
    window._pmLogId = r.id;
    const t = $('logType');
    t.value = 'Preventive';
    t.dispatchEvent(new Event('change', { bubbles: true }));
    $('logActions').value = 'Scheduled ' + r.levelName + ' PM - tasks carried out:\n' + r.tasks.map(x => '- ' + x).join('\n');
    $('logFormTitle').textContent = 'Log Scheduled PM';
    const b = $('pmLogBanner');
    b.innerHTML = `<b>Scheduled ${esc(r.levelName)} PM</b> &middot; due ${esc(fmt(r.dueDate))}<br>
      <span>Write what you found in <b>Issue / Findings</b>. The checklist is pre-filled under <b>Action Taken</b> - delete anything you did not do and add what you did.</span>`;
    b.style.display = '';
  }

  // ---------- compliance ----------
  function periodRange() {
    const today = localToday(); const y = parseInt(today.slice(0, 4), 10); const m = parseInt(today.slice(5, 7), 10);
    const p = $('pmPeriod').value;
    const pad = n => String(n).padStart(2, '0');
    const last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    if (p === 'lastmonth') { const yy = m === 1 ? y - 1 : y, mm = m === 1 ? 12 : m - 1; return [`${yy}-${pad(mm)}-01`, `${yy}-${pad(mm)}-${last(yy, mm)}`]; }
    if (p === '90') return [addDays(today, -90), today];
    if (p === 'year') return [`${y}-01-01`, `${y}-12-31`];
    return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${last(y, m)}`];
  }
  function bar(p) {
    if (p === null || p === undefined) return '<span class="pm-na">-</span>';
    const cls = p >= 90 ? 'good' : (p >= 70 ? 'mid' : 'bad');
    return `<div class="pm-bar"><div class="pm-bar-fill ${cls}" style="width:${Math.min(100, p)}%"></div></div><span class="pm-pct">${p}%</span>`;
  }
  async function loadSummary() {
    const my = ++seqSum;
    const [from, to] = periodRange();
    $('pmSummary').innerHTML = '<div class="empty-state"><div class="big">Loading...</div></div>';
    let d;
    try { d = await apiGet('/pm/summary?from=' + from + '&to=' + to); }
    catch (e) { if (my === seqSum) $('pmSummary').innerHTML = `<div class="empty-state"><div class="big">Could not load</div><div>${esc(e.message)}</div></div>`; return; }
    if (my !== seqSum) return;
    const t = d.total;
    const rows = list => list.map(g => `<tr><td>${esc(g.group || g.levelName)}</td><td>${g.planned}</td><td>${g.due}</td><td>${g.dueDone}</td><td>${g.overdue}</td><td class="pm-barcell">${bar(g.donePct)}</td><td class="pm-barcell">${bar(g.onTimePct)}</td></tr>`).join('');
    const head = lbl => `<thead><tr><th>${lbl}</th><th>Planned</th><th>Due so far</th><th>Done</th><th>Overdue</th><th>Done %</th><th>On time %</th></tr></thead>`;
    $('pmSummary').innerHTML = `
      <div class="pm-cards">
        <div class="stat-card-mini"><div class="stat-label">Planned</div><div class="stat-value">${t.planned}</div></div>
        <div class="stat-card-mini"><div class="stat-label">Done</div><div class="stat-value">${t.done}</div></div>
        <div class="stat-card-mini ${t.onTimePct !== null && t.onTimePct < 70 ? 'warn' : ''}"><div class="stat-label">On time (of due)</div><div class="stat-value">${t.onTimePct === null ? '-' : t.onTimePct + '%'}</div></div>
        <div class="stat-card-mini ${d.overdueNow > 0 ? 'alert' : ''}"><div class="stat-label">Overdue now</div><div class="stat-value">${d.overdueNow}</div></div>
      </div>
      <div class="hint">Done % and On time % are measured on visits already due. "On time" = done within 3 days of the due date. Shutdown visits are included in Planned and Done.</div>
      ${d.groups.length ? `<div class="panel-block"><h3>By machine group</h3><div class="table-scroll"><table class="matrix-table summary-table">${head('Group')}<tbody>${rows(d.groups)}</tbody></table></div></div>` : ''}
      ${d.levels.length ? `<div class="panel-block"><h3>By visit level</h3><div class="table-scroll"><table class="matrix-table summary-table">${head('Level')}<tbody>${rows(d.levels)}</tbody></table></div></div>` : ''}
      ${!d.groups.length ? '<div class="empty-state"><div class="big">No PM visits in this period</div></div>' : ''}`;
  }

  // ---------- shutdown ----------
  function metaFor(groups, name) { return groups.find(g => g.name === name) || null; }
  async function loadShutdown() {
    const my = ++seqShut;
    const yv = $('pmShutYear').value;
    $('pmShutdown').innerHTML = '<div class="empty-state"><div class="big">Loading...</div></div>';
    let d;
    try { d = await apiGet('/pm/shutdown' + (yv ? '?year=' + yv : '')); }
    catch (e) { if (my === seqShut) $('pmShutdown').innerHTML = `<div class="empty-state"><div class="big">Could not load</div><div>${esc(e.message)}</div></div>`; return; }
    if (my !== seqShut) return;
    cache = {};
    d.rows.forEach(r => { cache[r.id] = r; });
    const year = String(d.year);
    if (d.years && d.years.length) {
      $('pmShutYear').innerHTML = d.years.map(v => `<option value="${v}" ${String(v) === year ? 'selected' : ''}>${v}</option>`).join('');
    }
    if (!d.rows.length) {
      $('pmShutdown').innerHTML = `<div class="empty-state"><div class="big">No shutdown plan loaded${d.years && d.years.length ? ' for ' + esc(year) : ''}</div>${isManagement() ? '<p><button type="button" class="btn-primary" data-pmact="import">Import PM schedule</button></p>' : ''}</div>`;
      return;
    }
    const total = d.rows.length, done = d.rows.filter(r => r.status === 'Done').length;
    let html = `<div class="pm-shut-total"><b>${done}</b> of <b>${total}</b> machine-days done</div>`;
    for (let i = 0; i < d.dates.length; i++) {
      const dayRows = d.rows.filter(r => r.shutdownDay === i + 1);
      if (!dayRows.length) continue;
      const dd = dayRows.filter(r => r.status === 'Done').length;
      const groups = {};
      dayRows.forEach(r => { (groups[r.shutdownGroup] = groups[r.shutdownGroup] || []).push(r); });
      const key = year + '-' + i;
      const isOpen = shutOpen[key] !== undefined ? shutOpen[key] : (dd < dayRows.length && Object.keys(shutOpen).length === 0 && i === firstOpenDay(d));
      html += `<details class="pm-day" data-key="${key}" ${isOpen ? 'open' : ''}>
        <summary><b>Day ${i + 1}</b> &middot; ${esc(fmt(d.dates[i]))} <span class="pm-day-count ${dd === dayRows.length ? 'full' : ''}">${dd}/${dayRows.length} done</span></summary>`;
      Object.keys(groups).forEach(gn => {
        const rows = groups[gn];
        const meta = metaFor(d.groups, gn);
        const mp = meta && meta.manpower ? meta.manpower[i] : null;
        const ids = rows.filter(r => r.status !== 'Done').map(r => r.id);
        html += `<div class="pm-shut-group">
          <div class="pm-shut-ghead"><b>${esc(gn)}</b> <span class="pm-meta">${rows.length} machine${rows.length > 1 ? 's' : ''}${mp ? ' &middot; ' + mp + ' people' : ''}</span>
            ${ids.length && canAct() ? `<button type="button" class="btn-ghost" data-pmact="markall" data-ids="${ids.join(',')}">Mark all done</button>` : ''}</div>
          ${meta && meta.tasks ? `<details class="pm-tasks"><summary>Shutdown tasks</summary><div class="pm-shut-tasks">${esc(meta.tasks)}</div></details>` : ''}
          <div class="pm-shut-list">${rows.map(r => `<label class="pm-shut-row ${r.status === 'Done' ? 'done' : ''}">
              <input type="checkbox" data-pmact="tick" data-id="${r.id}" ${r.status === 'Done' ? 'checked' : ''} ${canAct() && !(r.status === 'Done' && r.logId) ? '' : 'disabled'}>
              <span>${esc(r.machineName)} <small>${esc(r.machineCode)}</small></span>
              <span class="pm-meta">${esc(r.location)}${r.status === 'Done' && r.doneBy ? ' &middot; ' + esc(r.doneBy) : ''}</span></label>`).join('')}</div>
        </div>`;
      });
      html += '</details>';
    }
    $('pmShutdown').innerHTML = html;
  }
  function firstOpenDay(d) {
    for (let i = 0; i < d.dates.length; i++) {
      const rs = d.rows.filter(r => r.shutdownDay === i + 1);
      if (rs.length && rs.some(r => r.status !== 'Done')) return i;
    }
    return 0;
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-pmact]');
    const tabBtn = e.target.closest('#pmTabs button[data-pmtab]');
    if (tabBtn) { setTab(tabBtn.dataset.pmtab); return; }
    if (!t || t.tagName === 'INPUT') return;
    const act = t.dataset.pmact, id = parseInt(t.dataset.id, 10);
    try {
      if (act === 'log') { const r = cache[id]; if (r) await logPm(r); }
      else if (act === 'viewlog') { const r = cache[id]; if (r && r.logId && window.openLogDetail) { window._logDetailBackView = 'pm'; openLogDetail(r.logId); } }
      else if (act === 'move') inlineForm(id, 'move');
      else if (act === 'skip') inlineForm(id, 'skip');
      else if (act === 'cancel') { const r = cache[id]; if (r) { const c = document.querySelector(`.pm-card[data-id="${id}"]`); if (c) c.outerHTML = card(r, localToday()); } }
      else if (act === 'movesave') {
        await apiPost('/pm/' + id + '/reschedule', { date: $('pmNewDate' + id).value, reason: $('pmReason' + id).value.trim() });
        showToast('PM moved'); loadDue();
      } else if (act === 'skipsave') {
        await apiPost('/pm/' + id + '/skip', { reason: $('pmReason' + id).value.trim() });
        showToast('PM skipped'); loadDue();
      } else if (act === 'markall') {
        const ids = t.dataset.ids.split(',').map(Number);
        await apiPost('/pm/bulk-complete', { ids });
        showToast(ids.length + ' marked done'); keepOpenAndReload();
      } else if (act === 'import') {
        pickImportFile();
      }
    } catch (err) { showToast(err.message); }
  });
  function keepOpenAndReload() {
    document.querySelectorAll('#pmShutdown details.pm-day').forEach(d => { shutOpen[d.dataset.key] = d.open; });
    loadShutdown();
  }
  // The Import button opens the phone / PC file chooser directly
  function pickImportFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json'; inp.style.display = 'none';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (f) { try { await doImport(f); } catch (err) { showToast(err.message); } }
    });
    document.body.appendChild(inp);
    inp.click();
  }
  async function doImport(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { showToast('That file is not a valid PM file'); return; }
    data.mode = $('pmImportMode') ? $('pmImportMode').value : 'merge';
    const r = await apiPost('/pm/import', data);
    showToast('Imported: ' + r.inserted + ' new visits, ' + r.plans + ' machines, ' + r.templates + ' checklist levels' +
      (r.removed ? ', ' + r.removed + ' old planned visits replaced' : '') +
      (r.unmatched.length ? '. ' + r.unmatched.length + ' machine codes not found in your register' : ''), true);
    if (r.unmatched.length) console.warn('PM import - machine codes not found:', r.unmatched.join(', '));
    groupsLoaded = false; await window.loadPmPage();
  }
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'pmImportFile') {
      const f = t.files && t.files[0]; t.value = '';
      if (f) { try { await doImport(f); } catch (err) { showToast(err.message); } }
      return;
    }
    if (t.matches('input[data-pmact="tick"]')) {
      const id = parseInt(t.dataset.id, 10);
      try {
        if (t.checked) await apiPost('/pm/' + id + '/complete', {});
        else await apiPost('/pm/' + id + '/reopen', {});
        keepOpenAndReload();
      } catch (err) { t.checked = !t.checked; showToast(err.message); }
      return;
    }
    if (['pmScope', 'pmGroup', 'pmLevel'].includes(t.id)) loadDue();
    if (t.id === 'pmPeriod') loadSummary();
    if (t.id === 'pmShutYear') { shutOpen = {}; loadShutdown(); }
  });
  let deb;
  document.addEventListener('input', (e) => {
    if (e.target.id === 'pmSearch') { clearTimeout(deb); deb = setTimeout(loadDue, 300); }
  });
  document.addEventListener('click', (e) => {
    if (e.target.id === 'pmClear') {
      $('pmScope').value = 'week'; $('pmGroup').value = ''; $('pmLevel').value = ''; $('pmSearch').value = '';
      loadDue();
    }
  });
})();
