/* public/admin/dashboard.js */
(function () {
  'use strict';

  var BASE_URL = 'https://orquestacion-def-test.onrender.com';
  var session = null;
  var data = {};
  var chartInstances = {};
  var dragSrc = null;

  var WIDGET_DEFS = [
    { id: 'kpi_volume',     label: 'Volumen total',         size: 'normal' },
    { id: 'kpi_count',      label: 'Nº transacciones',      size: 'normal' },
    { id: 'kpi_approval',   label: 'Tasa aprobación',       size: 'normal' },
    { id: 'kpi_avg',        label: 'Ticket medio',          size: 'normal' },
    { id: 'kpi_refund',     label: 'Tasa refund',           size: 'normal' },
    { id: 'kpi_fallback',   label: 'Tasa fallback',         size: 'normal' },
    { id: 'chart_timeline', label: 'Evolución temporal',    size: 'large'  },
    { id: 'chart_methods',  label: 'Métodos de pago',       size: 'normal' },
    { id: 'list_countries', label: 'Top países',            size: 'normal' },
    { id: 'list_tx',        label: 'Últimas transacciones', size: 'large'  },
  ];

  var activeWidgets = JSON.parse(localStorage.getItem('m_widgets') || 'null')
    || WIDGET_DEFS.map(function (w) { return w.id; });

  /* ── SESSION ── */
  function loadSession() {
    try {
      var s = localStorage.getItem('m_session');
      if (!s) return null;
      var parsed = JSON.parse(s);
      if (parsed.exp && Date.now() / 1000 > parsed.exp) {
        localStorage.removeItem('m_session');
        return null;
      }
      return parsed;
    } catch (e) { return null; }
  }

  function saveSession(token, merchant) {
    var exp = null;
    try { exp = JSON.parse(atob(token.split('.')[1])).exp; } catch (e) {}
    var s = { token: token, merchant: merchant, exp: exp };
    localStorage.setItem('m_session', JSON.stringify(s));
    return s;
  }

  /* ── LOGIN ── */
  function doLogin() {
    var email = document.getElementById('loginEmail').value.trim();
    var pass  = document.getElementById('loginPass').value;
    var errEl = document.getElementById('loginErr');
    var btn   = document.getElementById('loginBtn');

    errEl.textContent = '';
    if (!email || !pass) { errEl.textContent = 'Email y contraseña requeridos'; return; }

    btn.disabled = true;
    btn.textContent = 'Entrando…';

    fetch(BASE_URL + '/backoffice/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: pass })
    })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok || !res.j.token) {
        var msg = res.j.error === 'invalid_credentials' ? 'Credenciales incorrectas' : (res.j.error || 'Error de autenticación');
        errEl.textContent = msg;
        btn.disabled = false;
        btn.textContent = 'Entrar';
        return;
      }
      session = saveSession(res.j.token, res.j.merchant);
      showApp();
    })
    .catch(function (e) {
      errEl.textContent = 'No se pudo conectar con el servidor';
      btn.disabled = false;
      btn.textContent = 'Entrar';
    });
  }

  function doLogout() {
    localStorage.removeItem('m_session');
    session = null;
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('loginPass').value = '';
    document.getElementById('loginBtn').disabled = false;
    document.getElementById('loginBtn').textContent = 'Entrar';
    document.getElementById('loginErr').textContent = '';
  }

  function showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appShell').style.display = 'block';
    var name = (session.merchant && (session.merchant.merchantName || session.merchant.merchantId)) || '–';
    document.getElementById('merchantBadge').textContent = name;
    document.getElementById('dashTitle').textContent = 'Dashboard · ' + name;
    renderWidgetPicker();
    renderGrid();
    loadAll();
  }

  /* ── API ── */
  function api(path, opts) {
    opts = opts || {};
    if (!session || !session.token) return Promise.reject(new Error('no_session'));
    var h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.token };
    return fetch(BASE_URL + path, Object.assign({ headers: h }, opts))
      .then(function (r) {
        if (r.status === 401) { doLogout(); throw new Error('session_expired'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  /* ── LOAD ── */
  function loadAll() {
    var days = parseInt(document.getElementById('cfgPeriod').value);
    setStatus('loading');

    Promise.allSettled([
      api('/backoffice/dashboard?days=' + days),
      api('/backoffice/analytics/timeline?days=' + days),
      api('/backoffice/analytics/countries?days=' + days),
      api('/backoffice/analytics/methods?days=' + days),
      api('/backoffice/transactions?limit=20&page=1'),
    ]).then(function (results) {
      data.kpis      = results[0].status === 'fulfilled' ? results[0].value.kpis           : null;
      data.timeline  = results[1].status === 'fulfilled' ? results[1].value                : null;
      data.countries = results[2].status === 'fulfilled' ? results[2].value.countries      : null;
      data.methods   = results[3].status === 'fulfilled' ? results[3].value.methods        : null;
      data.txList    = results[4].status === 'fulfilled' ? (results[4].value.transactions || []) : [];
      populateWidgets();
      setStatus('ok');
      document.getElementById('lastUpdate').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-ES');
    }).catch(function (e) {
      setStatus('error', e.message);
    });
  }

  function setStatus(s, msg) {
    var dot = document.getElementById('statusDot');
    var lbl = document.getElementById('statusMsg');
    if (s === 'ok')      { dot.className = 'ok';  lbl.textContent = 'Conectado'; }
    else if (s === 'error') { dot.className = 'err'; lbl.textContent = msg || 'Error'; }
    else                 { dot.className = '';    lbl.textContent = 'Cargando…'; }
  }

  /* ── WIDGET PICKER ── */
  function toggleWidgetEditor() {
    var el = document.getElementById('widgetEditor');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }

  function renderWidgetPicker() {
    var el = document.getElementById('widgetPicker');
    el.innerHTML = '';
    WIDGET_DEFS.forEach(function (w) {
      var btn = document.createElement('button');
      btn.className = 'pick-btn' + (activeWidgets.indexOf(w.id) >= 0 ? ' active' : '');
      btn.textContent = w.label;
      btn.addEventListener('click', function () { toggleWidget(w.id, btn); });
      el.appendChild(btn);
    });
  }

  function toggleWidget(id, btn) {
    var idx = activeWidgets.indexOf(id);
    if (idx >= 0) {
      if (activeWidgets.length <= 2) return;
      activeWidgets.splice(idx, 1);
      btn.classList.remove('active');
    } else {
      activeWidgets.push(id);
      btn.classList.add('active');
    }
    localStorage.setItem('m_widgets', JSON.stringify(activeWidgets));
    renderGrid();
    if (Object.keys(data).length) populateWidgets();
  }

  /* ── GRID ── */
  function renderGrid() {
    var grid = document.getElementById('grid');
    grid.innerHTML = '';
    activeWidgets.forEach(function (id) {
      var def = WIDGET_DEFS.filter(function (w) { return w.id === id; })[0];
      if (!def) return;
      var div = document.createElement('div');
      div.className = 'widget' + (def.size === 'large' ? ' widget-lg' : '');
      div.dataset.id = id;
      div.draggable = true;

      var header = document.createElement('div');
      header.className = 'widget-header';

      var title = document.createElement('div');
      title.className = 'widget-title';
      title.textContent = def.label;

      var removeBtn = document.createElement('button');
      removeBtn.className = 'widget-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (function (wid) {
        return function () { removeWidget(wid); };
      })(id));

      header.appendChild(title);
      header.appendChild(removeBtn);

      var body = document.createElement('div');
      body.id = 'wb_' + id;
      var spinner = document.createElement('div');
      spinner.className = 'spinner';
      body.appendChild(spinner);

      div.appendChild(header);
      div.appendChild(body);
      grid.appendChild(div);
    });
    bindDrag();
  }

  function removeWidget(id) {
    var idx = activeWidgets.indexOf(id);
    if (idx < 0 || activeWidgets.length <= 2) return;
    activeWidgets.splice(idx, 1);
    localStorage.setItem('m_widgets', JSON.stringify(activeWidgets));
    renderWidgetPicker();
    renderGrid();
    if (Object.keys(data).length) populateWidgets();
  }

  /* ── POPULATE ── */
  function populateWidgets() {
    activeWidgets.forEach(function (id) {
      var el = document.getElementById('wb_' + id);
      if (!el) return;
      try { renderWidget(id, el); }
      catch (e) { el.innerHTML = '<div style="color:var(--text3);font-size:11px">Error: ' + e.message + '</div>'; }
    });
  }

  function fmt(v) {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v || 0);
  }
  function pct(v) { return (Math.round((v || 0) * 10) / 10).toFixed(1) + '%'; }
  function badge(type, txt) {
    return '<span class="kpi-badge ' + type + '">' + txt + '</span>';
  }
  function statusBadge(s) {
    return '<span class="badge badge-' + (s || '') + '">' + (s || '–') + '</span>';
  }

  function renderWidget(id, el) {
    var k = data.kpis || {};
    switch (id) {
      case 'kpi_volume':
        el.innerHTML = '<div class="kpi-value">' + fmt(k.volume) + '</div>' + badge('neutral', 'volumen ' + (data.timeline && data.timeline.days ? data.timeline.days + 'd' : '30d'));
        break;
      case 'kpi_count':
        el.innerHTML = '<div class="kpi-value">' + (k.totalTransactions || 0).toLocaleString('es-ES') + '</div>' + badge('neutral', 'transacciones');
        break;
      case 'kpi_approval':
        el.innerHTML = '<div class="kpi-value">' + pct(k.approvalRate) + '</div>' + badge(k.approvalRate >= 70 ? 'up' : 'down', k.approvalRate >= 70 ? '▲ en objetivo' : '▼ bajo objetivo');
        break;
      case 'kpi_avg':
        el.innerHTML = '<div class="kpi-value">' + fmt(k.avgTicket) + '</div>' + badge('neutral', 'ticket medio');
        break;
      case 'kpi_refund':
        el.innerHTML = '<div class="kpi-value">' + pct(k.refundRate) + '</div>' + badge(k.refundRate < 5 ? 'up' : 'down', k.refundRate < 5 ? '▲ normal' : '▼ alto');
        break;
      case 'kpi_fallback':
        el.innerHTML = '<div class="kpi-value">' + pct(k.fallbackRate) + '</div>' + badge(k.fallbackRate < 10 ? 'up' : 'down', 'fallback rate');
        break;
      case 'chart_timeline':  renderTimeline(el);  break;
      case 'chart_methods':   renderMethods(el);   break;
      case 'list_countries':  renderCountries(el); break;
      case 'list_tx':         renderTxList(el);    break;
    }
  }

  /* ── CHARTS ── */
  function renderTimeline(el) {
    var tl = data.timeline && data.timeline.timeline;
    if (!tl || !tl.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px 0">Sin datos</div>'; return; }
    el.innerHTML = '<div class="widget-chart"><canvas id="c_timeline"></canvas></div>';
    if (chartInstances.timeline) chartInstances.timeline.destroy();
    chartInstances.timeline = new Chart(document.getElementById('c_timeline').getContext('2d'), {
      type: 'bar',
      data: {
        labels: tl.map(function (d) { return (d.date || '').slice(5); }),
        datasets: [
          { label: 'Total',     data: tl.map(function (d) { return d.count; }),    backgroundColor: 'rgba(124,111,224,.6)', borderRadius: 3 },
          { label: 'Aprobadas', data: tl.map(function (d) { return d.approved; }), backgroundColor: 'rgba(62,207,142,.5)',  borderRadius: 3 },
          { label: 'Rechazadas',data: tl.map(function (d) { return d.declined; }), backgroundColor: 'rgba(240,96,96,.4)',   borderRadius: 3 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#a89ec8', font: { size: 10 }, boxWidth: 8 } } },
        scales: {
          x: { ticks: { color: '#6b6390', font: { size: 10 } }, grid: { color: 'rgba(124,111,224,.06)' } },
          y: { ticks: { color: '#6b6390', font: { size: 10 } }, grid: { color: 'rgba(124,111,224,.06)' } }
        }
      }
    });
  }

  var METHOD_COLORS = ['#7c6fe0','#3ecf8e','#5b9cf6','#f0a030','#f06060','#a594f9'];
  function renderMethods(el) {
    var m = data.methods;
    if (!m || !m.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos</div>'; return; }
    el.innerHTML = '<div class="widget-chart"><canvas id="c_methods"></canvas></div>';
    if (chartInstances.methods) chartInstances.methods.destroy();
    chartInstances.methods = new Chart(document.getElementById('c_methods').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: m.map(function (x) { return x.processor || x.method || '–'; }),
        datasets: [{ data: m.map(function (x) { return x.count; }), backgroundColor: METHOD_COLORS, borderWidth: 0, hoverOffset: 4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: '#a89ec8', font: { size: 11 }, boxWidth: 10 } },
          tooltip: { callbacks: { label: function (c) { return c.label + ': ' + c.parsed + ' tx · ' + (m[c.dataIndex] && m[c.dataIndex].approvalRate || 0) + '% apr.'; } } }
        }
      }
    });
  }

  var FLAGS = { ES:'🇪🇸',FR:'🇫🇷',DE:'🇩🇪',IT:'🇮🇹',GB:'🇬🇧',US:'🇺🇸',BR:'🇧🇷',MX:'🇲🇽',PT:'🇵🇹',NL:'🇳🇱',BE:'🇧🇪',PL:'🇵🇱',AR:'🇦🇷',CO:'🇨🇴' };
  function renderCountries(el) {
    var cs = data.countries;
    if (!cs || !cs.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos de países</div>'; return; }
    var max = cs[0].count;
    el.innerHTML = cs.map(function (c) {
      return '<div class="country-row">' +
        '<span class="country-flag">' + (FLAGS[c.country] || '🌍') + '</span>' +
        '<span class="country-name">' + c.country + '</span>' +
        '<div class="country-bar-wrap"><div class="country-bar" style="width:' + Math.round(c.count / max * 100) + '%"></div></div>' +
        '<span class="country-pct">' + c.count + '</span>' +
        '</div>';
    }).join('');
  }

  function renderTxList(el) {
    var txs = (data.txList || []).slice(0, 10);
    if (!txs.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin transacciones</div>'; return; }
    var table = document.createElement('table');
    table.className = 'tx-table';
    table.innerHTML = '<thead><tr><th>Payment ID</th><th>Referencia</th><th>Importe</th><th>Estado</th><th>Conector</th><th>Fecha</th></tr></thead>';
    var tbody = document.createElement('tbody');
    txs.forEach(function (t) {
      var tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML =
        '<td style="font-family:monospace;font-size:11px">' + (t.paymentId || '–').slice(0, 14) + '…</td>' +
        '<td>' + (t.merchantReference || '–') + '</td>' +
        '<td>' + fmt(t.amount) + '</td>' +
        '<td>' + statusBadge(t.status) + '</td>' +
        '<td>' + (t.processor || '–') + '</td>' +
        '<td>' + (t.createdAt || '').slice(0, 10) + '</td>';
      tr.addEventListener('click', (function (tx) { return function () { showTxDetail(tx); }; })(t));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.innerHTML = '';
    el.appendChild(table);
  }

  /* ── TX DETAIL ── */
  function showTxDetail(t) {
    var detail = document.getElementById('txDetail');
    detail.innerHTML = '<div class="spinner"></div>';
    document.getElementById('txModal').classList.add('open');

    api('/backoffice/transactions/' + t.paymentId)
      .then(function (r) {
        var tx = r.transaction || t;
        var ops = r.operations || [];
        renderTxDetail(tx, ops);
      })
      .catch(function () { renderTxDetail(t, []); });
  }

  function renderTxDetail(tx, ops) {
    var fields = [
      ['Payment ID', tx.paymentId], ['Merchant Ref', tx.merchantReference],
      ['Importe', fmt(tx.amount)], ['Moneda', tx.currency],
      ['Estado', tx.status], ['Conector', tx.processor],
      ['Método', tx.method], ['BIN', tx.bin],
      ['Marca', tx.cardBrand], ['Tipo', tx.cardType],
      ['País emisor', tx.issuerCountry], ['Fallback', tx.fallbackUsed ? 'Sí' : 'No'],
      ['Auth Code', tx.authCode], ['Creado', (tx.createdAt || '').slice(0, 19).replace('T', ' ')],
      ['Actualizado', (tx.updatedAt || '').slice(0, 19).replace('T', ' ')],
    ];

    var cancellable = ['initialized','hosted_pending','processing','authorized','approved','pending'].indexOf(tx.status) >= 0;

    var html = '<div style="margin-bottom:12px">' + statusBadge(tx.status) + '</div>';
    html += '<div class="detail-grid">';
    fields.forEach(function (f) {
      html += '<div class="detail-item"><label>' + f[0] + '</label><span>' + (f[1] || '–') + '</span></div>';
    });
    html += '</div>';

    if (ops.length) {
      html += '<div style="margin-top:16px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Operaciones</div>';
      ops.forEach(function (o) {
        html += '<div style="font-size:12px;color:var(--text2);padding:4px 0;border-bottom:1px solid var(--border)">' + o.type + ' · ' + o.status + ' · ' + (o.createdAt || '').slice(0, 10) + '</div>';
      });
    }

    if (cancellable) {
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-danger';
      cancelBtn.textContent = 'Cancelar transacción';
      cancelBtn.style.marginTop = '16px';
      cancelBtn.addEventListener('click', function () { cancelTx(tx.paymentId); });
      var wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      wrapper.appendChild(cancelBtn);
      document.getElementById('txDetail').innerHTML = '';
      document.getElementById('txDetail').appendChild(wrapper);
    } else {
      document.getElementById('txDetail').innerHTML = html;
    }
  }

  function cancelTx(paymentId) {
    if (!confirm('¿Cancelar esta transacción? Esta acción queda registrada.')) return;
    api('/backoffice/transactions/' + paymentId + '/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'backoffice_manual_cancel' })
    })
    .then(function () {
      document.getElementById('txModal').classList.remove('open');
      loadAll();
    })
    .catch(function (e) { alert('Error al cancelar: ' + e.message); });
  }

  /* ── SEARCH ── */
  function bindSearch() {
    document.getElementById('txSearch').addEventListener('input', function () {
      var q = this.value.toLowerCase();
      var el = document.getElementById('wb_list_tx');
      if (!el) return;
      var orig = data.txList;
      if (!q) { renderWidget('list_tx', el); return; }
      data.txList = (orig || []).filter(function (t) {
        return (t.paymentId || '').toLowerCase().indexOf(q) >= 0 ||
               (t.merchantReference || '').toLowerCase().indexOf(q) >= 0 ||
               (t.status || '').indexOf(q) >= 0 ||
               (t.processor || '').indexOf(q) >= 0;
      });
      renderWidget('list_tx', el);
      data.txList = orig;
    });
  }

  /* ── DRAG & DROP ── */
  function bindDrag() {
    document.querySelectorAll('.widget').forEach(function (el) {
      el.addEventListener('dragstart', function (e) {
        dragSrc = el; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', function () {
        el.classList.remove('dragging');
        document.querySelectorAll('.widget').forEach(function (w) { w.classList.remove('drag-over'); });
      });
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('drag-over'); });
      el.addEventListener('dragleave', function () { el.classList.remove('drag-over'); });
      el.addEventListener('drop', function (e) {
        e.preventDefault(); el.classList.remove('drag-over');
        if (dragSrc && dragSrc !== el) {
          var g = document.getElementById('grid');
          var els = Array.prototype.slice.call(g.children);
          g.insertBefore(dragSrc, els.indexOf(el) < els.indexOf(dragSrc) ? el : el.nextSibling);
          activeWidgets = Array.prototype.slice.call(g.children).map(function (e) { return e.dataset.id; }).filter(Boolean);
          localStorage.setItem('m_widgets', JSON.stringify(activeWidgets));
        }
      });
    });
  }

  /* ── BIND STATIC BUTTONS ── */
  function bindButtons() {
    document.getElementById('loginBtn').addEventListener('click', doLogin);
    document.getElementById('loginPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    document.getElementById('logoutBtn').addEventListener('click', doLogout);
    document.getElementById('refreshBtn').addEventListener('click', loadAll);
    document.getElementById('widgetToggleBtn').addEventListener('click', toggleWidgetEditor);
    document.getElementById('txModalClose').addEventListener('click', function () {
      document.getElementById('txModal').classList.remove('open');
    });
  }

  /* ── BOOT ── */
  bindButtons();
  bindSearch();
  session = loadSession();
  if (session) {
    showApp();
  }

})();
