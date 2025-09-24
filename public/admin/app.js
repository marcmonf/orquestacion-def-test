/* public/admin/app.js */
(() => {
  const $ = (id) => document.getElementById(id);
  const txt = (el, v) => { el.textContent = v; };
  const val = (el) => (el.value || '').trim();

  const els = {
    merchantId: $('merchantId'),
    adminToken: $('adminToken'),
    defaultConnector: $('defaultConnector'),
    policy: $('policy'),
    status: $('status'),
    tryOut: $('tryOut'),
    auditOut: $('auditOut'),
    auditTable: $('auditTable'),
    sampleAmount: $('sampleAmount'),
    sampleCurrency: $('sampleCurrency'),
    sampleCard: $('sampleCard'),
    btnLoad: $('btnLoad'),
    btnSave: $('btnSave'),
    btnTry: $('btnTry'),
    btnExport: $('btnExport'),
    fileImport: $('fileImport'),
    btnAudit: $('btnAudit'),
  };

  function headers(extra = {}) {
    const h = { 'Content-Type': 'application/json' };
    const token = val(els.adminToken);
    if (token) h['X-Admin-Token'] = token;
    return { ...h, ...extra };
  }

  function pretty(obj) { return JSON.stringify(obj, null, 2); }

  async function loadPolicy() {
    const mid = val(els.merchantId);
    if (!mid) return setStatus('merchantId requerido');
    setStatus('Cargando política…');
    const r = await fetch(`/rules/${encodeURIComponent(mid)}`, { headers: headers() });
    const j = await r.json();
    if (!j?.success) return setStatus('No se pudo cargar la política');
    els.policy.value = pretty(j.policy);
    if (j.policy?.defaultConnector) els.defaultConnector.value = j.policy.defaultConnector;
    setStatus('Política cargada');
  }

  async function savePolicy() {
    const mid = val(els.merchantId);
    if (!mid) return setStatus('merchantId requerido');

    let payload;
    try { payload = JSON.parse(els.policy.value || '{}'); }
    catch { return setStatus('JSON inválido'); }

    // Si el input "Default Connector" está relleno, sincronizarlo en el JSON
    const dc = val(els.defaultConnector);
    if (dc) payload.defaultConnector = dc;

    setStatus('Guardando…');
    const r = await fetch(`/rules/${encodeURIComponent(mid)}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!j?.success) return setStatus('Error guardando política');
    els.policy.value = pretty(j.policy);
    setStatus('Guardado OK');
  }

  async function tryPolicy() {
    let policy, amount, currency, cardNumber;
    try { policy = JSON.parse(els.policy.value || '{}'); }
    catch { return renderTry({ error: 'JSON inválido en política' }); }

    amount = Number(val(els.sampleAmount)) || undefined;
    currency = val(els.sampleCurrency) || undefined;
    cardNumber = val(els.sampleCard) || undefined;

    const sample = { amount, currency, cardNumber };
    const r = await fetch('/rules/try', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ policy, sample })
    });
    const j = await r.json();
    renderTry(j);
  }

  function renderTry(resp) {
    if (!resp?.success) {
      els.tryOut.innerHTML = `<div class="text-red-400">❌ ${resp?.error || 'Error en /rules/try'}</div>`;
      return;
    }
    const { decision, explainHuman } = resp;
    const lines = [
      `🔎 Conector: <b>${decision.connector}</b>`,
      decision.matchedRuleId ? `Regla aplicada: <b>${decision.matchedRuleId}</b>` : 'Sin match → default',
      '',
      '<b>Explicación legible</b>',
      ...(Array.isArray(explainHuman) ? explainHuman : [])
    ];
    els.tryOut.innerHTML = `<div class="space-y-1">${lines.map(l => `<div>${l}</div>`).join('')}</div>`;
  }

  async function exportPolicy() {
    const mid = val(els.merchantId);
    if (!mid) return setStatus('merchantId requerido');
    const r = await fetch(`/rules/export?merchantId=${encodeURIComponent(mid)}`, { headers: headers() });
    const j = await r.json();
    if (!j?.success) return setStatus('Export falló');
    els.policy.value = pretty(j.export);
    setStatus('Export OK (copiado al editor)');
  }

  async function importPolicyFromFile(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { return setStatus('Archivo JSON inválido'); }

    const r = await fetch('/rules/import', { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
    const j = await r.json();
    if (!j?.success) return setStatus('Import falló');
    els.policy.value = pretty(j.policy);
    setStatus('Import OK');
  }

  async function showAudit() {
    const mid = val(els.merchantId);
    if (!mid) return setStatus('merchantId requerido');

    const r = await fetch(`/rules/${encodeURIComponent(mid)}/audit?limit=20`, { headers: headers() });
    const j = await r.json();
    if (!j?.success) {
      els.auditOut.classList.add('hidden');
      return setStatus('Audit deshabilitado o sin datos');
    }

    els.auditOut.classList.remove('hidden');
    els.auditTable.innerHTML = (j.items || []).map(it => {
      return `<div class="p-2 rounded bg-slate-800 border border-slate-700">
        <div><b>${new Date(it.createdAt).toLocaleString()}</b> · actor: ${it.actor || 'unknown'}</div>
        <div class="text-xs mt-1">changedFields: ${Array.isArray(it.changedFields) ? it.changedFields.join(', ') : '-'}</div>
        <div class="text-xs mt-1">prevHash: ${it.prevHash?.slice(0,8)}… · nextHash: ${it.nextHash?.slice(0,8)}… · diffSize: ${it.diffSize}</div>
      </div>`;
    }).join('');
  }

  function setStatus(message) {
    txt(els.status, message);
  }

  // Presets de ejemplo (atajos)
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      let pol;
      try { pol = JSON.parse(els.policy.value || '{}'); } catch { pol = {}; }
      if (!pol.version) pol.version = 'v1';
      if (!pol.defaultConnector) pol.defaultConnector = val(els.defaultConnector) || 'dummyCard';
      if (!Array.isArray(pol.rules)) pol.rules = [];

      const preset = btn.getAttribute('data-preset');
      const id = `preset-${preset}-${Date.now()}`;
      const rule = { id, priority: pol.rules.length, when: {}, action: { route: 'dummyCard' } };

      if (preset === 'eurSmall') {
        rule.when.currency = { in: ['EUR'] };
        rule.when.amount = { lt: 50 };
      } else if (preset === 'binES') {
        rule.when.bin = { inPrefixes: ['4571', '4029'] };
      } else if (preset === 'issuerBR') {
        rule.when.issuerCountry = { in: ['BR'] };
      } else if (preset === 'schemeVisa') {
        rule.when.scheme = { in: ['visa'] };
      } else if (preset === 'lowLatency') {
        // funciona con FEATURE_RULE_ENGINE_ADVANCED=1
        rule.when.latencyMs = { lte: 150 };
      }
      pol.rules.push(rule);
      els.policy.value = pretty(pol);
      setStatus(`Regla añadida: ${id}`);
    });
  });

  // Eventos
  els.btnLoad.addEventListener('click', loadPolicy);
  els.btnSave.addEventListener('click', savePolicy);
  els.btnTry.addEventListener('click', tryPolicy);
  els.btnExport.addEventListener('click', exportPolicy);
  els.fileImport.addEventListener('change', importPolicyFromFile);
  els.btnAudit.addEventListener('click', showAudit);

  // Estado inicial
  setStatus('Listo');
})();
