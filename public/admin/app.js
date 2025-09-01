/* global localStorage, fetch, Blob, URL */
(function(){
  const $ = (id) => document.getElementById(id);
  const merchantId = $('merchantId');
  const adminToken = $('adminToken');
  const defaultConnector = $('defaultConnector');
  const policy = $('policy');
  const status = $('status');
  const tryOut = $('tryOut');
  const auditOut = $('auditOut');
  const auditTable = $('auditTable');
  const sampleAmount = $('sampleAmount');
  const sampleCurrency = $('sampleCurrency');
  const sampleCard = $('sampleCard');
  const FEATURE_RULE_EXPORT_UI = true; // UI siempre visible; backend valida/guarda

  // Persistencia local
  merchantId.value = localStorage.getItem('monetiser.merchantId') || 'demo-merchant';
  adminToken.value = localStorage.getItem('monetiser.adminToken') || '';
  defaultConnector.value = localStorage.getItem('monetiser.defaultConnector') || 'dummyCard';
  sampleAmount.value = localStorage.getItem('monetiser.sampleAmount') || '25';
  sampleCurrency.value = localStorage.getItem('monetiser.sampleCurrency') || 'EUR';
  sampleCard.value = localStorage.getItem('monetiser.sampleCard') || '';

  function setStatus(msg, ok=true) {
    status.textContent = msg;
    status.className = 'mt-3 text-sm ' + (ok ? 'text-emerald-400' : 'text-rose-400');
  }

  function headers() {
    const h = { 'Content-Type':'application/json' };
    if (adminToken.value) h['X-Admin-Token'] = adminToken.value;
    return h;
  }

  async function api(path, method='GET', body) {
    const res = await fetch(`/rules${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(()=> ({}));
    if (!res.ok) throw Object.assign(new Error('http_error'), { data });
    return data;
  }

  async function loadPolicy() {
    try {
      localStorage.setItem('monetiser.merchantId', merchantId.value);
      localStorage.setItem('monetiser.adminToken', adminToken.value);
      const data = await api(`/${encodeURIComponent(merchantId.value)}`, 'GET');
      if (!data.policy) throw new Error('sin policy');
      defaultConnector.value = data.policy.defaultConnector || 'dummyCard';
      localStorage.setItem('monetiser.defaultConnector', defaultConnector.value);
      policy.value = JSON.stringify(data.policy, null, 2);
      setStatus('Política cargada');
    } catch (e) {
      console.error(e);
      setStatus('Error al cargar la política', false);
    }
  }

  function preset(kind) {
    let rule = null;
    switch(kind){
      case 'eurSmall':
        rule = { id: 'eur-small', priority: 10, when: { currency: { in: ['EUR'] }, amount: { lt: 50 } }, action: { route: 'dummyCard' } };
        break;
      case 'binES':
        rule = { id: 'bin-es', priority: 15, when: { bin: { inPrefixes: ['4571','4029'] } }, action: { route: 'dummyCard' } };
        break;
      case 'issuerBR':
        rule = { id: 'issuer-br', priority: 20, when: { issuerCountry: { in: ['BR'] } }, action: { route: 'dummyCard' } };
        break;
      case 'schemeVisa':
        rule = { id: 'scheme-visa', priority: 5, when: { scheme: { in: ['visa','VISA','Visa'] } }, action: { route: 'dummyCard' } };
        break;
      case 'lowLatency':
        rule = { id: 'low-lat', priority: 30, when: { latencyMs: { lt: 150 } }, action: { route: 'dummyCard' } };
        break;
    }
    try {
      const obj = JSON.parse(policy.value || '{}');
      obj.merchantId = merchantId.value;
      obj.version = obj.version || 'v1';
      obj.defaultConnector = defaultConnector.value || 'dummyCard';
      obj.rules = Array.isArray(obj.rules) ? obj.rules : [];
      obj.rules.push(rule);
      policy.value = JSON.stringify(obj, null, 2);
      setStatus('Regla añadida. No olvides Guardar.');
    } catch {
      setStatus('JSON inválido en el editor', false);
    }
  }

  async function savePolicy() {
    try {
      localStorage.setItem('monetiser.defaultConnector', defaultConnector.value);
      const obj = JSON.parse(policy.value);
      obj.merchantId = merchantId.value;
      obj.defaultConnector = defaultConnector.value || obj.defaultConnector || 'dummyCard';
      await api('/validate', 'POST', obj);
      const saved = await api(`/${encodeURIComponent(merchantId.value)}`, 'PUT', obj);
      policy.value = JSON.stringify(saved.policy, null, 2);
      setStatus('Guardado correctamente');
    } catch (e) {
      console.error(e);
      const errors = e?.data?.errors || [];
      setStatus('Error al guardar: ' + (errors.map(x=>x.path+': '+x.message).join(' | ') || 'ver consola'), false);
    }
  }

  async function tryPolicy() {
    try {
      localStorage.setItem('monetiser.sampleAmount', sampleAmount.value);
      localStorage.setItem('monetiser.sampleCurrency', sampleCurrency.value);
      localStorage.setItem('monetiser.sampleCard', sampleCard.value);

      const obj = JSON.parse(policy.value);
      const sample = {
        amount: Number(sampleAmount.value),
        currency: sampleCurrency.value,
        cardNumber: sampleCard.value || undefined
      };
      const res = await fetch('/rules/try', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ policy: obj, sample })
      });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error('http_error'), { data });

      const lines = [
        `Conector: ${data.decision.connector}`,
        `Regla aplicada: ${data.decision.matchedRuleId || 'default'}`,
        '',
        ...(data.explainHuman || [])
      ];
      tryOut.innerText = lines.join('\n');
      setStatus('Prueba ejecutada');
    } catch (e) {
      console.error(e);
      tryOut.innerText = 'Error al probar la política.';
      setStatus('Error en prueba', false);
    }
  }

  function exportPolicy() {
    if (!FEATURE_RULE_EXPORT_UI) return;
    try {
      const blob = new Blob([policy.value || '{}'], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `policy_${merchantId.value}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('Exportado');
    } catch {
      setStatus('No se pudo exportar', false);
    }
  }

  async function importPolicy(file) {
    if (!FEATURE_RULE_EXPORT_UI || !file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      obj.merchantId = merchantId.value;
      const v = await api('/validate', 'POST', obj);
      policy.value = JSON.stringify(v.normalized || obj, null, 2);
      setStatus('Importado. Revisa y pulsa Guardar.');
    } catch (e) {
      console.error(e);
      setStatus('JSON inválido o error en validación', false);
    }
  }

  async function loadAudit() {
    try {
      const res = await api(`/${encodeURIComponent(merchantId.value)}/audit?limit=20&offset=0`, 'GET');
      auditOut.classList.remove('hidden');
      auditTable.innerHTML = '';
      (res.items || []).forEach(it => {
        const div = document.createElement('div');
        div.className = 'border border-slate-700 rounded p-2';
        div.textContent = `${new Date(it.createdAt).toLocaleString()} · actor=${it.actor} · diff=${it.diffSize} · fields=[${(it.changedFields||[]).join(',')}] · prev=${it.prevHash?.slice(0,8)} → next=${it.nextHash?.slice(0,8)}`;
        auditTable.appendChild(div);
      });
      setStatus('Histórico cargado');
    } catch (e) {
      console.error(e);
      setStatus('Error al cargar histórico', false);
    }
  }

  // Eventos
  document.getElementById('btnLoad').addEventListener('click', loadPolicy);
  document.getElementById('btnSave').addEventListener('click', savePolicy);
  document.getElementById('btnTry').addEventListener('click', tryPolicy);
  document.getElementById('btnExport').addEventListener('click', exportPolicy);
  document.getElementById('btnAudit').addEventListener('click', loadAudit);
  document.querySelectorAll('[data-preset]').forEach(b => {
    b.addEventListener('click', () => preset(b.getAttribute('data-preset')));
  });
  $('fileImport').addEventListener('change', (e)=> importPolicy(e.target.files?.[0]));

  // Carga inicial
  loadPolicy();
})();
