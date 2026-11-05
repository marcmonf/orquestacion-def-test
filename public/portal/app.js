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

// Campo de contraseña con botón de mostrar/ocultar (ojito). Mismo patrón que /admin:
// pwField() pinta el label + input + botón; bindEyes() engancha el toggle tras render.
function pwField(id, label, autocomplete) {
  return `<label>${esc(label)}</label>
      <div class="pw">
        <input id="${id}" type="password"${autocomplete ? ` autocomplete="${autocomplete}"` : ''} />
        <button type="button" class="pw-eye" data-eye="${id}" title="Mostrar / ocultar contraseña" aria-label="Mostrar u ocultar contraseña">👁</button>
      </div>`;
}
function bindEyes() {
  document.querySelectorAll('[data-eye]').forEach(btn => {
    btn.onclick = () => {
      const inp = document.getElementById(btn.dataset.eye);
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
    };
  });
}

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
      ${pwField('password', 'Contraseña', 'current-password')}
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
  bindEyes();
}

function renderChangePassword() {
  ROOT.innerHTML = `
    <div id="centered"><div class="card">
      <div class="logo-text">Cambia tu contraseña</div>
      <p class="muted" style="margin-top:4px">Tu contraseña es temporal. Debes cambiarla para continuar.</p>
      <div id="cpErr"></div>
      ${pwField('cur', 'Contraseña temporal actual', 'current-password')}
      ${pwField('np1', 'Nueva contraseña (mínimo 8 caracteres)', 'new-password')}
      ${pwField('np2', 'Repite la nueva contraseña', 'new-password')}
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
  bindEyes();
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
function isOperator() { return state.me && ['merchant_admin', 'merchant_operator'].includes(state.me.role); }

function renderShell() {
  const tabs = [
    ['resumen', 'Resumen'],
    ['transacciones', 'Transacciones'],
    ['enlaces', 'Enlaces de pago'],
    ...(isAdmin() ? [['adquirentes', 'Adquirentes'], ['orquestacion', 'Orquestación'], ['costes', 'Coste real'], ['usuarios', 'Usuarios'], ['jerarquia', 'Jerarquía'], ['facturacion', 'Facturación']] : []),
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
  // "Salir" invalida también el token en el servidor (antes solo se borraba en
  // el navegador y seguía valiendo hasta caducar).
  document.getElementById('logoutBtn').onclick = () => {
    const t = token();
    if (t) fetch(API + '/portal/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(() => {});
    clearToken();
    renderLogin('Sesión cerrada.');
  };
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
  if (tab === 'facturacion') return viewFacturacion();
  if (tab === 'adquirentes') return viewAdquirentes();
  if (tab === 'costes') return viewCostes();
  if (tab === 'orquestacion') return viewOrquestacion();
  if (tab === 'enlaces') return viewEnlaces();
}

// ── Tab: Enlaces de pago (nov 2026) ─────────────────────────────────────────
// Crear un enlace (importe, concepto, uso único o múltiple, caducidad) → URL +
// QR para compartir. El comprador paga en el checkout de siempre.
const LINK_STATE = { active: 'Activo', completed: 'Pagado', cancelled: 'Anulado', expired: 'Caducado' };
function eurosToCents(v) {
  const n = Number(String(v || '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
async function viewEnlaces() {
  view().innerHTML = `
    ${isOperator() ? `<div class="card" style="margin-bottom:14px">
      <strong>Nuevo enlace de pago</strong>
      <div id="plMsg"></div>
      <div class="row" style="margin-top:10px; align-items:end">
        <div style="min-width:120px"><label>Importe (€)</label><input id="plAmount" inputmode="decimal" placeholder="25,00" /></div>
        <div style="flex:1; min-width:180px"><label>Concepto</label><input id="plConcept" maxlength="200" placeholder="Clase de yoga del martes" /></div>
        <div style="min-width:140px"><label>Uso</label>
          <select id="plReusable"><option value="false">Un solo pago</option><option value="true">Varios pagos</option></select></div>
        <div style="min-width:150px"><label>Caduca en (horas, opcional)</label><input id="plHours" inputmode="numeric" placeholder="48" /></div>
        <button id="plCreate">Crear enlace</button>
      </div>
    </div>` : ''}
    <div class="card" id="plTable">Cargando…</div>`;
  if (isOperator()) {
    document.getElementById('plCreate').onclick = async () => {
      const amount = eurosToCents(val('plAmount'));
      const concept = val('plConcept');
      if (!Number.isInteger(amount) || amount < 1) return banner('plMsg', 'Importe no válido.');
      if (!concept) return banner('plMsg', 'Escribe el concepto.');
      const body = { amount, currency: 'EUR', concept, reusable: val('plReusable') === 'true' };
      const hours = Number(val('plHours'));
      if (val('plHours') && (!Number.isFinite(hours) || hours <= 0)) return banner('plMsg', 'Horas no válidas.');
      if (hours > 0) body.expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
      const r = await api('/portal/payment-links', { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) return banner('plMsg', r.body.error === 'validation_error' ? 'Revisa los datos.' : 'No se pudo crear.');
      banner('plMsg', 'Enlace creado: ' + r.body.link.url, 'ok');
      loadEnlaces();
    };
  }
  loadEnlaces();
}
async function loadEnlaces() {
  const r = await api('/portal/payment-links');
  const el = document.getElementById('plTable');
  if (!r.ok) { el.innerHTML = '<div class="muted">No se pudieron cargar los enlaces.</div>'; return; }
  const rows = r.body.links || [];
  if (!rows.length) { el.innerHTML = '<div class="muted">Todavía no hay enlaces de pago.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>QR</th><th>Concepto</th><th>Importe</th><th>Uso</th><th>Estado</th><th>Pagos</th><th>Enlace</th><th></th></tr></thead>
    <tbody>${rows.map(l => `<tr>
      <td><a href="${esc(l.qrUrl)}" target="_blank" rel="noopener"><img src="${esc(l.qrUrl)}" alt="QR" width="56" height="56"></a></td>
      <td>${esc(l.concept)}</td>
      <td>${money(l.amount, l.currency)}</td>
      <td>${l.reusable ? 'Varios' : 'Único'}</td>
      <td>${esc(LINK_STATE[l.status] || l.status)}${l.expiresAt ? `<div class="muted" style="font-size:11px">hasta ${fmtDate(l.expiresAt)}</div>` : ''}</td>
      <td>${Number(l.paidCount) || 0}</td>
      <td><input readonly value="${esc(l.url)}" style="min-width:220px" data-copy="1"></td>
      <td>${isOperator() && l.status === 'active' ? `<button class="ghost small" data-cancel="${esc(l.id)}">Anular</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('[data-copy]').forEach(i => { i.onclick = () => i.select(); });
  el.querySelectorAll('[data-cancel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('¿Anular este enlace? Nadie podrá pagar con él.')) return;
      const r2 = await api('/portal/payment-links/' + encodeURIComponent(b.dataset.cancel) + '/cancel', { method: 'POST' });
      if (!r2.ok) return alert('No se pudo anular.');
      loadEnlaces();
    };
  });
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

// ── Tab: Facturación (solo admin) ──────────────────────────────────────────────
function monthLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return esc(period);
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${meses[Number(m[2]) - 1]} ${m[1]}`;
}
let _invoices = [];
async function viewFacturacion() {
  view().innerHTML = `<div class="card">Cargando facturación…</div>`;
  const [r, ri, rc] = await Promise.all([api('/portal/billing'), api('/portal/invoices'), api('/portal/contract')]);
  if (!r.ok) return view().innerHTML = `<div class="banner err">No se pudo cargar la facturación.</div>`;
  const c = r.body.current, cur = c.currency || 'EUR';
  const contract = (rc.ok && rc.body.contract) ? rc.body.contract : null;
  const tarifaCard = contract ? `
    <div class="card" style="margin-bottom:14px">
      <strong>Tu tarifa</strong>
      <table style="margin-top:10px">
        ${contract.monthlyMaintenance ? `<tr><td>Mantenimiento mensual</td><td style="text-align:right">${money(contract.monthlyMaintenance, cur)}</td></tr>` : ''}
        ${contract.perTransactionFee ? `<tr><td>Por transacción</td><td style="text-align:right">${money(contract.perTransactionFee, cur)}</td></tr>` : ''}
        ${contract.volumeBps ? `<tr><td>Sobre volumen</td><td style="text-align:right">${(contract.volumeBps / 100).toFixed(2)}%</td></tr>` : ''}
        ${contract.perUserFee ? `<tr><td>Por usuario adicional (incluidos ${contract.includedUsers || 0})</td><td style="text-align:right">${money(contract.perUserFee, cur)}</td></tr>` : ''}
        ${(contract.services || []).map(s => `<tr><td>${esc(s.label || s.code)}</td><td style="text-align:right">${money(s.monthlyPrice, cur)}/mes</td></tr>`).join('')}
      </table>
    </div>` : '';
  const kpi = (n, l) => `<div class="card kpi"><div class="n">${n}</div><div class="l">${esc(l)}</div></div>`;
  const history = (r.body.history || []).slice().reverse();
  _invoices = (ri.ok && ri.body.invoices) ? ri.body.invoices : [];

  const invoicesCard = _invoices.length ? `
    <div class="card" style="margin-bottom:14px">
      <strong>Facturas emitidas</strong>
      <table style="margin-top:10px"><thead><tr><th>Nº</th><th>Mes</th><th>Total</th><th>Estado</th><th></th></tr></thead>
      <tbody>${_invoices.map((inv, i) => `<tr>
        <td><code>${esc(inv.invoiceNumber)}</code></td>
        <td>${monthLabel(inv.period)}</td>
        <td>${money(inv.totalDue, inv.currency || cur)}</td>
        <td><span class="chip">${esc(inv.status)}</span></td>
        <td class="row"><button class="ghost small" data-inv="${i}">Ver</button><button class="ghost small" data-pdf="${esc(inv._id)}" data-num="${esc(inv.invoiceNumber || '')}">PDF</button></td>
      </tr>`).join('')}</tbody></table>
    </div>` : '';

  view().innerHTML = `
    <div class="banner ok">Plan <strong>${esc(r.body.plan)}</strong> · período en curso <strong>${monthLabel(r.body.period)}</strong>.
      Importe informativo (aún no se cobra automáticamente).</div>
    <div class="kpis" style="margin-bottom:14px">
      ${kpi(money(c.totalDue, cur), 'Total del período')}
      ${kpi(money(c.subscriptionFee, cur), 'Cuota del plan')}
      ${kpi(money(c.usageFee, cur), 'Por transacciones')}
      ${kpi(money(c.volumeFee, cur), 'Por volumen')}
      ${kpi(c.billableCount, 'Transacciones facturables')}
      ${kpi(money(c.billableVolume, cur), 'Volumen facturable')}
    </div>
    ${tarifaCard}
    ${invoicesCard}
    <div class="card">
      <strong>Historial (últimos 6 meses)</strong>
      <table style="margin-top:10px"><thead><tr><th>Mes</th><th>Facturables</th><th>Volumen</th><th>Total</th></tr></thead>
      <tbody>${history.map(h => `<tr>
        <td>${monthLabel(h.period)}</td>
        <td>${h.billableCount}</td>
        <td>${money(h.billableVolume, h.currency || cur)}</td>
        <td>${money(h.totalDue, h.currency || cur)}</td>
      </tr>`).join('')}</tbody></table>
    </div>`;
  document.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => renderInvoice(_invoices[Number(b.dataset.inv)]));
  document.querySelectorAll('[data-pdf]').forEach(b => b.onclick = () => downloadInvoicePdf(b.dataset.pdf, b.dataset.num));
}

async function downloadInvoicePdf(id, number) {
  const res = await fetch('/portal/invoices/' + id + '/pdf', { headers: { Authorization: 'Bearer ' + token() } });
  if (!res.ok) return alert('No se pudo descargar el PDF.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'factura-' + (number || id) + '.pdf';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderInvoice(inv) {
  if (!inv) return;
  const cur = inv.currency || 'EUR';
  const line = (l, v) => `<tr><td>${esc(l)}</td><td style="text-align:right">${money(v, cur)}</td></tr>`;
  view().innerHTML = `
    <div class="row no-print" style="margin-bottom:12px">
      <button class="ghost small" id="invBack">‹ Volver</button>
      <button class="small" id="invPrint">Imprimir / Guardar PDF</button>
    </div>
    <div class="card inv">
      <h2>Factura ${esc(inv.invoiceNumber)}</h2>
      <div class="muted">Monetiser · ${esc(state.me.merchantId)} · Período ${monthLabel(inv.period)} · Plan ${esc(inv.plan || '')}</div>
      <table style="margin-top:16px">
        ${line('Cuota del plan', inv.subscriptionFee)}
        ${line(`Transacciones facturables (${inv.billableCount})`, inv.usageFee)}
        ${line('Comisión por volumen', inv.volumeFee)}
        <tr><td class="tot">Total</td><td class="tot" style="text-align:right">${money(inv.totalDue, cur)}</td></tr>
      </table>
      <div class="muted" style="margin-top:14px">Volumen facturable: ${money(inv.billableVolume, cur)} · ${esc(inv.status)}</div>
    </div>`;
  document.getElementById('invBack').onclick = () => viewFacturacion();
  document.getElementById('invPrint').onclick = () => window.print();
}

// ── Tab: Adquirentes + Routing (solo admin) ────────────────────────────────────
let _acq = { catalog: [], acquirers: [], rules: [] };
async function viewAdquirentes() {
  view().innerHTML = `<div class="card">Cargando adquirentes…</div>`;
  const [ra, rr] = await Promise.all([api('/portal/acquirers'), api('/portal/routing')]);
  if (!ra.ok) return view().innerHTML = `<div class="banner err">No se pudieron cargar los adquirentes.</div>`;
  _acq.catalog = ra.body.catalog || [];
  _acq.acquirers = ra.body.acquirers || [];
  _acq.rules = (rr.ok && rr.body.rules) ? rr.body.rules : [];
  const opts = _acq.catalog.map(c => `<option value="${esc(c.code)}">${esc(c.name || c.code)}</option>`).join('');
  const fichas = _acq.acquirers.map(a => `<tr>
    <td>${esc(a.acquirerCode)}</td>
    <td>${((a.markupBps || 0) / 100).toFixed(2)}%${a.fixedFee ? ' + ' + money(a.fixedFee, 'EUR') : ''}</td>
    <td>${a.isDefault ? '<span class="chip">por defecto</span>' : ''}</td>
    <td><button class="ghost small" data-delacq="${esc(a.acquirerCode)}">Borrar</button></td>
  </tr>`).join('');
  const rules = _acq.rules.map((r, i) => `<tr>
    <td>${r.priority}</td><td>${esc(r.acquirerCode)}</td><td>${esc(r.binPrefix || '*')}</td>
    <td>${esc(r.scheme || '*')}</td><td>${esc(r.cardType || '*')}</td>
    <td><button class="ghost small" data-delrule="${i}">Borrar</button></td>
  </tr>`).join('');
  view().innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <strong>Tus adquirentes</strong>
      <p class="muted">Da de alta con quién trabajas y tu margen negociado (ICH++).</p>
      <div class="row" style="align-items:end; margin:10px 0">
        <div style="min-width:150px"><label>Adquirente</label><select id="acqCode">${opts}</select></div>
        <div style="min-width:120px"><label>Margen ICH++ (%)</label><input id="acqMarkup" type="number" step="0.01" placeholder="0.45"/></div>
        <label class="row" style="gap:6px"><input id="acqDefault" type="checkbox" style="width:auto"/> Por defecto</label>
        <button id="acqSave">Guardar</button>
      </div>
      <table><thead><tr><th>Adquirente</th><th>Margen</th><th></th><th></th></tr></thead><tbody>${fichas || '<tr><td colspan="4" class="muted">Sin adquirentes todavía.</td></tr>'}</tbody></table>
    </div>
    <div class="card" style="margin-bottom:14px">
      <strong>Routing (BIN routing)</strong>
      <p class="muted">La primera regla que casa gana; si ninguna, el adquirente por defecto.</p>
      <div class="row" style="align-items:end; margin:10px 0">
        <div style="min-width:140px"><label>A adquirente</label><select id="rAcq">${opts}</select></div>
        <div style="min-width:110px"><label>BIN empieza por</label><input id="rBin" placeholder="454617"/></div>
        <div style="min-width:90px"><label>Scheme</label><input id="rScheme" placeholder="visa"/></div>
        <div style="min-width:90px"><label>Tipo</label><input id="rType" placeholder="credit"/></div>
        <button id="rAdd">Añadir</button>
      </div>
      <table><thead><tr><th>Prio</th><th>Adquirente</th><th>BIN</th><th>Scheme</th><th>Tipo</th><th></th></tr></thead><tbody>${rules || '<tr><td colspan="6" class="muted">Sin reglas.</td></tr>'}</tbody></table>
    </div>
    <div class="card">
      <strong>Simular</strong>
      <div class="row" style="align-items:end; margin-top:10px">
        <div style="min-width:120px"><label>BIN</label><input id="sBin" placeholder="454617"/></div>
        <div style="min-width:90px"><label>Scheme</label><input id="sScheme" placeholder="visa"/></div>
        <div style="min-width:110px"><label>Importe (€)</label><input id="sAmt" type="number" placeholder="50"/></div>
        <button id="sGo">Simular</button>
      </div>
      <div id="simOut" style="margin-top:10px" class="muted"></div>
    </div>`;
  document.getElementById('acqSave').onclick = async () => {
    const body = { markupBps: Math.round(parseFloat(val('acqMarkup') || '0') * 100), isDefault: document.getElementById('acqDefault').checked, active: true };
    const r = await api('/portal/acquirers/' + val('acqCode'), { method: 'PUT', body: JSON.stringify(body) });
    if (!r.ok) return alert('No se pudo guardar.');
    viewAdquirentes();
  };
  document.querySelectorAll('[data-delacq]').forEach(b => b.onclick = async () => { await api('/portal/acquirers/' + b.dataset.delacq, { method: 'DELETE' }); viewAdquirentes(); });
  document.getElementById('rAdd').onclick = async () => {
    _acq.rules.push({ acquirerCode: val('rAcq'), binPrefix: val('rBin'), scheme: val('rScheme'), cardType: val('rType'), priority: (_acq.rules.length + 1) * 10 });
    await api('/portal/routing', { method: 'PUT', body: JSON.stringify({ rules: _acq.rules }) }); viewAdquirentes();
  };
  document.querySelectorAll('[data-delrule]').forEach(b => b.onclick = async () => {
    _acq.rules.splice(Number(b.dataset.delrule), 1);
    await api('/portal/routing', { method: 'PUT', body: JSON.stringify({ rules: _acq.rules }) }); viewAdquirentes();
  });
  document.getElementById('sGo').onclick = async () => {
    const r = await api('/portal/routing/simulate', { method: 'POST', body: JSON.stringify({ bin: val('sBin'), scheme: val('sScheme'), amount: Math.round(parseFloat(val('sAmt') || '0') * 100) }) });
    const el = document.getElementById('simOut');
    el.innerHTML = r.ok ? `→ Adquirente: <strong>${esc(r.body.acquirerCode || '—')}</strong> (${esc(r.body.reason)})` : 'Error.';
  };
}

// ── Tab: Coste real (solo admin) ───────────────────────────────────────────────
async function viewCostes() {
  view().innerHTML = `<div class="card">Calculando coste…</div>`;
  const r = await api('/portal/costs');
  if (!r.ok) return view().innerHTML = `<div class="banner err">No se pudo calcular el coste.</div>`;
  const cur = r.body.currency || 'EUR';
  const sample = (r.body.sample || []).map(s => `<tr>
    <td><code>${esc((s.paymentId || '').slice(0, 10))}…</code></td>
    <td>${money(s.amount, cur)}</td><td>${money(s.interchange, cur)}</td><td>${money(s.schemeFee, cur)}</td>
    <td>${money(s.acquirerMarkup, cur)}</td><td>${money(s.gatewayFee, cur)}</td>
    <td><strong>${money(s.total, cur)}</strong></td><td>${s.effectiveRatePct}%</td>
  </tr>`).join('');
  view().innerHTML = `
    <div class="card" style="text-align:center; margin-bottom:14px">
      <div class="muted">Coste real medio por transacción</div>
      <div style="font-size:44px; font-weight:800; color:var(--primary-d)">${money(r.body.avgCostPerTx, cur)}</div>
      <div class="muted">Tasa efectiva <strong>${r.body.effectiveRatePct}%</strong> · ${r.body.transactions} transacciones · adquirente ${esc(r.body.acquirerCode || '—')}</div>
    </div>
    <div class="banner" style="background:#fffbeb; color:#92400e">${esc(r.body.disclaimer || '')}</div>
    <div class="kpis" style="margin:14px 0">
      <div class="card kpi"><div class="n">${money(r.body.totalVolume, cur)}</div><div class="l">Volumen</div></div>
      <div class="card kpi"><div class="n">${money(r.body.totalCost, cur)}</div><div class="l">Coste total estimado</div></div>
    </div>
    <div class="card">
      <strong>Desglose por transacción (muestra)</strong>
      <table style="margin-top:10px"><thead><tr><th>Pago</th><th>Importe</th><th>Interchange</th><th>Scheme</th><th>Adquirente</th><th>Pasarela</th><th>Total</th><th>%</th></tr></thead>
      <tbody>${sample || '<tr><td colspan="8" class="muted">Sin transacciones en el período.</td></tr>'}</tbody></table>
    </div>`;
}

// ── Orquestación (insights, 5 nov 2026): aprobación, rechazos, 3DS, coste y routing por PSP ──
const ROUTING_REASON_LABEL = { rule: 'Regla del comercio', default: 'Conector por defecto', failover_pre_card: 'Failover antes de pedir la tarjeta', all_unhealthy_using_first_capable: 'Todos con incidencias: primero capaz', routing_error_platform_default: 'Routing no disponible: por defecto', sin_routing: 'Pago anterior al routing' };
async function viewOrquestacion(days) {
  days = days || state.insightsDays || 30;
  state.insightsDays = days;
  view().innerHTML = `<div class="card">Calculando…</div>`;
  const r = await api('/portal/insights?days=' + encodeURIComponent(days));
  if (!r.ok) return view().innerHTML = `<div class="banner err">No se pudieron calcular los insights.</div>`;
  const ins = r.body.insights;
  const t = ins.totals;
  const pct = (v) => (v === null || v === undefined ? '—' : v + '%');
  const costOf = (psp) => (ins.costs.byPsp || []).find((c) => c.psp === psp);
  const rows = ins.byPsp.map((p) => { const c = costOf(p.psp); return `<tr><td><strong>${esc(p.psp)}</strong></td><td>${p.payments}</td><td>${pct(p.approvalRatePct)}</td><td>${p.declined}</td><td>${p.errors}</td><td>${pct(p.threeDSRatePct)}</td><td>${c ? money(c.avgCostPerTx, 'EUR') + ' · ' + c.effectiveRatePct + '%' : '—'}</td></tr>`; }).join('');
  const reasons = ins.declineReasons.map((d) => `<tr><td><code>${esc(d.code)}</code></td><td>${esc(d.description)}</td><td>${d.count}</td><td>${pct(d.sharePct)}</td></tr>`).join('');
  const routing = ins.routingReasons.map((x) => `<tr><td>${esc(ROUTING_REASON_LABEL[x.reason] || x.reason)}</td><td>${x.count}</td></tr>`).join('');
  view().innerHTML = `
    <div class="row" style="margin-bottom:12px; gap:6px">
      ${[7, 30, 90].map((d) => `<button class="${d === days ? '' : 'ghost'} small" data-days="${d}">${d} días</button>`).join('')}
    </div>
    <div class="kpis" style="margin-bottom:14px">
      <div class="card kpi"><div class="n">${pct(t.approvalRatePct)}</div><div class="l">Tasa de aprobación</div></div>
      <div class="card kpi"><div class="n">${t.payments}</div><div class="l">Pagos</div></div>
      <div class="card kpi"><div class="n">${pct(t.threeDSRatePct)}</div><div class="l">Con 3DS</div></div>
      <div class="card kpi"><div class="n">${money(t.approvedVolume, 'EUR')}</div><div class="l">Volumen aprobado</div></div>
    </div>
    <div class="card" style="margin-bottom:14px"><strong>Comparativa por PSP</strong>
      <table style="margin-top:10px"><thead><tr><th>PSP</th><th>Pagos</th><th>Aprobación</th><th>Rechazos</th><th>Errores</th><th>3DS</th><th>Coste real medio</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">Sin pagos en el período.</td></tr>'}</tbody></table></div>
    <div class="card" style="margin-bottom:14px"><strong>Motivos de rechazo (normalizados)</strong>
      <table style="margin-top:10px"><thead><tr><th>Código</th><th>Qué significa</th><th>Pagos</th><th>%</th></tr></thead>
      <tbody>${reasons || '<tr><td colspan="4" class="muted">Sin rechazos.</td></tr>'}</tbody></table></div>
    <div class="card" style="margin-bottom:14px"><strong>Por qué se enrutó cada pago</strong>
      <table style="margin-top:10px"><thead><tr><th>Motivo</th><th>Pagos</th></tr></thead><tbody>${routing || '<tr><td colspan="2" class="muted">—</td></tr>'}</tbody></table></div>
    <div class="banner" style="background:#fffbeb; color:#92400e">Coste real: muestra de ${ins.costs.sampled || 0} pagos aprobados. ${esc(ins.costs.disclaimer || '')}</div>`;
  view().querySelectorAll('button[data-days]').forEach((b) => { b.onclick = () => viewOrquestacion(Number(b.dataset.days)); });
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
