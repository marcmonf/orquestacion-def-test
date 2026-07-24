'use strict';
//
// Portal del comercio (M6 Fase 3) — SPA vanilla, separada del panel de admin.
// Habla EXCLUSIVAMENTE con /portal/*: nunca con endpoints globales del backoffice.
// El aislamiento real vive en el servidor (el merchantId sale de la sesión); los
// gates de rol de aquí son solo de UX.
//
const API = '';                     // mismo origen; las rutas son absolutas (/portal/*)
const TOKEN_KEY = 'monetiser_portal_token';
const ROOT = document.getElementById('root');

let state = { me: null, tab: 'resumen', tx: { page: 1, status: '', q: '' } };

const token = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(cents, currency) {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + esc(currency || '');
}
function fmtDate(d) { try { return new Date(d).toLocaleString('es-ES'); } catch { return esc(d); } }

// ── API ────────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: 'Bearer ' + token() } : {}),
      ...(opts.headers || {}),
    },
  });
  let body = {};
  try { body = await res.json(); } catch {}
  if (res.status === 401) { clearToken(); renderLogin('Tu sesión ha caducado. Entra de nuevo.'); throw { handled: true }; }
  if (res.status === 403 && body.error === 'password_change_required') { renderChangePassword(); throw { handled: true }; }
  return { status: res.status, body, ok: res.ok };
}

// ── Vistas de acceso ─────────────────────────────────────────────────────────
function renderLogin(msg) {
  ROOT.innerHTML = `
    <div id="centered"><div class="card">
      <div class="logo-text">Monetiser · Portal</div>
      <p class="muted" style="margin-top:4px">Acceso para usuarios del comercio</p>
      ${msg ? `<div class="banner err">${esc(msg)}</div>` : ''}
      <div id="loginErr"></div>
      <label>Email</label><input id="email" type="email" autocomplete="username" />
      <label>Contraseña</label><input id="password" type="password" autocomplete="current-password" />
      <button id="loginBtn" style="width:100%; margin-top:16px">Entrar</button>
    </div></div>`;
  const submit = async () => {
    const email = val('email'), password = val('password');
    if (!email || !password) return banner('loginErr', 'Introduce email y contraseña.');
    const r = await api('/portal/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (!r.ok) return banner('loginErr', r.body.error === 'rate_limit_exceeded'
      ? 'Demasiados intentos. Espera unos minutos.' : 'Credenciales inválidas.');
    setToken(r.body.token);
    if (r.body.mustChangePassword) return renderChangePassword();
    loadDashboard();
  };
  document.getElementById('loginBtn').onclick = submit;
  document.getElementById('password').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

function renderChangePassword() {
  ROOT.innerHTML = `
    <div id="centered"><div class="card">
      <div class="logo-text">Cambia tu contraseña</div>
      <p class="muted" style="margin-top:4px">Tu contraseña es temporal. Debes cambiarla para continuar.</p>
      <div id="cpErr"></div>
      <label>Contraseña temporal actual</label><input id="cur" type="password" />
      <label>Nueva contraseña (mínimo 8 caracteres)</label><input id="np1" type="password" />
      <label>Repite la nueva contraseña</label><input id="np2" type="password" />
      <button id="cpBtn" style="width:100%; margin-top:16px">Guardar y entrar</button>
    </div></div>`;
  document.getElementById('cpBtn').onclick = async () => {
    const cur = val('cur'), np1 = val('np1'), np2 = val('np2');
    if (np1.length < 8) return banner('cpErr', 'La nueva contraseña debe tener al menos 8 caracteres.');
    if (np1 !== np2) return banner('cpErr', 'Las dos contraseñas no coinciden.');
    const r = await api('/portal/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: np1 }) });
    if (!r.ok) return banner('cpErr', r.body.error === 'invalid_credentials' ? 'La contraseña actual no es correcta.' : 'No se pudo cambiar la contraseña.');
    setToken(r.body.token);
    loadDashboard();
  };
}

// ── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const r = await api('/portal/me');
  if (!r.ok) return renderLogin();
  if (r.body.user.mustChangePassword) return renderChangePassword();
  state.me = r.body.user;
  renderShell();
  selectTab(state.tab);
}

function isAdmin() { return state.me && state.me.role === 'merchant_admin'; }

function renderShell() {
  const tabs = [
    ['resumen', 'Resumen'],
    ['transacciones', 'Transacciones'],
    ...(isAdmin() ? [['usuarios', 'Usuarios'], ['jerarquia', 'Jerarquía']] : []),
  ];
  ROOT.innerHTML = `
    <header class="topbar">
      <div class="row"><span class="logo-text">Monetiser · Portal</span>
        <span class="chip">${esc(state.me.merchantId)}</span></div>
      <div class="row">
        <span class="muted">${esc(state.me.email)} · ${esc(roleLabel(state.me.role))}</span>
        <button class="ghost small" id="logoutBtn">Salir</button>
      </div>
    </header>
    <nav class="tabs" id="tabs">
      ${tabs.map(([k, l]) => `<button data-tab="${k}">${esc(l)}</button>`).join('')}
    </nav>
    <main id="view"></main>`;
  document.getElementById('logoutBtn').onclick = () => { clearToken(); renderLogin('Sesión cerrada.'); };
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab));
}

function roleLabel(r) {
  return { merchant_admin: 'Administrador', merchant_operator: 'Operador', merchant_viewer: 'Solo lectura' }[r] || r;
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'resumen') return viewResumen();
  if (tab === 'transacciones') return viewTransacciones();
  if (tab === 'usuarios') return viewUsuarios();
  if (tab === 'jerarquia') return viewJerarquia();
}
const view = () => document.getElementById('view');

// ── Tab: Resumen ─────────────────────────────────────────────────────────────
async function viewResumen() {
  view().innerHTML = `<div class="card">Cargando métricas…</div>`;
  const r = await api('/portal/analytics/summary');
  if (!r.ok) return view().innerHTML = `<div class="banner err">No se pudieron cargar las métricas.</div>`;
  const s = r.body;
  const kpi = (n, l) => `<div class="card kpi"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  view().innerHTML = `<div class="kpis">
    ${kpi(s.totalTransactions, 'Transacciones')}
    ${kpi(s.approvedTransactions, 'Aprobadas')}
    ${kpi(s.declinedTransactions, 'Rechazadas')}
    ${kpi(s.approvalRate + '%', 'Tasa de aprobación')}
    ${kpi(money(s.totalVolume, 'EUR'), 'Volumen aprobado')}
    ${kpi(money(s.averageTicket, 'EUR'), 'Ticket medio')}
  </div>`;
}

// ── Tab: Transacciones ────────────────────────────────────────────────────────
async function viewTransacciones() {
  const st = state.tx;
  view().innerHTML = `
    <div class="toolbar">
      <div><label>Estado</label>
        <select id="fStatus">
          <option value="">Todos</option>
          ${['approved', 'authorized', 'captured', 'declined', 'refunded', 'partially_refunded', 'cancelled', 'pending_3ds', 'error']
            .map(s => `<option value="${s}" ${st.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      <div style="flex:1"><label>Buscar (paymentId / referencia)</label><input id="fQ" value="${esc(st.q)}" /></div>
      <button id="fApply">Filtrar</button>
    </div>
    <div class="card" id="txTable">Cargando…</div>
    <div class="row" style="justify-content:flex-end; margin-top:12px">
      <button class="ghost small" id="prev">‹ Anterior</button>
      <span class="muted" id="pageLbl"></span>
      <button class="ghost small" id="next">Siguiente ›</button>
    </div>`;
  document.getElementById('fApply').onclick = () => { st.status = val('fStatus'); st.q = val('fQ'); st.page = 1; loadTx(); };
  document.getElementById('prev').onclick = () => { if (st.page > 1) { st.page--; loadTx(); } };
  document.getElementById('next').onclick = () => { st.page++; loadTx(); };
  loadTx();
}
async function loadTx() {
  const st = state.tx;
  const qs = new URLSearchParams({ page: st.page, limit: 20 });
  if (st.status) qs.set('status', st.status);
  if (st.q) qs.set('q', st.q);
  const r = await api('/portal/transactions?' + qs.toString());
  if (!r.ok) return document.getElementById('txTable').innerHTML = `<div class="muted">No se pudieron cargar las transacciones.</div>`;
  const rows = r.body.transactions || [];
  const totalPages = Math.max(1, Math.ceil(r.body.total / r.body.limit));
  document.getElementById('pageLbl').textContent = `Página ${r.body.page} de ${totalPages} · ${r.body.total} total`;
  if (!rows.length) return document.getElementById('txTable').innerHTML = `<div class="muted">Sin transacciones.</div>`;
  document.getElementById('txTable').innerHTML = `
    <table><thead><tr><th>Fecha</th><th>ID de pago</th><th>Importe</th><th>Método</th><th>Conector</th><th>Estado</th></tr></thead>
    <tbody>${rows.map(t => `<tr>
      <td>${fmtDate(t.createdAt)}</td>
      <td><code>${esc((t.paymentId || '').slice(0, 12))}…</code></td>
      <td>${money(t.amount, t.currency)}</td>
      <td>${esc(t.method || '-')}</td>
      <td>${esc(t.processor || '-')}</td>
      <td><span class="status-${esc(t.status)}">${esc(t.status)}</span></td>
    </tr>`).join('')}</tbody></table>`;
}

// ── Tab: Usuarios (solo admin) ─────────────────────────────────────────────────
async function viewUsuarios() {
  view().innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <strong>Crear usuario</strong>
      <div id="uMsg"></div>
      <div class="row" style="margin-top:10px; align-items:end">
        <div style="flex:1; min-width:140px"><label>Nombre</label><input id="uName" /></div>
        <div style="flex:1; min-width:160px"><label>Email</label><input id="uEmail" type="email" /></div>
        <div style="min-width:150px"><label>Rol</label>
          <select id="uRole">
            <option value="merchant_viewer">Solo lectura</option>
            <option value="merchant_operator">Operador</option>
            <option value="merchant_admin">Administrador</option>
          </select></div>
        <button id="uCreate">Crear</button>
      </div>
    </div>
    <div class="card" id="uTable">Cargando…</div>`;
  document.getElementById('uCreate').onclick = async () => {
    const body = { name: val('uName'), email: val('uEmail'), role: val('uRole') };
    if (!body.name || !body.email) return banner('uMsg', 'Nombre y email son obligatorios.');
    const r = await api('/portal/users', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) return banner('uMsg', r.body.error === 'email_already_exists' ? 'Ese email ya existe.' : 'No se pudo crear.');
    banner('uMsg', `Usuario creado. Contraseña temporal (se muestra una vez): ${esc(r.body.tempPassword)}`, 'ok');
    loadUsers();
  };
  loadUsers();
}
async function loadUsers() {
  const r = await api('/portal/users');
  if (!r.ok) return document.getElementById('uTable').innerHTML = `<div class="muted">No se pudieron cargar los usuarios.</div>`;
  const rows = r.body.users || [];
  document.getElementById('uTable').innerHTML = `
    <table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
    <tbody>${rows.map(u => `<tr>
      <td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td>
        <select data-role="${esc(u._id)}">
          ${['merchant_viewer', 'merchant_operator', 'merchant_admin'].map(r2 =>
            `<option value="${r2}" ${u.role === r2 ? 'selected' : ''}>${roleLabel(r2)}</option>`).join('')}
        </select>
      </td>
      <td>${u.active ? '<span class="status-approved">activo</span>' : '<span class="status-declined">inactivo</span>'}</td>
      <td class="row">
        <button class="ghost small" data-save="${esc(u._id)}">Guardar rol</button>
        <button class="ghost small" data-toggle="${esc(u._id)}" data-active="${u.active}">${u.active ? 'Desactivar' : 'Activar'}</button>
      </td>
    </tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
    const id = b.dataset.save; const role = document.querySelector(`[data-role="${id}"]`).value;
    const r2 = await api('/portal/users/' + id, { method: 'PATCH', body: JSON.stringify({ role }) });
    if (!r2.ok) alert(r2.body.error === 'cannot_demote_yourself' ? 'No puedes quitarte a ti mismo el rol de administrador.' : 'No se pudo guardar.');
    loadUsers();
  });
  document.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    const id = b.dataset.toggle; const active = b.dataset.active !== 'true';
    const r2 = await api('/portal/users/' + id, { method: 'PATCH', body: JSON.stringify({ active }) });
    if (!r2.ok) alert(r2.body.error === 'cannot_deactivate_yourself' ? 'No puedes desactivarte a ti mismo.' : 'No se pudo cambiar el estado.');
    loadUsers();
  });
}

// ── Tab: Jerarquía (solo admin) ────────────────────────────────────────────────
const NODE_TYPES = ['globalGroup', 'group', 'branch', 'region', 'store'];
async function viewJerarquia() {
  view().innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <strong>Añadir nodo</strong>
      <div id="hMsg"></div>
      <div class="row" style="margin-top:10px; align-items:end">
        <div style="min-width:150px"><label>Tipo</label>
          <select id="hType">${NODE_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select></div>
        <div style="flex:1; min-width:150px"><label>Nombre</label><input id="hName" /></div>
        <div style="min-width:180px"><label>Padre</label><select id="hParent"><option value="">— raíz —</option></select></div>
        <button id="hCreate">Añadir</button>
      </div>
    </div>
    <div class="card" id="hTree">Cargando…</div>`;
  document.getElementById('hCreate').onclick = async () => {
    const body = { nodeType: val('hType'), name: val('hName'), parentId: val('hParent') || null };
    if (!body.name) return banner('hMsg', 'El nombre es obligatorio.');
    const r = await api('/portal/hierarchy', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) return banner('hMsg', ({
      invalid_parent_level: 'El padre debe ser de un nivel superior.',
      parent_not_found: 'El padre indicado no existe.',
      outside_your_scope: 'Solo puedes crear dentro de tu ámbito asignado.',
    })[r.body.error] || 'No se pudo crear el nodo.');
    banner('hMsg', 'Nodo creado.', 'ok');
    loadTree();
  };
  loadTree();
}
async function loadTree() {
  const r = await api('/portal/hierarchy');
  if (!r.ok) return document.getElementById('hTree').innerHTML = `<div class="muted">No se pudo cargar la jerarquía.</div>`;
  const nodes = r.body.nodes || [];
  // rellenar el desplegable de padres
  const sel = document.getElementById('hParent');
  if (sel) sel.innerHTML = `<option value="">— raíz —</option>` +
    nodes.map(n => `<option value="${esc(n._id)}">${esc(n.name)} (${esc(n.nodeType)})</option>`).join('');
  if (!nodes.length) return document.getElementById('hTree').innerHTML = `<div class="muted">Todavía no hay nodos. Añade el primero arriba.</div>`;
  // construir el árbol
  const byParent = {};
  nodes.forEach(n => { const p = n.parentId || 'root'; (byParent[p] = byParent[p] || []).push(n); });
  const render = (parent) => {
    const kids = byParent[parent] || [];
    if (!kids.length) return '';
    return `<ul class="tree">${kids.map(n => `<li>
      <span class="node-type">${esc(n.nodeType)}</span> <strong>${esc(n.name)}</strong>
      ${n.active ? '' : '<span class="muted">(inactivo)</span>'}
      <button class="ghost small" data-del="${esc(n._id)}">Borrar</button>
      ${render(n._id)}
    </li>`).join('')}</ul>`;
  };
  document.getElementById('hTree').innerHTML = render('root');
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Borrar este nodo?')) return;
    const r2 = await api('/portal/hierarchy/' + b.dataset.del, { method: 'DELETE' });
    if (!r2.ok) alert(r2.body.error === 'node_has_children' ? 'No se puede borrar: tiene nodos hijos. Borra primero los de dentro.' : 'No se pudo borrar.');
    loadTree();
  });
}

// ── Utilidades DOM ────────────────────────────────────────────────────────────
function val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function banner(id, msg, kind = 'err') {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<div class="banner ${kind === 'ok' ? 'ok' : 'err'}">${esc(msg)}</div>`;
}

// ── Arranque ──────────────────────────────────────────────────────────────────
(function boot() {
  if (!token()) return renderLogin();
  loadDashboard().catch(e => { if (!e || !e.handled) renderLogin(); });
})();
