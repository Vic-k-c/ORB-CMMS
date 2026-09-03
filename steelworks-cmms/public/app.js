const API = '/api';
let machinesCache = [];
let logCache = {};
let chartRefs = {};
let currentUser = null;

function escapeHtml(str){ const d=document.createElement('div'); d.textContent=str||''; return d.innerHTML; }
function fmtDateTime(iso){ const d=new Date(iso); return d.toLocaleDateString(undefined,{month:'short',day:'2-digit',year:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }
function fmtDate(dstr){ if(!dstr) return '\u2014'; const d=new Date(dstr+'T00:00:00'); return d.toLocaleDateString(undefined,{month:'short',day:'2-digit',year:'numeric'}); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
// Converts a stored UTC ISO timestamp to the LOCAL calendar date for a date
// input. Deliberately NOT iso.slice(0,10) - that reads the UTC date, which
// can be a day off from the local date near midnight (e.g. 01:00 EAT is
// still 22:00 the previous day in UTC).
function toLocalDateInputValue(iso){
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
// Combines a plain "YYYY-MM-DD" date (from a date input, no timezone info)
// with the CURRENT time-of-day, then lets the Date constructor + toISOString
// handle the local-to-UTC conversion correctly - avoids the timezone bugs a
// full datetime-local input would introduce, since we only need the date
// itself to be adjustable, not the exact time of day.
function combineDateWithNowTime(dateStr){
  if(!dateStr) return undefined;
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  const combined = new Date(y, m-1, d, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return combined.toISOString();
}
function statusBadgeClass(s){ return (s||'').toLowerCase(); }

function showToast(msg){
  const existing=document.querySelector('.toast'); if(existing) existing.remove();
  const t=document.createElement('div'); t.className='toast'; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),4500);
}
async function handleApiResponse(res){
  if(res.status===401){ showLoginGate(); throw new Error('Session expired'); }
  let data = null;
  try{ data = await res.json(); }catch(e){}
  if(res.status===403 && data && data.error && data.error.toLowerCase().indexOf('deactivated') !== -1){
    await logout();
    throw new Error(data.error);
  }
  if(!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}
async function apiGet(url){ const res=await fetch(API+url,{credentials:'same-origin'}); return handleApiResponse(res); }
async function apiPost(url,body){ const res=await fetch(API+url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return handleApiResponse(res); }
async function apiPut(url,body){ const res=await fetch(API+url,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); return handleApiResponse(res); }
async function apiDelete(url){ const res=await fetch(API+url,{method:'DELETE',credentials:'same-origin'}); return handleApiResponse(res); }
async function apiPatch(url,body){ const res=await fetch(API+url,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return handleApiResponse(res); }

// ============ BRANDING (letterhead constants, cached after login) ============
let brandingCache = null;
let logoDataUrlCache = undefined; // undefined = not yet checked, null = no logo, string = data URL
async function loadBranding(){
  try{ brandingCache = await apiGet('/branding'); }
  catch(e){
    brandingCache = {
      companyName: 'ZENITH STEEL FABRICATORS LTD',
      tagline: 'DESIGN, FABRICATE & ERECT STRUCTURAL STEEL WORK',
      docNoLog: 'ZSF/MMCD/BRF/01', docEffectiveDateLog: '12/11/2025', docRevLog: '01', docIssueLog: '02',
      docNoExcel: 'ZSF/MCMD/ML/01', docEffectiveDateExcel: '10/12/2025', docRevExcel: '01',
      hasLogo: false, logoUrl: null
    };
  }
  return brandingCache;
}
// Fetches the org's logo as a data URL for jsPDF's addImage(). Same-origin, so
// no CORS issue like a pasted third-party URL would have. Cached after first call.
async function loadLogoDataUrl(){
  if(logoDataUrlCache !== undefined) return logoDataUrlCache;
  if(!brandingCache) await loadBranding();
  if(!brandingCache || !brandingCache.hasLogo){ logoDataUrlCache = null; return null; }
  try{
    const res = await fetch(API+'/organization/logo', { credentials:'same-origin' });
    if(!res.ok){ logoDataUrlCache = null; return null; }
    const blob = await res.blob();
    logoDataUrlCache = await new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=> resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }catch(e){ logoDataUrlCache = null; }
  return logoDataUrlCache;
}

// ============ AUTH ============
function canManageMachines(){ return currentUser && ['Maintenance Supervisor','Management','Maintenance HOD'].includes(currentUser.role); }
// Maintenance HOD has identical access to Management - kept under this
// function name since it's used everywhere as "does this user have full
// admin rights", not literally "is their title Management".
function isManagement(){ return currentUser && ['Management','Maintenance HOD'].includes(currentUser.role); }
function isSuperAdmin(){ return currentUser && currentUser.role === 'Super Admin'; }

function showLoginGate(){
  document.getElementById('loginGate').style.display = 'flex';
  document.getElementById('appShell').style.display = 'none';
  document.getElementById('superAdminShell').style.display = 'none';
  document.getElementById('headerLogo').style.display = 'none';
  document.getElementById('brandIcon').style.display = '';
  document.getElementById('headerTitle').innerHTML = 'STEEL<span>WORKS</span> <small>CMMS</small>';
  applyRememberedOrgLogo();
}

// Pre-fills the Organization Code with whatever was used last time on this
// device/browser (localStorage, client-side only - the server has no idea
// which device this is) and shows that organization's logo via the public
// logo endpoint. Purely a convenience for a shop-floor terminal that's
// always logged into the same organization - fails silently (just hides
// the image) if there's nothing remembered or that org has no logo.
function applyRememberedOrgLogo(){
  const lastOrgCode = localStorage.getItem('lastOrgCode');
  const logoImg = document.getElementById('loginRememberedLogo');
  const faviconLink = document.getElementById('faviconLink');
  if(!lastOrgCode){ logoImg.style.display = 'none'; faviconLink.href = 'data:,'; return; }
  document.getElementById('loginOrgCode').value = lastOrgCode;
  logoImg.onerror = () => { logoImg.style.display = 'none'; };
  logoImg.onload = () => { logoImg.style.display = 'block'; };
  logoImg.src = API + '/public/org-logo/' + encodeURIComponent(lastOrgCode) + '?t=' + Date.now();
  faviconLink.href = API + '/public/org-favicon/' + encodeURIComponent(lastOrgCode) + '?t=' + Date.now();
}
async function showAppShell(){
  document.getElementById('loginGate').style.display = 'none';

  if(isSuperAdmin()){
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('superAdminShell').style.display = 'block';
    document.getElementById('superAdminUserChip').textContent = `${currentUser.name} \u00b7 Super Admin`;
    loadOrganizations();
    return;
  }

  document.getElementById('superAdminShell').style.display = 'none';
  document.getElementById('appShell').style.display = 'block';
  document.getElementById('userChip').textContent = `${currentUser.name} \u00b7 ${currentUser.role}`;
  document.getElementById('mobileUserInfo').textContent = `${currentUser.name} \u00b7 ${currentUser.role}`;
  document.getElementById('adminNavBtn').style.display = isManagement() ? '' : 'none';
  await loadBranding();
  applyHeaderBranding();
  loadDashboard();
}

// White-labels the app header with the organization's own logo + name when
// they've uploaded one (via Admin -> Organization Branding), falling back to
// the default STEELWORKS CMMS branding when they haven't. The login page
// intentionally stays generic - the organization isn't known until after
// the Organization Code is submitted, so it can't be personalized there.
//
// When a logo exists, headerDisplayMode controls what text accompanies it
// (see Admin -> Organization Branding for the live preview):
//   logo_only          - just the image, no title or subtitle text
//   logo_name_tagline  - company name as the title, tagline as the subtitle
//   logo_tagline       - tagline as the subtitle, no company name title
// The tagline REPLACES the generic subtitle in the two modes that show it,
// rather than being added alongside it, to keep header space minimal.
function applyHeaderBranding(){
  const logoImg = document.getElementById('headerLogo');
  const brandIcon = document.getElementById('brandIcon');
  const titleEl = document.getElementById('headerTitle');
  const subtitleEl = document.getElementById('headerSubtitle');
  const cmmsBadge = document.getElementById('cmmsBadge');
  const faviconLink = document.getElementById('faviconLink');
  const orgName = (brandingCache && brandingCache.companyName) || '';
  const tagline = (brandingCache && brandingCache.tagline) || '';
  const mode = (brandingCache && brandingCache.headerDisplayMode) || 'logo_name_tagline';

  if(brandingCache && brandingCache.hasLogo){
    logoImg.src = API + '/organization/logo?t=' + Date.now();
    logoImg.style.display = 'block';
    brandIcon.style.display = 'none';
    // Once the org's own logo/name has replaced "STEELWORKS CMMS", nothing
    // else says "this is a CMMS" - so show the small badge to fill that gap.
    cmmsBadge.style.display = 'inline-block';

    if(mode === 'logo_only'){
      titleEl.textContent = '';
      subtitleEl.textContent = '';
    }else if(mode === 'logo_tagline'){
      titleEl.textContent = '';
      subtitleEl.textContent = tagline || 'MAINTENANCE LOG & WORK ORDER SYSTEM';
    }else{ // logo_name_tagline
      titleEl.textContent = orgName || 'STEELWORKS CMMS';
      subtitleEl.textContent = tagline || 'MAINTENANCE LOG & WORK ORDER SYSTEM';
    }
  }else{
    logoImg.style.display = 'none';
    brandIcon.style.display = '';
    cmmsBadge.style.display = 'none'; // "STEELWORKS CMMS" title already says CMMS
    titleEl.innerHTML = 'STEEL<span>WORKS</span> <small>CMMS</small>';
    subtitleEl.textContent = orgName
      ? `${orgName} \u2014 MAINTENANCE LOG & WORK ORDER SYSTEM`
      : 'MAINTENANCE LOG & WORK ORDER SYSTEM';
  }

  if(brandingCache && brandingCache.hasFavicon){
    faviconLink.href = API + '/organization/favicon?t=' + Date.now();
  }else{
    faviconLink.href = 'data:,';
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  const orgCodeTyped = document.getElementById('loginOrgCode').value.trim();
  try{
    currentUser = await apiPost('/auth/login', {
      orgCode: orgCodeTyped,
      username: document.getElementById('loginUsername').value.trim(),
      password: document.getElementById('loginPassword').value
    });
    if(orgCodeTyped) localStorage.setItem('lastOrgCode', orgCodeTyped);
    document.getElementById('loginForm').reset();
    showAppShell();
  }catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
});

async function logout(){
  try{ await fetch(API+'/auth/logout', {method:'POST', credentials:'same-origin'}); }catch(e){}
  currentUser = null;
  brandingCache = null;
  logoDataUrlCache = undefined;
  showLoginGate();
}
window.logout = logout;

async function checkSession(){
  try{
    const res = await fetch(API+'/auth/me', {credentials:'same-origin'});
    const user = await res.json();
    if(user){ currentUser = user; showAppShell(); }
    else { showLoginGate(); }
  }catch(e){ showLoginGate(); }
}

// ============ MOBILE NAV ============
document.getElementById('hamburgerBtn').addEventListener('click', ()=>{
  document.getElementById('topnav').classList.toggle('open');
});

// ============ NAVIGATION ============
function switchView(name){
  if(name==='admin' && !isManagement()){ showToast('Management access required'); return; }
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('.topnav button').forEach(b=>b.classList.remove('active'));
  const btn=document.querySelector('.topnav button[data-view="'+name+'"]');
  if(btn) btn.classList.add('active');
  document.getElementById('topnav').classList.remove('open');
  if(name==='dashboard') loadDashboard();
  if(name==='machines') loadMachinesPage();
  if(name==='logs') loadLogsPage();
  if(name==='reports') initReports();
  if(name==='admin') loadAdminPage();
}
window.switchView = switchView;
document.querySelectorAll('.topnav button[data-view]').forEach(btn=>btn.addEventListener('click',()=>switchView(btn.dataset.view)));

function switchToRawView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('.topnav button').forEach(b=>b.classList.remove('active'));
}

// ============ SHARED: load machines list (cached) ============
async function loadMachinesCache(){
  try{ machinesCache = await apiGet('/machines'); }catch(e){ showToast('Could not load machines: '+e.message); }
  return machinesCache;
}

// ============ DASHBOARD ============
async function loadDashboard(){
  try{
    const data = await apiGet('/dashboard');
    document.getElementById('pmDueSoonValue').textContent = data.pmDueSoon;
    document.getElementById('machinesDownValue').textContent = data.machinesDown;
    document.getElementById('totalMachinesValue').textContent = data.totalMachines;
    document.getElementById('logsThisMonthValue').textContent = data.logsThisMonth;
    document.getElementById('pendingLogsValue').textContent = data.pendingLogs;
    document.getElementById('awaitingReviewValue').textContent = data.awaitingReview;

    renderWeeklyChart(data.weeklyTrends);
    renderComplianceChart(data.pmCompliance);

    data.recentLogs.forEach(l=> logCache[l.id]=l);
    const recentList = document.getElementById('recentLogsList');
    if(data.recentLogs.length===0){
      recentList.innerHTML = '<div class="empty-state"><div class="big">No logs yet</div></div>';
    }else{
      recentList.innerHTML = data.recentLogs.map(l=>`
        <div class="recent-log-row">
          <div class="recent-log-left">
            <span class="recent-log-machine">${escapeHtml(l.machineName)} <span style="color:var(--grey);font-weight:400;">(${escapeHtml(l.machineCode)})</span></span>
            <span class="recent-log-meta">${l.logType} &middot; ${fmtDateTime(l.loggedAt)}</span>
          </div>
          <span class="badge ${statusBadgeClass(l.status)}">${l.status}</span>
        </div>`).join('');
    }

    const attGrid = document.getElementById('attentionGrid');
    if(data.machinesAttention.length===0){
      attGrid.innerHTML = '<div class="empty-state"><div class="big">All machines healthy</div></div>';
    }else{
      attGrid.innerHTML = data.machinesAttention.map(m=>`
        <div class="attention-card" onclick="openMachineDetail('${m.id}')">
          <div class="attention-top">
            <div>
              <div class="attention-name">${escapeHtml(m.name)}</div>
              <div class="attention-meta">Code: ${escapeHtml(m.code)}</div>
              <div class="attention-meta">Department: ${escapeHtml(m.department||'\u2014')}</div>
            </div>
            <span class="badge ${statusBadgeClass(m.status)}">${m.status}</span>
          </div>
          <div class="attention-pm">PM Due: ${fmtDate(m.nextPmDate)}</div>
        </div>`).join('');
    }

    const matrixBlock = document.getElementById('performanceMatrixBlock');
    if(canManageMachines()){
      matrixBlock.style.display = '';
      const monthInput = document.getElementById('matrixMonth');
      if(!monthInput.value) monthInput.value = todayISO().slice(0,7);
      if(machinesCache.length===0) await loadMachinesCache();
      populateMatrixDepartments();
      loadMatrix();
    }else{
      matrixBlock.style.display = 'none';
    }
  }catch(e){ if(e.message!=='Session expired') showToast('Could not load dashboard: '+e.message); }
}

// ============ MACHINE PERFORMANCE MATRIX ============
document.getElementById('matrixMode').addEventListener('change', (e)=>{
  const mode = e.target.value;
  document.getElementById('matrixDate').style.display = mode==='daily' ? '' : 'none';
  document.getElementById('matrixMonth').style.display = mode==='monthly' ? '' : 'none';
  document.getElementById('matrixYear').style.display = mode==='yearly' ? '' : 'none';
  document.getElementById('matrixFrom').style.display = mode==='custom' ? '' : 'none';
  document.getElementById('matrixToLabel').style.display = mode==='custom' ? '' : 'none';
  document.getElementById('matrixTo').style.display = mode==='custom' ? '' : 'none';
});

function buildMatrixParams(){
  const mode = document.getElementById('matrixMode').value;
  const params = new URLSearchParams({ mode });
  if(mode==='daily') params.set('date', document.getElementById('matrixDate').value || todayISO());
  if(mode==='monthly'){
    const val = document.getElementById('matrixMonth').value || todayISO().slice(0,7);
    const [y,mo] = val.split('-');
    params.set('year', y); params.set('month', parseInt(mo));
  }
  if(mode==='yearly') params.set('year', document.getElementById('matrixYear').value || new Date().getFullYear());
  if(mode==='custom'){
    params.set('from', document.getElementById('matrixFrom').value || todayISO());
    params.set('to', document.getElementById('matrixTo').value || todayISO());
  }
  const dept = document.getElementById('matrixDepartment').value;
  if(dept) params.set('department', dept);
  return params;
}

async function populateMatrixDepartments(){
  const sel = document.getElementById('matrixDepartment');
  const currentVal = sel.value;
  const depts = [...new Set(machinesCache.map(m=>m.department).filter(Boolean))];
  sel.innerHTML = '<option value="">All Departments</option>' + depts.map(d=>`<option>${escapeHtml(d)}</option>`).join('');
  if(depts.includes(currentVal)) sel.value = currentVal;
}

async function loadMatrix(){
  if(!canManageMachines()) return;
  const params = buildMatrixParams();
  try{
    const data = await apiGet('/machines/metrics-matrix?'+params.toString());
    const tbody = document.getElementById('matrixTableBody');
    const empty = document.getElementById('matrixEmpty');
    if(data.rows.length===0){ tbody.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display='none';
    tbody.innerHTML = data.rows.map(r=>`
      <tr onclick="openMachineDetail('${r.machineId}')">
        <td><b>${escapeHtml(r.machineName)}</b> <span class="matrix-code">(${escapeHtml(r.machineCode)})</span></td>
        <td>${r.cumulativeDowntimeHours}</td>
        <td>${r.numberOfFailures}</td>
        <td>${r.mttr!==null ? r.mttr : 'N/A'}</td>
        <td>${r.mtbf!==null ? r.mtbf : 'N/A'}</td>
        <td>${r.operatingTimeHours}</td>
      </tr>`).join('');
  }catch(e){ showToast('Could not load performance matrix: '+e.message); }
}
window.loadMatrix = loadMatrix;

async function downloadMatrixExcel(){
  if(!canManageMachines()) return;
  const params = buildMatrixParams();
  try{
    const res = await fetch(API+'/machines/metrics-matrix/export/excel?'+params.toString(), { credentials:'same-origin' });
    if(res.status===401){ showLoginGate(); return; }
    if(!res.ok){ const data = await res.json().catch(()=>({error:'Export failed'})); throw new Error(data.error||'Export failed'); }
    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    a.download = match ? match[1] : 'machine-performance.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(downloadUrl);
  }catch(e){ showToast('Could not export: '+e.message); }
}
window.downloadMatrixExcel = downloadMatrixExcel;

// ============ OPERATING SCHEDULE SETTINGS ============
async function openScheduleSettings(){
  if(!canManageMachines()){ showToast('Only supervisors and management can manage the operating schedule'); return; }
  switchToRawView('schedule-settings');
  try{
    const settings = await apiGet('/settings');
    document.getElementById('defaultHoursInput').value = settings.defaultOperatingHours;
  }catch(e){ showToast('Could not load settings: '+e.message); }
  loadOverridesList();
}
window.openScheduleSettings = openScheduleSettings;

async function saveDefaultHours(){
  const hours = document.getElementById('defaultHoursInput').value;
  try{
    await apiPut('/settings', { defaultOperatingHours: hours });
    showToast('Default operating hours saved');
  }catch(e){ showToast('Could not save: '+e.message); }
}
window.saveDefaultHours = saveDefaultHours;

async function addOverride(){
  const date = document.getElementById('overrideDate').value;
  const hours = document.getElementById('overrideHours').value;
  const note = document.getElementById('overrideNote').value.trim();
  if(!date || hours===''){ showToast('Pick a date and enter hours'); return; }
  try{
    await apiPost('/schedule-overrides', { date, hours, note });
    showToast('Override saved');
    document.getElementById('overrideDate').value = '';
    document.getElementById('overrideHours').value = '';
    document.getElementById('overrideNote').value = '';
    loadOverridesList();
  }catch(e){ showToast('Could not save override: '+e.message); }
}
window.addOverride = addOverride;

async function loadOverridesList(){
  try{
    const overrides = await apiGet('/schedule-overrides');
    const list = document.getElementById('overridesList');
    if(overrides.length===0){ list.innerHTML = '<div class="empty-state"><div class="big">No overrides yet</div></div>'; return; }
    list.innerHTML = overrides.map(o=>`
      <div class="user-row">
        <div class="user-row-left">
          <span class="user-name">${fmtDate(o.date)} \u2014 ${o.hours} hrs</span>
          <span class="user-meta">${escapeHtml(o.note||'No note')} &middot; set by ${escapeHtml(o.updatedBy||'unknown')}</span>
        </div>
        <button class="btn-danger" onclick="deleteOverride('${o.date}')">Delete</button>
      </div>`).join('');
  }catch(e){ showToast('Could not load overrides: '+e.message); }
}

async function deleteOverride(date){
  if(!confirm(`Remove the override for ${fmtDate(date)}? That day will revert to the default hours.`)) return;
  try{ await apiDelete('/schedule-overrides/'+date); showToast('Override removed'); loadOverridesList(); }
  catch(e){ showToast('Could not delete override: '+e.message); }
}
window.deleteOverride = deleteOverride;

function destroyChart(id){ if(chartRefs[id]){ chartRefs[id].destroy(); delete chartRefs[id]; } }

function renderWeeklyChart(trends){
  destroyChart('weekly');
  const ctx = document.getElementById('weeklyTrendsChart');
  if(typeof Chart === 'undefined'){ ctx.parentElement.innerHTML = '<div style="color:var(--grey);font-size:13px;text-align:center;padding-top:40px;">Chart library failed to load. Check your internet connection.</div>'; return; }
  chartRefs.weekly = new Chart(ctx, {
    type:'bar',
    data:{
      labels: trends.map(t=>t.day.slice(5)),
      datasets:[
        {label:'Preventive', data: trends.map(t=>t.preventive), backgroundColor:'#0B2545'},
        {label:'Breakdown', data: trends.map(t=>t.breakdown), backgroundColor:'#B3261E'}
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      scales:{
        x:{ticks:{color:'#6B7280'},grid:{color:'#E2E5EA'}},
        y:{ticks:{color:'#6B7280',stepSize:1},grid:{color:'#E2E5EA'},beginAtZero:true}
      },
      plugins:{legend:{labels:{color:'#1B2430'}}}
    }
  });
}
function renderComplianceChart(compliance){
  destroyChart('compliance');
  const ctx = document.getElementById('pmComplianceChart');
  if(typeof Chart === 'undefined') return;
  chartRefs.compliance = new Chart(ctx, {
    type:'doughnut',
    data:{
      labels:['On Schedule','Overdue'],
      datasets:[{data:[compliance.onSchedule, compliance.overdue], backgroundColor:['#0B2545','#B3261E']}]
    },
    options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{labels:{color:'#1B2430'}}}}
  });
}

// ============ MACHINES PAGE ============
async function loadMachinesPage(){
  document.getElementById('addMachineBtn').style.display = canManageMachines() ? '' : 'none';
  await loadMachinesCache();
  const depts = [...new Set(machinesCache.map(m=>m.department).filter(Boolean))];
  const deptSel = document.getElementById('machineDeptFilter');
  deptSel.innerHTML = '<option value="">All Departments</option>' + depts.map(d=>`<option>${escapeHtml(d)}</option>`).join('');
  renderMachines();
}
function renderMachines(){
  const search = document.getElementById('machineSearch').value.trim().toLowerCase();
  const status = document.getElementById('machineStatusFilter').value;
  const dept = document.getElementById('machineDeptFilter').value;
  let list = machinesCache.slice();
  if(search) list = list.filter(m => m.name.toLowerCase().includes(search) || m.code.toLowerCase().includes(search));
  if(status) list = list.filter(m => m.status === status);
  if(dept) list = list.filter(m => m.department === dept);

  const grid = document.getElementById('machineGrid');
  const empty = document.getElementById('machinesEmpty');
  if(list.length===0){ grid.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
  const today = todayISO();
  const canEdit = canManageMachines();
  grid.innerHTML = list.map(m=>{
    const overdue = m.nextPmDate && m.nextPmDate < today;
    return `
    <div class="machine-card" onclick="openMachineDetail('${m.id}')">
      <div class="machine-cover ${m.photoUrl?'':'no-photo'}" style="${m.photoUrl?`background-image:url('${m.photoUrl.replace(/'/g,"")}')`:''}">
        <span class="machine-status-pill badge ${statusBadgeClass(m.status)}">${m.status}</span>
      </div>
      <div class="machine-card-body">
        <div class="machine-name">${escapeHtml(m.name)}</div>
        <div class="machine-code">${escapeHtml(m.code)}</div>
        <div class="machine-info-row">&#127981; ${escapeHtml(m.department||'\u2014')}</div>
        <div class="machine-info-row">&#128205; ${escapeHtml(m.location||'\u2014')}</div>
        <div class="machine-info-row ${overdue?'overdue':''}">&#128197; Next PM: ${fmtDate(m.nextPmDate)}</div>
        <div class="machine-card-actions">
          <button class="btn-ghost" onclick="event.stopPropagation();openMachineDetail('${m.id}')">View Details</button>
          ${canEdit ? `<button class="btn-primary small" onclick="event.stopPropagation();openMachineForm('${m.id}')">Edit</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}
window.renderMachines = renderMachines;

function openMachineForm(id){
  if(!canManageMachines()){ showToast('Only supervisors and management can manage machines'); return; }
  const form = document.getElementById('machineForm');
  form.reset();
  document.getElementById('machineFormId').value = '';
  if(id){
    const m = machinesCache.find(x=>x.id===id);
    document.getElementById('machineFormTitle').textContent = 'Edit Machine';
    document.getElementById('machineFormSubmit').textContent = 'Save Changes';
    document.getElementById('machineFormId').value = id;
    document.getElementById('mName').value = m.name;
    document.getElementById('mCode').value = m.code;
    document.getElementById('mDept').value = m.department || '';
    document.getElementById('mLoc').value = m.location || '';
    document.getElementById('mStatus').value = m.status;
    document.getElementById('mNextPm').value = m.nextPmDate || '';
    document.getElementById('mPhoto').value = m.photoUrl || '';
  }else{
    document.getElementById('machineFormTitle').textContent = 'Add New Machine';
    document.getElementById('machineFormSubmit').textContent = 'Add Machine';
  }
  switchToRawView('machine-form');
}
window.openMachineForm = openMachineForm;

document.getElementById('machineForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const id = document.getElementById('machineFormId').value;
  const payload = {
    name: document.getElementById('mName').value.trim(),
    code: document.getElementById('mCode').value.trim(),
    department: document.getElementById('mDept').value.trim(),
    location: document.getElementById('mLoc').value.trim(),
    status: document.getElementById('mStatus').value,
    nextPmDate: document.getElementById('mNextPm').value,
    photoUrl: document.getElementById('mPhoto').value.trim()
  };
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try{
    if(id){ await apiPut('/machines/'+id, payload); showToast('Machine updated'); }
    else{ await apiPost('/machines', payload); showToast('Machine added'); }
    switchView('machines');
  }catch(err){ showToast('Could not save machine: '+err.message); }
  finally{ submitBtn.disabled = false; }
});

async function openMachineDetail(id){
  window._currentMachineDetailId = id;
  switchToRawView('machine-detail');
  document.getElementById('machineDetailContent').innerHTML = '<div class="empty-state">Loading&hellip;</div>';
  try{
    const [m, metrics] = await Promise.all([
      apiGet('/machines/'+id),
      apiGet('/machines/'+id+'/metrics').catch(()=>null)
    ]);
    const logs = m.logs || [];
    logs.forEach(l=> logCache[l.id]={...l, machineName:m.name, machineCode:m.code, machineDepartment:m.department, machineLocation:m.location});
    const today = todayISO();
    const overdue = m.nextPmDate && m.nextPmDate < today;
    const html = `
      <div class="machine-detail-cover ${m.photoUrl?'':'no-photo'}" style="${m.photoUrl?`background-image:url('${m.photoUrl.replace(/'/g,"")}')`:''}"></div>
      <div class="detail-head">
        <div>
          <div style="font-family:'IBM Plex Mono',monospace;color:var(--grey);font-size:12px;">${m.code}</div>
          <h2>${escapeHtml(m.name)}</h2>
        </div>
        <span class="badge ${statusBadgeClass(m.status)}" style="font-size:12px;">${m.status}</span>
      </div>
      <div class="machine-info-grid">
        <div class="info-tile"><div class="info-tile-label">Department</div><div class="info-tile-value">${escapeHtml(m.department||'\u2014')}</div></div>
        <div class="info-tile"><div class="info-tile-label">Location</div><div class="info-tile-value">${escapeHtml(m.location||'\u2014')}</div></div>
        <div class="info-tile"><div class="info-tile-label">Next PM Due</div><div class="info-tile-value" style="${overdue?'color:var(--red);':''}">${fmtDate(m.nextPmDate)}</div></div>
        <div class="info-tile"><div class="info-tile-label">Total Logs</div><div class="info-tile-value">${logs.length}</div></div>
      </div>
      <h2 style="font-family:'Oswald',sans-serif;text-transform:uppercase;font-size:17px;margin-bottom:6px;color:var(--navy);">Lifetime Reliability</h2>
      <div class="hint" style="margin-bottom:14px;">Since this machine was registered on ${fmtDate(m.createdAt.slice(0,10))}.</div>
      <div class="machine-info-grid">
        <div class="info-tile"><div class="info-tile-label">Cumulative Downtime</div><div class="info-tile-value">${metrics ? metrics.cumulativeDowntimeHours+' hrs' : '\u2014'}</div></div>
        <div class="info-tile"><div class="info-tile-label"># Failures</div><div class="info-tile-value">${metrics ? metrics.numberOfFailures : '\u2014'}</div></div>
        <div class="info-tile"><div class="info-tile-label">MTTR</div><div class="info-tile-value">${metrics && metrics.mttr!==null ? metrics.mttr+' hrs' : 'N/A'}</div></div>
        <div class="info-tile"><div class="info-tile-label">MTBF</div><div class="info-tile-value">${metrics && metrics.mtbf!==null ? metrics.mtbf+' hrs' : 'N/A'}</div></div>
        <div class="info-tile"><div class="info-tile-label">Operating Time</div><div class="info-tile-value">${metrics ? metrics.operatingTimeHours+' hrs' : '\u2014'}</div></div>
      </div>
      <h2 style="font-family:'Oswald',sans-serif;text-transform:uppercase;font-size:17px;margin-bottom:14px;color:var(--navy);">Maintenance History</h2>
      ${logs.length===0 ? `<div class="empty-state"><div class="big">No maintenance history yet</div></div>` :
        logs.map(l=>logEntryHtml({...l, machineName:m.name, machineCode:m.code, machineDepartment:m.department, machineLocation:m.location},false)).join('')}
      <div class="form-actions" style="margin-top:10px;">
        <button class="btn-primary" id="detailAddLogBtn">+ Log Maintenance</button>
        ${canManageMachines() ? `<button class="btn-ghost" onclick="openMachineForm('${m.id}')">Edit Machine</button>` : ''}
      </div>
    `;
    document.getElementById('machineDetailContent').innerHTML = html;
    document.getElementById('detailAddLogBtn').addEventListener('click', ()=> openLogForm(m.id));
  }catch(e){
    document.getElementById('machineDetailContent').innerHTML = `<div class="empty-state"><div class="big">Could not load machine</div><div>${escapeHtml(e.message)}</div></div>`;
  }
}
window.openMachineDetail = openMachineDetail;

function logEntryHtml(l, showMachine){
  logCache[l.id] = l;
  const attachments = l.attachments || [];
  const canReview = canManageMachines() && l.status === 'Completed';
  return `
    <div class="log-entry ${l.logType.toLowerCase()}">
      <div class="log-entry-top">
        <div class="log-entry-top-left">
          <span class="log-type-badge ${l.logType.toLowerCase()}">${l.logType} Maintenance</span>
          ${showMachine ? `<span class="log-machine-tag">${escapeHtml(l.machineName)} (${escapeHtml(l.machineCode)})</span>` : ''}
          <span class="badge ${statusBadgeClass(l.status)}">${l.status}</span>
        </div>
        <span class="log-tech">${escapeHtml(l.technician)} &middot; ${fmtDateTime(l.loggedAt)}</span>
      </div>
      ${l.logType==='Breakdown' && l.reportedBy ? `<div class="log-field"><b>Reported By</b>${escapeHtml(l.reportedBy)} ${l.priority?('&middot; '+l.priority+' priority'):''}</div>` : ''}
      <div class="log-field"><b>Findings</b>${escapeHtml(l.findings)}</div>
      <div class="log-field"><b>Actions Taken</b>${escapeHtml(l.actionsTaken)}</div>
      ${l.partsUsed ? `<div class="log-field"><b>Parts Used</b>${escapeHtml(l.partsUsed)}</div>` : ''}
      <div class="log-field"><b>Downtime</b>${l.downtimeHours} hr</div>
      ${l.status==='Reviewed' ? `<div class="log-field"><b>Reviewed By</b>${escapeHtml(l.reviewedBy||'\u2014')}${l.reviewedByRole?(' ('+escapeHtml(l.reviewedByRole)+')'):''} ${l.reviewedAt?('&middot; '+fmtDateTime(l.reviewedAt)):''}</div>` : ''}
      ${attachments.length>0 ? `<div class="attachment-list">${attachments.map(a=>`<span class="attachment-chip"><a href="${a.url}" target="_blank" rel="noopener" title="Uploaded by ${escapeHtml(a.uploadedBy||'unknown')} on ${fmtDateTime(a.uploadedAt)}">&#128206; ${escapeHtml(a.originalName)}</a>${canManageMachines() ? `<button class="del" onclick="deleteAttachment('${a.id}','${l.id}')" title="Delete attachment">&times;</button>` : ''}</span>`).join('')}</div>` : ''}
      <div class="log-entry-actions">
        <button class="log-pdf-btn" onclick="downloadLogPDF('${l.id}')">&#11015; Download PDF</button>
        <button class="log-attach-btn" onclick="triggerAttachUpload('${l.id}')">&#128206; Attach File</button>
        ${canManageMachines() ? `<button class="log-attach-btn" onclick="editLogForm('${l.id}')">Edit</button>` : ''}
        ${canReview ? `<button class="log-review-btn" onclick="markLogReviewed('${l.id}')">Mark Reviewed</button>` : ''}
      </div>
    </div>`;
}

function refreshActiveView(){
  const active = document.querySelector('.view.active');
  if(!active) return;
  const id = active.id;
  if(id==='view-dashboard') loadDashboard();
  else if(id==='view-machine-detail' && window._currentMachineDetailId) openMachineDetail(window._currentMachineDetailId);
  else if(id==='view-logs') renderLogsPage();
  else if(id==='view-reports'){
    const activeTab = document.querySelector('.subtabs button.active');
    if(activeTab){
      if(activeTab.dataset.report==='daily') loadDailyReport();
      else if(activeTab.dataset.report==='monthly') loadMonthlyReport();
      else loadYearlyReport();
    }
  }
}

function triggerAttachUpload(logId){
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,application/pdf';
  input.onchange = async () => {
    if(!input.files.length) return;
    const fd = new FormData();
    for(const f of input.files) fd.append('files', f);
    try{
      const res = await fetch(API+'/logs/'+logId+'/attachments', { method:'POST', credentials:'same-origin', body: fd });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Upload failed');
      showToast('File(s) attached');
      refreshActiveView();
    }catch(e){ showToast('Could not attach file: '+e.message); }
  };
  input.click();
}
window.triggerAttachUpload = triggerAttachUpload;

async function deleteAttachment(attachmentId, logId){
  if(!confirm('Delete this attachment? This cannot be undone.')) return;
  try{
    await apiDelete('/attachments/'+attachmentId);
    showToast('Attachment deleted');
    refreshActiveView();
  }catch(e){ showToast('Could not delete attachment: '+e.message); }
}
window.deleteAttachment = deleteAttachment;

async function markLogReviewed(id){
  try{
    await apiPatch('/logs/'+id+'/review');
    showToast('Log marked as reviewed');
    refreshActiveView();
  }catch(e){ showToast('Could not mark reviewed: '+e.message); }
}
window.markLogReviewed = markLogReviewed;

// ============ MAINTENANCE LOGS PAGE ============
async function loadLogsPage(){
  await loadMachinesCache();
  const sel = document.getElementById('logMachineFilter');
  sel.innerHTML = '<option value="">All Machines</option>' + machinesCache.map(m=>`<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.code)})</option>`).join('');
  const exportMonthEl = document.getElementById('exportMonth');
  if(!exportMonthEl.value) exportMonthEl.value = new Date().toISOString().slice(0,7);
  renderLogsPage();
}

document.getElementById('exportMode').addEventListener('change', (e)=>{
  const isRange = e.target.value === 'range';
  document.getElementById('exportMonth').style.display = isRange ? 'none' : '';
  document.getElementById('exportFrom').style.display = isRange ? '' : 'none';
  document.getElementById('exportToLabel').style.display = isRange ? '' : 'none';
  document.getElementById('exportTo').style.display = isRange ? '' : 'none';
});

async function exportLogsExcel(){
  const mode = document.getElementById('exportMode').value;
  let url;
  if(mode === 'month'){
    const month = document.getElementById('exportMonth').value;
    if(!month){ showToast('Pick a month first'); return; }
    url = '/logs/export/excel?month=' + month;
  }else{
    const from = document.getElementById('exportFrom').value;
    const to = document.getElementById('exportTo').value;
    if(!from || !to){ showToast('Pick both a start and end date'); return; }
    url = '/logs/export/excel?from=' + from + '&to=' + to;
  }
  try{
    const res = await fetch(API+url, { credentials:'same-origin' });
    if(res.status===401){ showLoginGate(); return; }
    if(!res.ok){ const data = await res.json().catch(()=>({error:'Export failed'})); throw new Error(data.error||'Export failed'); }
    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    a.download = match ? match[1] : 'maintenance-logs.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(downloadUrl);
  }catch(e){ showToast('Could not export: '+e.message); }
}
window.exportLogsExcel = exportLogsExcel;
async function renderLogsPage(){
  const machineId = document.getElementById('logMachineFilter').value;
  const logType = document.getElementById('logTypeFilter').value;
  const status = document.getElementById('logStatusFilter').value;
  const params = new URLSearchParams();
  if(machineId) params.set('machineId', machineId);
  if(logType) params.set('logType', logType);
  if(status) params.set('status', status);
  try{
    const logs = await apiGet('/logs?'+params.toString());
    const list = document.getElementById('logsPageList');
    const empty = document.getElementById('logsEmpty');
    if(logs.length===0){ list.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display='none';
    list.innerHTML = logs.map(l=>logEntryHtml(l,true)).join('');
  }catch(e){ if(e.message!=='Session expired') showToast('Could not load logs: '+e.message); }
}
window.renderLogsPage = renderLogsPage;

// ============ LOG FORM ============
let editingLogId = null;

async function openLogForm(preselectMachineId){
  editingLogId = null;
  await loadMachinesCache();
  const sel = document.getElementById('logMachine');
  if(machinesCache.length===0){
    sel.innerHTML = '<option value="">No machines registered \u2014 add one first</option>';
  }else{
    sel.innerHTML = machinesCache.map(m=>`<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.code)})</option>`).join('');
    if(preselectMachineId) sel.value = preselectMachineId;
  }
  document.getElementById('logForm').reset();
  document.getElementById('logFormId').value = '';
  if(preselectMachineId) sel.value = preselectMachineId;
  document.getElementById('breakdownFields').style.display = 'none';
  document.getElementById('logFormTitle').textContent = 'Maintenance Log Entry';
  document.getElementById('logFormHint').textContent = 'Filled in by the technician after attending to a machine.';
  document.getElementById('logFormSubmit').textContent = 'Submit Log';
  document.getElementById('logAttachmentsField').style.display = '';
  document.getElementById('logStatus').disabled = false;
  document.getElementById('logStatusLockedNote').style.display = 'none';
  document.getElementById('logDate').value = todayISO();
  switchToRawView('log-form');
}
window.openLogForm = openLogForm;

// Supervisor/Management only - correcting an existing log's details.
// Reuses the same form as creation; attachments are managed separately
// per-log (not through this form). The comment on the outdated timestamp
// restriction is gone - editing the date is now supported (see the date
// field below), just not the exact time-of-day.
async function editLogForm(logId){
  if(!canManageMachines()){ showToast('Only supervisors and management can edit logs'); return; }
  const l = logCache[logId];
  if(!l){ showToast('Log details not available to edit'); return; }
  editingLogId = logId;
  await loadMachinesCache();
  const sel = document.getElementById('logMachine');
  sel.innerHTML = machinesCache.map(m=>`<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(m.code)})</option>`).join('');
  sel.value = l.machineId;

  document.getElementById('logFormId').value = logId;
  document.getElementById('logType').value = l.logType;
  document.getElementById('breakdownFields').style.display = l.logType==='Breakdown' ? 'block' : 'none';
  document.getElementById('logReportedBy').value = l.reportedBy || '';
  document.getElementById('logPriority').value = l.priority || 'Medium';
  document.getElementById('logTech').value = l.technician || '';
  document.getElementById('logDowntime').value = l.downtimeHours || 0;
  document.getElementById('logFindings').value = l.findings || '';
  document.getElementById('logActions').value = l.actionsTaken || '';
  document.getElementById('logParts').value = l.partsUsed || '';
  document.getElementById('logDate').value = l.loggedAt ? toLocalDateInputValue(l.loggedAt) : todayISO();

  const statusSelect = document.getElementById('logStatus');
  if(l.status === 'Reviewed'){
    if(!statusSelect.querySelector('option[value="Reviewed"]')){
      const opt = document.createElement('option');
      opt.value = 'Reviewed'; opt.textContent = 'Reviewed';
      statusSelect.appendChild(opt);
    }
    statusSelect.value = 'Reviewed';
    statusSelect.disabled = true;
    document.getElementById('logStatusLockedNote').style.display = 'block';
  }else{
    statusSelect.value = l.status;
    statusSelect.disabled = false;
    document.getElementById('logStatusLockedNote').style.display = 'none';
  }

  document.getElementById('logFormTitle').textContent = 'Edit Maintenance Log';
  document.getElementById('logFormHint').textContent = 'Correcting details on an already-submitted log.';
  document.getElementById('logFormSubmit').textContent = 'Save Changes';
  document.getElementById('logAttachmentsField').style.display = 'none';
  switchToRawView('log-form');
}
window.editLogForm = editLogForm;

document.getElementById('logType').addEventListener('change', (e)=>{
  document.getElementById('breakdownFields').style.display = e.target.value==='Breakdown' ? 'block' : 'none';
});

document.getElementById('logForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const machineId = document.getElementById('logMachine').value;
  if(!machineId){ showToast('Select a machine first'); return; }
  const dateVal = document.getElementById('logDate').value;
  if(!dateVal){ showToast('Select a date of maintenance'); return; }
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try{
    const payload = {
      machineId,
      logType: document.getElementById('logType').value,
      reportedBy: document.getElementById('logReportedBy').value.trim(),
      priority: document.getElementById('logPriority').value,
      technician: document.getElementById('logTech').value.trim(),
      downtimeHours: document.getElementById('logDowntime').value || '0',
      findings: document.getElementById('logFindings').value.trim(),
      actionsTaken: document.getElementById('logActions').value.trim(),
      partsUsed: document.getElementById('logParts').value.trim(),
      status: document.getElementById('logStatus').disabled ? undefined : document.getElementById('logStatus').value,
      loggedAt: combineDateWithNowTime(dateVal)
    };

    if(editingLogId){
      await apiPut('/logs/'+editingLogId, payload);
      showToast('Log updated');
    }else{
      const created = await apiPost('/logs', payload);
      const fileInput = document.getElementById('logAttachments');
      if(fileInput.files.length > 0){
        const fd = new FormData();
        for(const f of fileInput.files) fd.append('files', f);
        try{
          await fetch(API+'/logs/'+created.id+'/attachments', { method:'POST', credentials:'same-origin', body: fd });
        }catch(upErr){ showToast('Log saved, but file attach failed: '+upErr.message); }
      }
      showToast('Log submitted');
    }
    editingLogId = null;
    switchView('logs');
  }catch(err){ showToast((editingLogId ? 'Could not update log: ' : 'Could not submit log: ')+err.message); }
  finally{ submitBtn.disabled = false; }
});

// ============ ADMIN ============
async function loadAdminPage(){
  if(!isManagement()){
    document.getElementById('usersList').innerHTML = '<div class="empty-state"><div class="big">Management access required</div></div>';
    return;
  }
  try{
    const users = await apiGet('/users');
    const list = document.getElementById('usersList');
    list.innerHTML = users.map(u=>`
      <div class="user-row">
        <div class="user-row-left">
          <span class="user-name">${escapeHtml(u.name)}</span>
          <span class="user-meta">@${escapeHtml(u.username)}</span>
        </div>
        <span class="role-pill ${['Management','Maintenance HOD'].includes(u.role)?'mgmt':''}">${u.role}</span>
        <div class="user-row-actions">
          <button class="btn-ghost" style="padding:7px 12px;font-size:12px;" onclick="openUserForm('${u.id}')">Edit</button>
          ${u.id!==currentUser.id ? `<button class="btn-danger" onclick="deleteUser('${u.id}','${escapeHtml(u.name)}')">Delete</button>` : ''}
        </div>
      </div>`).join('');
    window._usersCache = users;
  }catch(e){ showToast('Could not load users: '+e.message); }
}

// ============ SUPER ADMIN: ORGANIZATIONS ============
let orgsCache = [];
async function loadOrganizations(){
  try{
    orgsCache = await apiGet('/super-admin/organizations');
    const list = document.getElementById('orgsList');
    const empty = document.getElementById('orgsEmpty');
    if(orgsCache.length===0){ list.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display='none';
    list.innerHTML = orgsCache.map(o=>`
      <div class="user-row">
        <div class="user-row-left">
          <span class="user-name">${escapeHtml(o.name)} ${o.active ? '' : '<span class="role-pill mgmt">Deactivated</span>'}</span>
          <span class="user-meta">Code: ${escapeHtml(o.orgCode)} &middot; ${o.machineCount} machine${o.machineCount===1?'':'s'} &middot; ${o.userCount} user${o.userCount===1?'':'s'}</span>
        </div>
        <button class="btn-ghost" style="padding:7px 12px;font-size:12px;" onclick="openEditOrgForm('${o.id}')">Edit</button>
      </div>`).join('');
  }catch(e){ showToast('Could not load organizations: '+e.message); }
}

function openCreateOrgForm(){
  if(!isSuperAdmin()){ showToast('Only the Super Admin can create organizations'); return; }
  document.getElementById('createOrgForm').reset();
  document.getElementById('createOrgError').style.display = 'none';
  document.getElementById('createOrgPanel').style.display = 'block';
}
window.openCreateOrgForm = openCreateOrgForm;

function closeCreateOrgForm(){
  document.getElementById('createOrgPanel').style.display = 'none';
}
window.closeCreateOrgForm = closeCreateOrgForm;

async function openEditOrgForm(orgId){
  if(!isSuperAdmin()){ showToast('Only the Super Admin can edit organizations'); return; }
  const org = orgsCache.find(o=>o.id===orgId);
  if(!org){ showToast('Organization not found'); return; }
  document.getElementById('editOrgId').value = orgId;
  document.getElementById('editOrgName').value = org.name;
  document.getElementById('editOrgActive').value = org.active ? '1' : '0';
  document.getElementById('editOrgError').style.display = 'none';
  document.getElementById('resetPasswordError').style.display = 'none';
  document.getElementById('resetPasswordNew').value = '';
  document.getElementById('createOrgPanel').style.display = 'none';
  document.getElementById('editOrgPanel').style.display = 'block';

  const userSelect = document.getElementById('resetPasswordUser');
  userSelect.innerHTML = '<option value="">Loading&hellip;</option>';
  try{
    const users = await apiGet('/super-admin/organizations/'+orgId+'/users');
    userSelect.innerHTML = users.length===0
      ? '<option value="">No users in this organization</option>'
      : users.map(u=>`<option value="${u.id}">${escapeHtml(u.name)} (@${escapeHtml(u.username)}, ${u.role})</option>`).join('');
  }catch(e){ userSelect.innerHTML = '<option value="">Could not load users</option>'; }
}
window.openEditOrgForm = openEditOrgForm;

function closeEditOrgForm(){
  document.getElementById('editOrgPanel').style.display = 'none';
}
window.closeEditOrgForm = closeEditOrgForm;

document.getElementById('editOrgForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const errEl = document.getElementById('editOrgError');
  errEl.style.display = 'none';
  const orgId = document.getElementById('editOrgId').value;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try{
    await apiPut('/super-admin/organizations/'+orgId, {
      name: document.getElementById('editOrgName').value.trim(),
      active: document.getElementById('editOrgActive').value === '1'
    });
    showToast('Organization updated');
    closeEditOrgForm();
    loadOrganizations();
  }catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }finally{ submitBtn.disabled = false; }
});

async function submitPasswordReset(){
  const orgId = document.getElementById('editOrgId').value;
  const userId = document.getElementById('resetPasswordUser').value;
  const newPassword = document.getElementById('resetPasswordNew').value;
  const errEl = document.getElementById('resetPasswordError');
  errEl.style.display = 'none';
  if(!userId || !newPassword){
    errEl.textContent = 'Select a user and enter a new password';
    errEl.style.display = 'block';
    return;
  }
  try{
    await apiPost('/super-admin/organizations/'+orgId+'/reset-password', { userId, newPassword });
    showToast('Password reset');
    document.getElementById('resetPasswordNew').value = '';
  }catch(e){
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}
window.submitPasswordReset = submitPasswordReset;

document.getElementById('createOrgForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const errEl = document.getElementById('createOrgError');
  errEl.style.display = 'none';
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try{
    await apiPost('/super-admin/organizations', {
      name: document.getElementById('newOrgName').value.trim(),
      orgCode: document.getElementById('newOrgCode').value.trim(),
      tagline: document.getElementById('newOrgTagline').value.trim(),
      adminName: document.getElementById('newOrgAdminName').value.trim(),
      adminUsername: document.getElementById('newOrgAdminUsername').value.trim(),
      adminPassword: document.getElementById('newOrgAdminPassword').value
    });
    showToast('Organization created');
    closeCreateOrgForm();
    loadOrganizations();
  }catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }finally{ submitBtn.disabled = false; }
});

// ============ ORGANIZATION BRANDING (Management only) ============
let brandingPageHasLogo = false;

async function openOrgBranding(){
  if(!isManagement()){ showToast('Only management can view organization branding'); return; }
  switchToRawView('org-branding');
  try{
    const b = await apiGet('/branding');
    document.getElementById('brandName').value = b.companyName || '';
    document.getElementById('brandTagline').value = b.tagline || '';
    document.getElementById('brandApprovedBy').value = b.approvedBy || '';
    document.getElementById('brandDocNoLog').value = b.docNoLog || '';
    document.getElementById('brandDocRevLog').value = b.docRevLog || '';
    document.getElementById('brandDocEffectiveDateLog').value = b.docEffectiveDateLog || '';
    document.getElementById('brandDocIssueLog').value = b.docIssueLog || '';
    document.getElementById('brandDocNoExcel').value = b.docNoExcel || '';
    document.getElementById('brandDocRevExcel').value = b.docRevExcel || '';
    document.getElementById('brandDocEffectiveDateExcel').value = b.docEffectiveDateExcel || '';
    renderLogoPreview(b.hasLogo);
    brandingPageHasLogo = !!b.hasLogo;
    const modeRadio = document.querySelector(`input[name="headerDisplayMode"][value="${b.headerDisplayMode || 'logo_name_tagline'}"]`);
    if(modeRadio) modeRadio.checked = true;
    updateHeaderPreview();
  }catch(e){ showToast('Could not load branding: '+e.message); }
}
window.openOrgBranding = openOrgBranding;

// Live preview in the settings page - mirrors applyHeaderBranding()'s logic,
// but reads whatever's currently typed/selected in the form rather than the
// last-saved brandingCache, and targets the preview box, not the real header.
function updateHeaderPreview(){
  const logoImg = document.getElementById('previewLogoImg');
  const brandIcon = document.getElementById('previewBrandIcon');
  const titleEl = document.getElementById('previewTitle');
  const subtitleEl = document.getElementById('previewSubtitle');
  const badgeEl = document.getElementById('previewCmmsBadge');
  const name = document.getElementById('brandName').value.trim();
  const tagline = document.getElementById('brandTagline').value.trim();
  const modeInput = document.querySelector('input[name="headerDisplayMode"]:checked');
  const mode = modeInput ? modeInput.value : 'logo_name_tagline';

  if(brandingPageHasLogo){
    logoImg.src = API + '/organization/logo?t=' + Date.now();
    logoImg.style.display = 'block';
    brandIcon.style.display = 'none';
    badgeEl.style.display = 'inline-block';
    if(mode === 'logo_only'){
      titleEl.textContent = ''; subtitleEl.textContent = '';
    }else if(mode === 'logo_tagline'){
      titleEl.textContent = ''; subtitleEl.textContent = tagline || 'MAINTENANCE LOG & WORK ORDER SYSTEM';
    }else{
      titleEl.textContent = name || 'STEELWORKS CMMS'; subtitleEl.textContent = tagline || 'MAINTENANCE LOG & WORK ORDER SYSTEM';
    }
  }else{
    logoImg.style.display = 'none';
    brandIcon.style.display = '';
    badgeEl.style.display = 'none';
    titleEl.textContent = 'STEELWORKS CMMS';
    subtitleEl.textContent = name ? `${name} \u2014 MAINTENANCE LOG & WORK ORDER SYSTEM` : 'MAINTENANCE LOG & WORK ORDER SYSTEM';
  }
}
document.querySelectorAll('input[name="headerDisplayMode"]').forEach(r=>r.addEventListener('change', updateHeaderPreview));
document.getElementById('brandName').addEventListener('input', updateHeaderPreview);
document.getElementById('brandTagline').addEventListener('input', updateHeaderPreview);

function renderLogoPreview(hasLogo){
  const img = document.getElementById('logoPreviewImg');
  const placeholder = document.getElementById('logoPreviewPlaceholder');
  const removeBtn = document.getElementById('removeLogoBtn');
  if(hasLogo){
    img.src = API + '/organization/logo?t=' + Date.now(); // cache-bust after upload/remove
    img.style.display = 'block';
    placeholder.style.display = 'none';
    removeBtn.style.display = '';
  }else{
    img.style.display = 'none';
    placeholder.style.display = 'block';
    removeBtn.style.display = 'none';
  }
}

document.getElementById('logoFileInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const fd = new FormData();
  fd.append('logo', file);
  try{
    const res = await fetch(API+'/organization/logo', { method:'POST', credentials:'same-origin', body: fd });
    if(res.status===401){ showLoginGate(); return; }
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'Upload failed');
    showToast('Logo uploaded');
    brandingCache = null; logoDataUrlCache = undefined; // force re-fetch next time a PDF is generated
    renderLogoPreview(true);
    brandingPageHasLogo = true;
    updateHeaderPreview();
    await loadBranding();
    applyHeaderBranding();
  }catch(err){ showToast('Could not upload logo: '+err.message); }
  e.target.value = '';
});

async function removeOrgLogo(){
  if(!confirm('Remove the organization logo? Documents will fall back to text-only branding.')) return;
  try{
    await apiDelete('/organization/logo');
    showToast('Logo removed');
    brandingCache = null; logoDataUrlCache = undefined;
    renderLogoPreview(false);
    brandingPageHasLogo = false;
    updateHeaderPreview();
    await loadBranding();
    applyHeaderBranding();
  }catch(e){ showToast('Could not remove logo: '+e.message); }
}
window.removeOrgLogo = removeOrgLogo;

document.getElementById('orgBrandingForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try{
    const modeInput = document.querySelector('input[name="headerDisplayMode"]:checked');
    await apiPut('/organization/branding', {
      name: document.getElementById('brandName').value.trim(),
      tagline: document.getElementById('brandTagline').value.trim(),
      approvedBy: document.getElementById('brandApprovedBy').value.trim(),
      docNoLog: document.getElementById('brandDocNoLog').value.trim(),
      docRevLog: document.getElementById('brandDocRevLog').value.trim(),
      docEffectiveDateLog: document.getElementById('brandDocEffectiveDateLog').value.trim(),
      docIssueLog: document.getElementById('brandDocIssueLog').value.trim(),
      docNoExcel: document.getElementById('brandDocNoExcel').value.trim(),
      docRevExcel: document.getElementById('brandDocRevExcel').value.trim(),
      docEffectiveDateExcel: document.getElementById('brandDocEffectiveDateExcel').value.trim(),
      headerDisplayMode: modeInput ? modeInput.value : 'logo_name_tagline'
    });
    brandingCache = null; logoDataUrlCache = undefined; // force re-fetch so PDFs use the new values
    showToast('Branding saved');
    await loadBranding();
    applyHeaderBranding();
  }catch(err){ showToast('Could not save branding: '+err.message); }
  finally{ submitBtn.disabled = false; }
});

function openUserForm(id){
  if(!isManagement()){ showToast('Only management can manage user accounts'); return; }
  document.getElementById('userForm').reset();
  document.getElementById('userFormId').value = '';
  const pwField = document.getElementById('uPassword');
  const pwNote = document.getElementById('uPasswordNote');
  if(id){
    const u = (window._usersCache||[]).find(x=>x.id===id);
    if(!u){ showToast('User not found'); return; }
    document.getElementById('userFormTitle').textContent = 'Edit User';
    document.getElementById('userFormSubmit').textContent = 'Save Changes';
    document.getElementById('userFormId').value = id;
    document.getElementById('uName').value = u.name;
    document.getElementById('uUsername').value = u.username;
    document.getElementById('uUsername').disabled = true;
    document.getElementById('uRole').value = u.role;
    pwField.required = false;
    pwNote.textContent = '(leave blank to keep current password)';
  }else{
    document.getElementById('userFormTitle').textContent = 'Add User';
    document.getElementById('userFormSubmit').textContent = 'Add User';
    document.getElementById('uUsername').disabled = false;
    pwField.required = true;
    pwNote.textContent = '';
  }
  switchToRawView('user-form');
}
window.openUserForm = openUserForm;

document.getElementById('userForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const id = document.getElementById('userFormId').value;
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try{
    if(id){
      const payload = { name: document.getElementById('uName').value.trim(), role: document.getElementById('uRole').value };
      const pw = document.getElementById('uPassword').value;
      if(pw) payload.password = pw;
      await apiPut('/users/'+id, payload);
      showToast('User updated');
    }else{
      await apiPost('/users', {
        name: document.getElementById('uName').value.trim(),
        username: document.getElementById('uUsername').value.trim(),
        password: document.getElementById('uPassword').value,
        role: document.getElementById('uRole').value
      });
      showToast('User added');
    }
    switchView('admin');
  }catch(err){ showToast('Could not save user: '+err.message); }
  finally{ submitBtn.disabled = false; }
});

async function deleteUser(id, name){
  if(!confirm(`Delete user "${name}"? This can't be undone.`)) return;
  try{ await apiDelete('/users/'+id); showToast('User deleted'); loadAdminPage(); }
  catch(e){ showToast('Could not delete user: '+e.message); }
}
window.deleteUser = deleteUser;

// ============ REPORTS ============
function initReports(){
  document.getElementById('dailyDate').value = todayISO();
  const now = new Date();
  document.getElementById('monthlyDate').value = now.toISOString().slice(0,7);
  document.getElementById('yearlyDate').value = now.getFullYear();
  loadDailyReport();
}
document.querySelectorAll('.subtabs button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.subtabs button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.report-view').forEach(v=>v.classList.remove('active'));
    document.getElementById('report-'+btn.dataset.report).classList.add('active');
    if(btn.dataset.report==='daily') loadDailyReport();
    if(btn.dataset.report==='monthly') loadMonthlyReport();
    if(btn.dataset.report==='yearly') loadYearlyReport();
  });
});

let lastDailyData=null, lastMonthlyData=null, lastYearlyData=null;

async function loadDailyReport(){
  const date = document.getElementById('dailyDate').value || todayISO();
  try{
    const data = await apiGet('/reports/daily?date='+date);
    lastDailyData = data;
    document.getElementById('dailyTotalLogs').textContent = data.totalLogs;
    document.getElementById('dailyPreventive').textContent = data.preventiveCount;
    document.getElementById('dailyBreakdown').textContent = data.breakdownCount;
    document.getElementById('dailyDowntime').textContent = data.totalDowntime.toFixed(1);
    destroyChart('daily');
    if(typeof Chart !== 'undefined'){
      chartRefs.daily = new Chart(document.getElementById('dailyChart'), {
        type:'bar',
        data:{ labels:['Preventive','Breakdown'], datasets:[{ data:[data.preventiveCount,data.breakdownCount], backgroundColor:['#0B2545','#B3261E'] }] },
        options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
          scales:{ x:{ticks:{color:'#6B7280'},grid:{display:false}}, y:{ticks:{color:'#6B7280',stepSize:1},grid:{color:'#E2E5EA'},beginAtZero:true} } }
      });
    }
    const list = document.getElementById('dailyLogsList');
    list.innerHTML = data.logs.length===0 ? '<div class="empty-state"><div class="big">No logs on this date</div></div>' : data.logs.map(l=>logEntryHtml(l,true)).join('');
  }catch(e){ if(e.message!=='Session expired') showToast('Could not load daily report: '+e.message); }
}
window.loadDailyReport = loadDailyReport;

async function loadMonthlyReport(){
  const val = document.getElementById('monthlyDate').value;
  const [year, month] = val ? val.split('-') : [todayISO().slice(0,4), (new Date().getMonth()+1).toString().padStart(2,'0')];
  try{
    const data = await apiGet(`/reports/monthly?year=${year}&month=${parseInt(month)}`);
    lastMonthlyData = data;
    document.getElementById('monthlyTotalLogs').textContent = data.totalLogs;
    document.getElementById('monthlyPreventive').textContent = data.preventiveCount;
    document.getElementById('monthlyBreakdown').textContent = data.breakdownCount;
    document.getElementById('monthlyDowntime').textContent = data.totalDowntime.toFixed(1);
    destroyChart('monthly');
    if(typeof Chart !== 'undefined'){
      chartRefs.monthly = new Chart(document.getElementById('monthlyChart'), {
        type:'bar',
        data:{
          labels: data.dailyBreakdown.map(d=>d.day.slice(8)),
          datasets:[
            {label:'Preventive', data:data.dailyBreakdown.map(d=>d.preventive), backgroundColor:'#0B2545'},
            {label:'Breakdown', data:data.dailyBreakdown.map(d=>d.breakdown), backgroundColor:'#B3261E'}
          ]
        },
        options:{ responsive:true, maintainAspectRatio:false,
          scales:{ x:{ticks:{color:'#6B7280'},grid:{display:false}}, y:{ticks:{color:'#6B7280',stepSize:1},grid:{color:'#E2E5EA'},beginAtZero:true} },
          plugins:{legend:{labels:{color:'#1B2430'}}} }
      });
    }
  }catch(e){ if(e.message!=='Session expired') showToast('Could not load monthly report: '+e.message); }
}
window.loadMonthlyReport = loadMonthlyReport;

async function loadYearlyReport(){
  const year = document.getElementById('yearlyDate').value || new Date().getFullYear();
  try{
    const data = await apiGet('/reports/yearly?year='+year);
    lastYearlyData = data;
    document.getElementById('yearlyTotalLogs').textContent = data.totalLogs;
    document.getElementById('yearlyPreventive').textContent = data.preventiveCount;
    document.getElementById('yearlyBreakdown').textContent = data.breakdownCount;
    document.getElementById('yearlyDowntime').textContent = data.totalDowntime.toFixed(1);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    destroyChart('yearly');
    if(typeof Chart !== 'undefined'){
      chartRefs.yearly = new Chart(document.getElementById('yearlyChart'), {
        type:'bar',
        data:{
          labels: data.monthlyBreakdown.map(m=>monthNames[parseInt(m.month)-1]),
          datasets:[
            {label:'Preventive', data:data.monthlyBreakdown.map(m=>m.preventive), backgroundColor:'#0B2545'},
            {label:'Breakdown', data:data.monthlyBreakdown.map(m=>m.breakdown), backgroundColor:'#B3261E'}
          ]
        },
        options:{ responsive:true, maintainAspectRatio:false,
          scales:{ x:{ticks:{color:'#6B7280'},grid:{display:false}}, y:{ticks:{color:'#6B7280',stepSize:1},grid:{color:'#E2E5EA'},beginAtZero:true} },
          plugins:{legend:{labels:{color:'#1B2430'}}} }
      });
    }
  }catch(e){ if(e.message!=='Session expired') showToast('Could not load yearly report: '+e.message); }
}
window.loadYearlyReport = loadYearlyReport;

// ============ PDF EXPORT ============

// Mirrors server.js's computeLogoBox() exactly - sizes a logo from its real
// aspect ratio instead of forcing every logo into the same fixed square,
// which either squished wide wordmark logos or left square ones tiny.
// targetHeight/maxWidth are in mm (jsPDF's unit). Falls back to a square box
// if dimensions aren't known yet (e.g. branding loaded before this shipped).
function computeLogoBoxMM(logoWidth, logoHeight, targetHeight, maxWidth){
  const aspectRatio = (logoWidth && logoHeight) ? logoWidth / logoHeight : 1;
  let boxHeight = targetHeight;
  let boxWidth = boxHeight * aspectRatio;
  if(boxWidth > maxWidth){
    boxWidth = maxWidth;
    boxHeight = boxWidth / aspectRatio;
  }
  return { width: boxWidth, height: boxHeight };
}

// Used by Daily/Monthly/Yearly report PDFs - letterhead only, no document-code box
async function pdfHeader(doc, title, subtitle){
  const b = brandingCache || {};
  const mode = b.headerDisplayMode || 'logo_name_tagline';
  const logo = await loadLogoDataUrl();
  let textX = 14;
  if(logo){
    try{
      const fmt = logo.indexOf('image/png') !== -1 ? 'PNG' : 'JPEG';
      const box = computeLogoBoxMM(b.logoWidth, b.logoHeight, 16, 100);
      doc.addImage(logo, fmt, 14, 5, box.width, box.height);
      textX = 14 + box.width + 4;
    }catch(e){ textX = 14; }
  }
  doc.setTextColor(11,37,69);
  if(mode === 'logo_name_tagline'){
    doc.setFont(undefined,'bold');
    doc.setFontSize(15);
    doc.text(b.companyName || 'STEELWORKS CMMS', textX, 15);
    doc.setFont(undefined,'normal');
    doc.setFontSize(8);
    doc.setTextColor(107,114,128);
    doc.text(b.tagline || 'MAINTENANCE LOG & WORK ORDER SYSTEM', textX, 20);
  }else if(mode === 'logo_tagline'){
    doc.setFont(undefined,'bold');
    doc.setFontSize(12);
    doc.text(b.tagline || 'STEELWORKS CMMS', textX, 17);
  }
  // logo_only: no name/tagline text at all, just the logo image above
  doc.setDrawColor(226,229,234);
  doc.line(14, 24, 196, 24);
  doc.setTextColor(20,20,20);
  doc.setFont(undefined,'bold');
  doc.setFontSize(13);
  doc.text(title, 14, 33);
  doc.setFont(undefined,'normal');
  doc.setFontSize(9);
  doc.setTextColor(107,114,128);
  if(subtitle) doc.text(subtitle, 14, 39);
  doc.setTextColor(20,20,20);
}
function addChartImage(doc, canvasId, y){
  try{
    const canvas = document.getElementById(canvasId);
    const img = canvas.toDataURL('image/png',1.0);
    doc.addImage(img, 'PNG', 14, y, 180, 80);
    return y + 90;
  }catch(e){ return y; }
}

// Individual log PDF - follows the Breakdown Report Form layout (same doc code for Preventive and Breakdown)
async function downloadLogPDF(id){
  const l = logCache[id];
  if(!l){ showToast('Log details not available to export'); return; }
  if(typeof window.jspdf === 'undefined'){ showToast('PDF library failed to load. Check your internet connection.'); return; }
  if(!brandingCache) await loadBranding();
  const b = brandingCache;
  const logo = await loadLogoDataUrl();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const M = 14, W = 182; // left margin, content width (page is 210mm wide)

  // ---- Letterhead / document-control header ----
  const mode = b.headerDisplayMode || 'logo_name_tagline';
  let brandTextX = M;
  if(logo){
    try{
      const fmt = logo.indexOf('image/png') !== -1 ? 'PNG' : 'JPEG';
      const box = computeLogoBoxMM(b.logoWidth, b.logoHeight, 16, 88);
      doc.addImage(logo, fmt, M, 6, box.width, box.height);
      brandTextX = M + box.width + 4;
    }catch(e){ brandTextX = M; }
  }
  if(mode === 'logo_name_tagline'){
    doc.setFont(undefined,'bold'); doc.setFontSize(14); doc.setTextColor(11,37,69);
    doc.text(b.companyName || 'STEELWORKS CMMS', brandTextX, 14);
    doc.setFont(undefined,'normal'); doc.setFontSize(7.5); doc.setTextColor(107,114,128);
    doc.text(b.tagline || '', brandTextX, 18.5);
  }else if(mode === 'logo_tagline'){
    doc.setFont(undefined,'bold'); doc.setFontSize(11); doc.setTextColor(11,37,69);
    doc.text(b.tagline || 'STEELWORKS CMMS', brandTextX, 16.5);
  }
  // logo_only: no name/tagline text, just the logo image above

  doc.setFontSize(8.5); doc.setTextColor(20,20,20);
  doc.text(`Document No. ${b.docNoLog}`, 130, 12);
  doc.text(`Effective Date: ${b.docEffectiveDateLog}    Issue: ${b.docIssueLog}    Rev: ${b.docRevLog}`, 130, 17);
  doc.text(`Approved By: ${b.approvedBy || 'N/A'}`, 130, 22);

  doc.setDrawColor(180,180,180);
  doc.rect(M, 6, W, 20);
  doc.line(126, 6, 126, 26);

  doc.setFont(undefined,'bold'); doc.setFontSize(12); doc.setTextColor(20,20,20);
  const titleText = `${l.logType.toUpperCase()} MAINTENANCE REPORT`;
  doc.text(titleText, 105, 33, { align: 'center' });

  let y = 40;
  const sectionGap = 6;

  function sectionHeading(text){
    doc.setFillColor(234,240,248);
    doc.rect(M, y - 4.5, W, 6.5, 'F');
    doc.setFont(undefined,'bold'); doc.setFontSize(9.5); doc.setTextColor(11,37,69);
    doc.text(text, M + 2, y);
    y += 7;
    doc.setTextColor(20,20,20);
  }
  function field(label, value){
    doc.setFont(undefined,'bold'); doc.setFontSize(9); doc.setTextColor(80,80,80);
    doc.text(label + ':', M, y);
    doc.setFont(undefined,'normal'); doc.setTextColor(20,20,20);
    const lines = doc.splitTextToSize(String(value || 'N/A'), W - 45);
    doc.text(lines, M + 42, y);
    y += Math.max(6, lines.length * 5);
  }
  function paragraph(label, text){
    doc.setFont(undefined,'bold'); doc.setFontSize(9); doc.setTextColor(80,80,80);
    doc.text(label + ':', M, y);
    y += 5;
    doc.setFont(undefined,'normal'); doc.setTextColor(20,20,20);
    const lines = doc.splitTextToSize(String(text || 'N/A'), W - 4);
    doc.text(lines, M, y);
    y += lines.length * 5 + 3;
  }

  // Derived start/end clock times (no dedicated fields captured at entry - estimated from downtime)
  const endDate = new Date(l.loggedAt);
  const startDate = new Date(endDate.getTime() - (l.downtimeHours || 0) * 3600000);
  const timeFmt = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  sectionHeading('1. GENERAL INFORMATION');
  field('Date', fmtDate(l.loggedAt.slice(0,10)));
  field('Location', l.machineLocation || 'N/A');
  field('Reported By', l.logType === 'Breakdown' ? (l.reportedBy || 'N/A') : 'N/A (Preventive Maintenance)');
  y += 2;

  sectionHeading('2. EQUIPMENT / ASSET INFORMATION');
  field('Machine Name', l.machineName);
  field('Asset Code', l.machineCode);
  field('Department', l.machineDepartment || 'N/A');
  y += 2;

  sectionHeading('3. MAINTENANCE DETAILS');
  field('Start Time (est.)', timeFmt(startDate));
  field('End Time (est.)', timeFmt(endDate));
  field('Downtime', `${l.downtimeHours} hour(s)`);
  doc.setFont(undefined,'italic'); doc.setFontSize(7.5); doc.setTextColor(140,140,140);
  doc.text('Start/End times are estimated from logged downtime hours, not entered directly by the technician.', M, y);
  doc.setFont(undefined,'normal'); doc.setTextColor(20,20,20);
  y += sectionGap;

  sectionHeading('4. ISSUE DESCRIPTION');
  paragraph('Findings / Diagnosis', l.findings);

  sectionHeading('5. ACTION TAKEN');
  paragraph('Steps / Actions Taken', l.actionsTaken);
  field('Parts / Materials Used', l.partsUsed || 'NIL');
  y += 2;

  sectionHeading('6. TECHNICIAN DETAILS');
  field('Technician', l.technician);
  field('Signature', '_______________________');
  y += 4;

  // page-break check before remarks/footer
  if(y > 240){ doc.addPage(); y = 20; }

  sectionHeading('7. ADDITIONAL REMARKS / NOTES');
  doc.setDrawColor(210,210,210);
  doc.rect(M, y - 4, W, 16);
  y += 18;

  if(y > 255){ doc.addPage(); y = 20; }

  // ---- Footer: Reviewed By only (Approved By intentionally omitted) ----
  sectionHeading('REVIEW');
  doc.setDrawColor(180,180,180);
  const rowH = 9;
  doc.rect(M, y, W, rowH * 2);
  doc.line(M, y + rowH, M + W, y + rowH);
  const colX = [M, M + 45, M + 90, M + 135];
  colX.forEach((x, i) => { if(i>0) doc.line(x, y, x, y + rowH * 2); });
  doc.setFont(undefined,'bold'); doc.setFontSize(8);
  ['Name', 'Position', 'Signature', 'Date'].forEach((h, i) => doc.text(h, colX[i] + 2, y + 5.5));
  doc.setFont(undefined,'normal');
  doc.setFont(undefined,'bold'); doc.setFontSize(7.5);
  doc.text('Reviewed By', colX[0] + 2, y + rowH + 6);
  doc.setFont(undefined,'normal'); doc.setFontSize(8.5);
  doc.text(l.reviewedBy || '\u2014', colX[1] + 2, y + rowH + 6);
  doc.text(l.reviewedByRole || '\u2014', colX[2] + 2, y + rowH + 6);
  doc.text(l.reviewedAt ? fmtDate(l.reviewedAt.slice(0,10)) : '\u2014', colX[3] + 2, y + rowH + 6);

  doc.setFont(undefined,'normal'); doc.setFontSize(7); doc.setTextColor(140,140,140);
  doc.text(`Generated by STEELWORKS CMMS on ${new Date().toLocaleString()}`, M, 290);

  doc.save(`${l.id}-${l.logType.toLowerCase()}-report.pdf`);
}
window.downloadLogPDF = downloadLogPDF;

async function downloadDailyPDF(){
  if(!lastDailyData){ showToast('Load the report first'); return; }
  if(typeof window.jspdf === 'undefined'){ showToast('PDF library failed to load. Check your internet connection.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const data = lastDailyData;
  await pdfHeader(doc, 'Daily Maintenance Report', `Date: ${fmtDate(data.date)}`);
  let y = 46;
  doc.setFontSize(11);
  [['Total Logs', data.totalLogs], ['Preventive', data.preventiveCount], ['Breakdown', data.breakdownCount], ['Total Downtime (hrs)', data.totalDowntime.toFixed(1)]].forEach(([label,val])=>{
    doc.setFont(undefined,'bold'); doc.text(label+':', 14, y);
    doc.setFont(undefined,'normal'); doc.text(String(val), 90, y);
    y += 8;
  });
  y = addChartImage(doc, 'dailyChart', y+4);
  doc.setFont(undefined,'bold'); doc.text('Logs:', 14, y); y += 8;
  doc.setFont(undefined,'normal'); doc.setFontSize(9);
  data.logs.forEach(l=>{
    if(y > 270){ doc.addPage(); y = 20; }
    doc.text(`${l.machineName} (${l.machineCode}) \u2014 ${l.logType}, ${l.status}, ${l.technician}`, 14, y);
    y += 6;
  });
  doc.save(`daily-report-${data.date}.pdf`);
}
window.downloadDailyPDF = downloadDailyPDF;

async function downloadMonthlyPDF(){
  if(!lastMonthlyData){ showToast('Load the report first'); return; }
  if(typeof window.jspdf === 'undefined'){ showToast('PDF library failed to load. Check your internet connection.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const data = lastMonthlyData;
  await pdfHeader(doc, 'Monthly Maintenance Report', `${data.year}-${data.month}`);
  let y = 46;
  doc.setFontSize(11);
  [['Total Logs', data.totalLogs], ['Preventive', data.preventiveCount], ['Breakdown', data.breakdownCount], ['Total Downtime (hrs)', data.totalDowntime.toFixed(1)]].forEach(([label,val])=>{
    doc.setFont(undefined,'bold'); doc.text(label+':', 14, y);
    doc.setFont(undefined,'normal'); doc.text(String(val), 90, y);
    y += 8;
  });
  addChartImage(doc, 'monthlyChart', y+4);
  doc.save(`monthly-report-${data.year}-${data.month}.pdf`);
}
window.downloadMonthlyPDF = downloadMonthlyPDF;

async function downloadYearlyPDF(){
  if(!lastYearlyData){ showToast('Load the report first'); return; }
  if(typeof window.jspdf === 'undefined'){ showToast('PDF library failed to load. Check your internet connection.'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const data = lastYearlyData;
  await pdfHeader(doc, 'Yearly Maintenance Report', `Year: ${data.year}`);
  let y = 46;
  doc.setFontSize(11);
  [['Total Logs', data.totalLogs], ['Preventive', data.preventiveCount], ['Breakdown', data.breakdownCount], ['Total Downtime (hrs)', data.totalDowntime.toFixed(1)]].forEach(([label,val])=>{
    doc.setFont(undefined,'bold'); doc.text(label+':', 14, y);
    doc.setFont(undefined,'normal'); doc.text(String(val), 90, y);
    y += 8;
  });
  addChartImage(doc, 'yearlyChart', y+4);
  doc.save(`yearly-report-${data.year}.pdf`);
}
window.downloadYearlyPDF = downloadYearlyPDF;

// ============ INIT ============
checkSession();
