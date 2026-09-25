const API = '';

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

// ─── LOGIN / LOGOUT ───
async function doLogin() {
  const pw = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  if (!pw) { errEl.textContent = 'Password required'; return; }
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: jsonHeaders(), credentials: 'same-origin',
      body: JSON.stringify({ password: pw })
    });
    if (res.ok) {
      document.getElementById('login-overlay').style.display = 'none';
      document.getElementById('login-password').value = '';
      initDashboard();
    } else {
      const d = await res.json();
      errEl.textContent = d.error || 'Login failed';
      document.getElementById('login-password').value = '';
    }
  } catch (e) {
    errEl.textContent = 'Network error — is the server running?';
  }
}

async function doLogout() {
  await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
  document.getElementById('login-overlay').style.display = 'flex';
}

// ─── SECTION ROUTING ───
function showSection(name, triggerEl) {
  document.querySelectorAll('[id^="section-"]').forEach(el => el.style.display = 'none');
  document.getElementById(`section-${name}`).style.display = 'block';
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  triggerEl?.closest('.nav-item')?.classList.add('active');

  if (name === 'dashboard') loadDashboard();
  if (name === 'logs') loadLogs();
  if (name === 'employees') loadEmployees();
  if (name === 'settings') loadSettings();
}

// ─── TOAST ───
function toast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ─── DASHBOARD ───
async function loadDashboard() {
  const dateEl = document.getElementById('dash-date');
  if (!dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];
  const date = dateEl.value;

  try {
    const res = await fetch(`${API}/api/admin/summary?date=${date}`, { credentials: 'same-origin' });
    const data = await res.json();
    const { stats, employees } = data;

    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-present').textContent = stats.present;
    document.getElementById('stat-absent').textContent = stats.absent;
    document.getElementById('stat-out').textContent = stats.checkedOut;
    document.getElementById('stat-flagged').textContent = stats.flagged;

    const tbody = document.getElementById('summary-table');
    if (!employees.length) { tbody.innerHTML = '<tr class="loading-row"><td colspan="7">No employees found.</td></tr>'; return; }

    tbody.innerHTML = employees.map(e => {
      const ci = e.check_in ? new Date(e.check_in).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit'}) : '—';
      const co = e.check_out ? new Date(e.check_out).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit'}) : '—';
      let duration = '—';
      if (e.check_in && e.check_out) {
        const mins = Math.round((new Date(e.check_out) - new Date(e.check_in)) / 60000);
        duration = `${Math.floor(mins/60)}h ${mins%60}m`;
      }
      const status = !e.check_in ? `<span class="badge badge-absent">⬜ Absent</span>`
        : !e.check_out ? `<span class="badge badge-partial">🟡 Working</span>`
        : `<span class="badge badge-present">✅ Done</span>`;
      const geo = e.flagged ? `<span class="badge badge-flagged">🚩 Flagged</span>` :
        e.check_in ? `<span class="badge badge-ok">✓ OK</span>` : '—';
      const dur = duration !== '—' ? `<span class="duration-pill">${duration}</span>` : '—';
      return `<tr>
        <td><strong>${e.name}</strong><br/><span class="mono">${e.employee_id}</span></td>
        <td><span class="dept-tag">${e.department || '—'}</span></td>
        <td class="mono">${ci}</td>
        <td class="mono">${co}</td>
        <td>${dur}</td>
        <td>${status}</td>
        <td>${geo}</td>
      </tr>`;
    }).join('');

    window._summaryData = employees;
  } catch (e) {
    toast('Failed to load dashboard: ' + e.message, 'error');
  }
}

function filterTable(q) {
  if (!window._summaryData) return;
  const data = window._summaryData.filter(e =>
    e.name.toLowerCase().includes(q.toLowerCase()) ||
    e.employee_id.toLowerCase().includes(q.toLowerCase())
  );
  // Re-render with filter — simple approach
}

// ─── LOGS ───
async function loadLogs() {
  const dateEl = document.getElementById('log-date');
  if (!dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];

  try {
    const res = await fetch(`${API}/api/admin/attendance?date=${dateEl.value}`, { credentials: 'same-origin' });
    const rows = await res.json();
    const tbody = document.getElementById('logs-table');

    if (!rows.length) { tbody.innerHTML = '<tr class="loading-row"><td colspan="7">No records for this date.</td></tr>'; return; }

    tbody.innerHTML = rows.map(r => {
      const t = new Date(r.timestamp).toLocaleTimeString('en-IN', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const action = r.action === 'in'
        ? '<span class="badge badge-present">✅ IN</span>'
        : '<span class="badge badge-partial">🚪 OUT</span>';
      const geo = r.within_geofence === true ? '<span class="badge badge-ok">✓ Inside</span>'
        : r.within_geofence === false ? '<span class="badge badge-flagged">🚩 Outside</span>'
        : '<span style="color:var(--muted2)">—</span>';
      const gps = r.latitude ? `${parseFloat(r.latitude).toFixed(4)}, ${parseFloat(r.longitude).toFixed(4)}` : '—';
      return `<tr>
        <td class="mono">${t}</td>
        <td><strong>${r.name}</strong><br/><span class="mono">${r.employee_id}</span></td>
        <td>${action}</td>
        <td><span class="dept-tag">${r.department || '—'}</span></td>
        <td class="mono" style="font-size:0.75rem">${gps}</td>
        <td>${geo}</td>
        <td class="mono" style="font-size:0.75rem">${r.ip_address || '—'}</td>
      </tr>`;
    }).join('');

    window._logsData = rows;
  } catch (e) {
    toast('Failed to load logs: ' + e.message, 'error');
  }
}

function exportCSV() {
  if (!window._logsData?.length) return toast('No data to export', 'error');
  const headers = ['Time', 'Name', 'Employee ID', 'Action', 'Department', 'Latitude', 'Longitude', 'Geofence', 'IP'];
  const rows = window._logsData.map(r => [
    new Date(r.timestamp).toISOString(), r.name, r.employee_id, r.action,
    r.department, r.latitude, r.longitude, r.within_geofence, r.ip_address
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `attendance-${document.getElementById('log-date').value}.csv`;
  a.click();
  toast('CSV downloaded!');
}

// ─── EMPLOYEES ───
async function loadEmployees() {
  try {
    const res = await fetch(`${API}/api/admin/employees`, { credentials: 'same-origin' });
    const emps = await res.json();
    const tbody = document.getElementById('emp-table');
    tbody.innerHTML = emps.map(e => `<tr>
      <td class="mono">${e.employee_id}</td>
      <td><strong>${e.name}</strong></td>
      <td><span class="dept-tag">${e.department || '—'}</span></td>
      <td class="mono">${e.phone}</td>
      <td><span class="badge ${e.active ? 'badge-present' : 'badge-absent'}">${e.active ? '✓ Active' : '✗ Inactive'}</span></td>
      <td class="mono" style="font-size:0.8rem">${new Date(e.created_at).toLocaleDateString('en-IN')}</td>
    </tr>`).join('');
  } catch (e) {
    toast('Failed to load employees', 'error');
  }
}

async function addEmployee() {
  const body = {
    name: document.getElementById('emp-name').value.trim(),
    employee_id: document.getElementById('emp-id').value.trim(),
    phone: document.getElementById('emp-phone').value.trim(),
    department: document.getElementById('emp-dept').value.trim()
  };
  if (!body.name || !body.employee_id || !body.phone) return toast('Name, ID and Phone are required', 'error');

  try {
    const res = await fetch(`${API}/api/admin/employees`, { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify(body) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    toast(`✅ ${data.name} added!`);
    ['emp-name','emp-id','emp-phone','emp-dept'].forEach(id => document.getElementById(id).value = '');
    loadEmployees();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ─── SETTINGS ───
async function loadSettings() {
  try {
    const res = await fetch(`${API}/api/admin/office`, { credentials: 'same-origin' });
    const office = await res.json();
    if (office) {
      document.getElementById('office-name').value = office.name || '';
      document.getElementById('office-lat').value = office.latitude || '';
      document.getElementById('office-lng').value = office.longitude || '';
      document.getElementById('office-radius').value = office.radius_meters || 200;
    }
    document.getElementById('webhook-url').textContent = `${window.location.origin}/api/whatsapp/webhook`;
  } catch (e) {}
}

async function saveOffice() {
  const body = {
    name: document.getElementById('office-name').value,
    latitude: parseFloat(document.getElementById('office-lat').value),
    longitude: parseFloat(document.getElementById('office-lng').value),
    radius_meters: parseInt(document.getElementById('office-radius').value)
  };
  if (!body.latitude || !body.longitude) return toast('Latitude and Longitude required', 'error');
  try {
    const res = await fetch(`${API}/api/admin/office`, { method: 'PUT', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify(body) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    toast('✅ Office location saved!');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function useCurrentLocation() {
  if (!navigator.geolocation) return toast('Geolocation not supported', 'error');
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('office-lat').value = pos.coords.latitude.toFixed(6);
    document.getElementById('office-lng').value = pos.coords.longitude.toFixed(6);
    toast('📍 Location captured!');
  }, () => toast('Could not get location', 'error'), {enableHighAccuracy:true});
}

// ─── SIMULATOR ───
async function simulate() {
  const phone = document.getElementById('sim-phone').value.trim();
  const message = document.getElementById('sim-action').value;
  if (!phone) return toast('Enter a phone number', 'error');

  try {
    const res = await fetch(`${API}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone, message })
    });
    const data = await res.json();
    const box = document.getElementById('sim-result');
    const replyEl = document.getElementById('sim-reply');
    const linkEl = document.getElementById('sim-link');
    const linkBtn = document.getElementById('sim-link-btn');

    box.style.display = 'block';
    replyEl.textContent = data.reply || data.error || 'No response';

    const urlMatch = data.reply?.match(/https?:\/\/\S+/);
    if (urlMatch) {
      linkEl.textContent = urlMatch[0];
      linkBtn.href = urlMatch[0];
      linkBtn.style.display = 'inline-flex';
    } else {
      linkEl.textContent = '';
      linkBtn.style.display = 'none';
    }

    toast(data.employee ? `✅ Link generated for ${data.employee}` : '📩 Response generated');
  } catch (e) {
    toast('Simulation failed: ' + e.message, 'error');
  }
}

// ─── INIT ───
function initDashboard() {
  document.getElementById('dash-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('log-date').value = new Date().toISOString().split('T')[0];
  loadDashboard();
}

document.addEventListener('DOMContentLoaded', async () => {
  // ── Wire up nav items ──
  document.querySelector('[data-section="dashboard"]').addEventListener('click', function(e) {
    e.preventDefault(); showSection('dashboard', this);
  });
  document.querySelector('[data-section="logs"]').addEventListener('click', function(e) {
    e.preventDefault(); showSection('logs', this);
  });
  document.querySelector('[data-section="employees"]').addEventListener('click', function(e) {
    e.preventDefault(); showSection('employees', this);
  });
  document.querySelector('[data-section="settings"]').addEventListener('click', function(e) {
    e.preventDefault(); showSection('settings', this);
  });
  document.querySelector('[data-section="test"]').addEventListener('click', function(e) {
    e.preventDefault(); showSection('test', this);
  });
  document.getElementById('logout-btn').addEventListener('click', function(e) {
    e.preventDefault(); doLogout();
  });

  // ── Dashboard ──
  document.getElementById('dash-load-btn').addEventListener('click', loadDashboard);
  document.getElementById('dash-search').addEventListener('input', function() { filterTable(this.value); });

  // ── Logs ──
  document.getElementById('log-filter-btn').addEventListener('click', loadLogs);
  document.getElementById('log-export-btn').addEventListener('click', exportCSV);

  // ── Employees ──
  document.getElementById('add-emp-btn').addEventListener('click', addEmployee);

  // ── Settings ──
  document.getElementById('save-office-btn').addEventListener('click', saveOffice);
  document.getElementById('use-location-btn').addEventListener('click', useCurrentLocation);

  // ── Simulator ──
  document.getElementById('sim-send-btn').addEventListener('click', simulate);

  // ── Login ──
  document.getElementById('login-password').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('login-submit-btn').addEventListener('click', doLogin);

  // ── Check for existing valid session ──
  try {
    const res = await fetch('/api/admin/me', { credentials: 'same-origin' });
    const d = await res.json();
    if (d.authenticated) {
      document.getElementById('login-overlay').style.display = 'none';
      initDashboard();
    }
  } catch (_) { /* login overlay stays visible */ }
});
