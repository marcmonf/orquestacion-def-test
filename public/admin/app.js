/* global localStorage, fetch */
(function(){
  const $ = (id) => document.getElementById(id);
  const merchantId = $('merchantId');
  const adminToken = $('adminToken');
  const defaultConnector = $('defaultConnector');
  const policy = $('policy');
  const status = $('status');

  // Persistencia local de campos
  merchantId.value = localStorage.getItem('monetiser.merchantId') || 'demo-merchant';
  adminToken.value = localStorage.getItem('monetiser.adminToken') || '';
  defaultConnector.value = localStorage.getItem('monetiser.defaultConnector') || 'dummyCard';

  function setStatus(msg, ok=true) {
    status.textContent = msg;
    status.className = 'mt-3 text-sm ' + (ok ? 'text-emerald-400' : 'text-rose-400');
  }

  async function api(path, method='GET', body) {
    const headers = { 'Content-Type':'application/json' };
    if (adminToken.value) headers['X-Admin-Token'] = adminToken.value;
    const res = await fetch(`/rules${path}`, {
      method,
      headers,
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
      // Ensure defaultConnector visible en la UI
      defaultConnector.value = data.policy.defaultConnector || 'dummyCard';
      localStorage.setItem('monetiser.defaultConnector', defaultConnector.value);
      policy.value = JSON.stringify(data.policy, null, 2);
      setStatus('Política cargada');
    } catch (e) {
      console.error(e);
      setStatus('Error al cargar la política', false);
    }
  }

  function addPreset(kind) {
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

      // Validación previa en backend
      await api('/validate', 'POST', obj);

      // Upsert
      const saved = await api(`/${encodeURIComponent(merchantId.value)}`, 'PUT', obj);
      policy.value = JSON.stringify(saved.policy, null, 2);
      setStatus('Guardado correctamente');
    } catch (e) {
      console.error(e);
      const errors = e?.data?.errors || [];
      setStatus('Error al guardar: ' + (errors.map(x=>x.path+': '+x.message).join(' | ') || 'ver consola'), false);
    }
  }

  // Eventos
  document.getElementById('btnLoad').addEventListener('click', loadPolicy);
  document.getElementById('btnSave').addEventListener('click', savePolicy);
  document.querySelectorAll('[data-preset]').forEach(b => {
    b.addEventListener('click', () => addPreset(b.getAttribute('data-preset')));
  });

  // Carga inicial
  loadPolicy();
})();
