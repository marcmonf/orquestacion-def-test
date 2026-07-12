/* public/admin/dashboard.js */
(function () {
  'use strict';

  var BASE_URL = 'https://orquestacion-def-test.onrender.com';
  var session = null;
  var data = {};
  var chartInstances = {};
  var dragSrc = null;
  var currentTx = null;

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
      var p = JSON.parse(s);
      if (p.exp && Date.now() / 1000 > p.exp) { localStorage.removeItem('m_session'); return null; }
      return p;
    } catch (e) { return null; }
  }

  function saveSession(token, user) {
    var exp = null;
    try { exp = JSON.parse(atob(token.split('.')[1])).exp; } catch (e) {}
    var s = { token: token, user: user, exp: exp };
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
    btn.disabled = true; btn.textContent = 'Entrando…';
    fetch(BASE_URL + '/backoffice/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: pass })
    })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok || !res.j.token) {
        errEl.textContent = res.j.error === 'invalid_credentials' ? 'Credenciales incorrectas' : (res.j.error || 'Error');
        btn.disabled = false; btn.textContent = 'Entrar'; return;
      }
      session = saveSession(res.j.token, res.j.user);
      showApp();
    })
    .catch(function () {
      errEl.textContent = 'No se pudo conectar'; btn.disabled = false; btn.textContent = 'Entrar';
    });
  }

  function doLogout() {
    localStorage.removeItem('m_session'); session = null;
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
    var u = session.user || {};
    var name = u.name || u.email || '–';
    document.getElementById('merchantBadge').textContent = name;
    document.getElementById('dashTitle').textContent = 'Dashboard · ' + name;
    // Mostrar tab de usuarios y merchants solo a superadmin
    var usersTab = document.getElementById('tabBtnUsers');
    if (usersTab) usersTab.style.display = u.role === 'superadmin' ? 'inline-flex' : 'none';
    var merchantsTab = document.getElementById('tabBtnMerchants');
    if (merchantsTab) merchantsTab.style.display = u.role === 'superadmin' ? 'inline-flex' : 'none';
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
      data.kpis      = results[0].status === 'fulfilled' ? results[0].value.kpis : null;
      data.timeline  = results[1].status === 'fulfilled' ? results[1].value : null;
      data.countries = results[2].status === 'fulfilled' ? results[2].value.countries : null;
      data.methods   = results[3].status === 'fulfilled' ? results[3].value.methods : null;
      data.txList    = results[4].status === 'fulfilled' ? (results[4].value.transactions || []) : [];
      populateWidgets();
      setStatus('ok');
      document.getElementById('lastUpdate').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-ES');
    }).catch(function (e) { setStatus('error', e.message); });
  }

  function setStatus(s, msg) {
    var dot = document.getElementById('statusDot');
    var lbl = document.getElementById('statusMsg');
    if (s === 'ok')    { dot.className = 'ok';  lbl.textContent = 'Conectado'; }
    else if (s === 'error') { dot.className = 'err'; lbl.textContent = msg || 'Error'; }
    else               { dot.className = '';    lbl.textContent = 'Cargando…'; }
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
      activeWidgets.splice(idx, 1); btn.classList.remove('active');
    } else {
      activeWidgets.push(id); btn.classList.add('active');
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
      div.dataset.id = id; div.draggable = true;
      var header = document.createElement('div'); header.className = 'widget-header';
      var title = document.createElement('div'); title.className = 'widget-title'; title.textContent = def.label;
      var actions = document.createElement('div'); actions.className = 'widget-header-actions';
      var exp = document.createElement('button'); exp.className = 'widget-expand'; exp.textContent = '⤢'; exp.title = 'Ver más';
      exp.addEventListener('click', function (e) { e.stopPropagation(); openExpand(id); });
      var rm = document.createElement('button'); rm.className = 'widget-remove'; rm.textContent = '×';
      rm.addEventListener('click', function (e) { e.stopPropagation(); removeWidget(id); });
      actions.appendChild(exp); actions.appendChild(rm);
      header.appendChild(title); header.appendChild(actions);
      var body = document.createElement('div'); body.id = 'wb_' + id;
      var sp = document.createElement('div'); sp.className = 'spinner'; body.appendChild(sp);
      div.appendChild(header); div.appendChild(body);
      div.addEventListener('click', function () {
        if (div.classList.contains('dragging')) return;
        openExpand(id);
      });
      grid.appendChild(div);
    });
    bindDrag();
  }

  function removeWidget(id) {
    var idx = activeWidgets.indexOf(id);
    if (idx < 0 || activeWidgets.length <= 2) return;
    activeWidgets.splice(idx, 1);
    localStorage.setItem('m_widgets', JSON.stringify(activeWidgets));
    renderWidgetPicker(); renderGrid();
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

  // Los importes se almacenan en la unidad mínima de la moneda (céntimos), igual que
  // en Paylands (amount:100 = 1,00 €). fmt() recibe CÉNTIMOS y los muestra en euros.
  function fmt(cents) { return new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format((Number(cents)||0)/100); }
  function pct(v) { return (Math.round((v||0)*10)/10).toFixed(1)+'%'; }
  function badge(type,txt) { return '<span class="kpi-badge '+type+'">'+txt+'</span>'; }
  function statusBadge(s) { return '<span class="badge badge-'+(s||'')+'">'+( s||'–')+'</span>'; }

  function renderWidget(id, el) {
    var k = data.kpis || {};
    switch (id) {
      case 'kpi_volume':   el.innerHTML = '<div class="kpi-value">'+fmt(k.volume)+'</div>'+badge('neutral','volumen'); break;
      case 'kpi_count':    el.innerHTML = '<div class="kpi-value">'+((k.totalTransactions||0).toLocaleString('es-ES'))+'</div>'+badge('neutral','transacciones'); break;
      case 'kpi_approval': el.innerHTML = '<div class="kpi-value">'+pct(k.approvalRate)+'</div>'+badge(k.approvalRate>=70?'up':'down',k.approvalRate>=70?'▲ objetivo':'▼ bajo'); break;
      case 'kpi_avg':      el.innerHTML = '<div class="kpi-value">'+fmt(k.avgTicket)+'</div>'+badge('neutral','ticket medio'); break;
      case 'kpi_refund':   el.innerHTML = '<div class="kpi-value">'+pct(k.refundRate)+'</div>'+badge(k.refundRate<5?'up':'down',k.refundRate<5?'▲ normal':'▼ alto'); break;
      case 'kpi_fallback': el.innerHTML = '<div class="kpi-value">'+pct(k.fallbackRate)+'</div>'+badge(k.fallbackRate<10?'up':'down','fallback rate'); break;
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
      type:'bar',
      data:{
        labels:tl.map(function(d){return(d.date||'').slice(5);}),
        datasets:[
          {label:'Total',    data:tl.map(function(d){return d.count;}),    backgroundColor:'rgba(124,111,224,.6)',borderRadius:3},
          {label:'Aprobadas',data:tl.map(function(d){return d.approved;}), backgroundColor:'rgba(62,207,142,.5)', borderRadius:3},
          {label:'Rechazadas',data:tl.map(function(d){return d.declined;}),backgroundColor:'rgba(240,96,96,.4)',  borderRadius:3},
        ]
      },
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{labels:{color:'#a89ec8',font:{size:10},boxWidth:8}}},
        scales:{x:{ticks:{color:'#6b6390',font:{size:10}},grid:{color:'rgba(124,111,224,.06)'}},
                y:{ticks:{color:'#6b6390',font:{size:10}},grid:{color:'rgba(124,111,224,.06)'}}}
      }
    });
  }

  var METHOD_COLORS=['#7c6fe0','#3ecf8e','#5b9cf6','#f0a030','#f06060','#a594f9'];
  function renderMethods(el) {
    var m = data.methods;
    if (!m||!m.length){el.innerHTML='<div style="color:var(--text3);font-size:12px">Sin datos</div>';return;}
    el.innerHTML='<div class="widget-chart"><canvas id="c_methods"></canvas></div>';
    if(chartInstances.methods)chartInstances.methods.destroy();
    chartInstances.methods=new Chart(document.getElementById('c_methods').getContext('2d'),{
      type:'doughnut',
      data:{labels:m.map(function(x){return x.processor||x.method||'–';}),
            datasets:[{data:m.map(function(x){return x.count;}),backgroundColor:METHOD_COLORS,borderWidth:0,hoverOffset:4}]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{position:'right',labels:{color:'#a89ec8',font:{size:11},boxWidth:10}},
          tooltip:{callbacks:{label:function(c){return c.label+': '+c.parsed+' tx · '+(m[c.dataIndex]&&m[c.dataIndex].approvalRate||0)+'% apr.';}}}
        }}
    });
  }

  var FLAGS={ES:'🇪🇸',FR:'🇫🇷',DE:'🇩🇪',IT:'🇮🇹',GB:'🇬🇧',US:'🇺🇸',BR:'🇧🇷',MX:'🇲🇽',PT:'🇵🇹',NL:'🇳🇱',BE:'🇧🇪',PL:'🇵🇱',AR:'🇦🇷',CO:'🇨🇴'};
  function renderCountries(el) {
    var cs=data.countries;
    if(!cs||!cs.length){el.innerHTML='<div style="color:var(--text3);font-size:12px">Sin datos de países</div>';return;}
    var max=cs[0].count;
    el.innerHTML=cs.map(function(c){
      return '<div class="country-row">'+
        '<span class="country-flag">'+(FLAGS[c.country]||'🌍')+'</span>'+
        '<span class="country-name">'+c.country+'</span>'+
        '<div class="country-bar-wrap"><div class="country-bar" style="width:'+Math.round(c.count/max*100)+'%"></div></div>'+
        '<span class="country-pct">'+c.count+'</span></div>';
    }).join('');
  }

  function renderTxList(el) {
    var txs=(data.txList||[]).slice(0,10);
    if(!txs.length){el.innerHTML='<div style="color:var(--text3);font-size:12px">Sin transacciones</div>';return;}
    var table=document.createElement('table'); table.className='tx-table';
    table.innerHTML='<thead><tr><th>Payment ID</th><th>Referencia</th><th>Importe</th><th>Estado</th><th>Conector</th><th>Fecha</th></tr></thead>';
    var tbody=document.createElement('tbody');
    txs.forEach(function(t){
      var tr=document.createElement('tr'); tr.style.cursor='pointer';
      tr.innerHTML=
        '<td style="font-family:monospace;font-size:11px">'+(t.paymentId||'–').slice(0,14)+'…</td>'+
        '<td>'+(t.merchantReference||'–')+'</td>'+
        '<td>'+fmt(t.amount)+'</td>'+
        '<td>'+statusBadge(t.status)+'</td>'+
        '<td>'+(t.processor||'–')+'</td>'+
        '<td>'+(t.createdAt||'').slice(0,10)+'</td>';
      tr.addEventListener('click',(function(tx){return function(e){ if(e&&e.stopPropagation) e.stopPropagation(); showTxDetail(tx); };})(t));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); el.innerHTML=''; el.appendChild(table);
  }

  /* ── WIDGET EXPAND ──
     Tocar/clicar cualquier widget abre una vista ampliada de su contenido:
     KPIs → evolución temporal; gráficos → versión grande + tabla de datos;
     transacciones → lista completa paginada y filtrable contra el servidor. */
  function openExpand(id) {
    var def = WIDGET_DEFS.filter(function (w) { return w.id === id; })[0];
    document.getElementById('expandTitle').textContent = def ? def.label : 'Detalle';
    var body = document.getElementById('expandBody');
    body.innerHTML = '<div class="spinner"></div>';
    document.getElementById('expandModal').classList.add('open');

    switch (id) {
      case 'kpi_volume':   renderExpandTimeSeries(body, 'volume', 'Volumen diario', true, '#7c6fe0'); break;
      case 'kpi_count':    renderExpandTimeSeries(body, 'count',  'Nº transacciones diario', false, '#5b9cf6'); break;
      case 'kpi_approval': renderExpandRateSeries(body, 'approved', 'Tasa de aprobación diaria'); break;
      case 'kpi_avg':      renderExpandAvgTicket(body); break;
      case 'kpi_refund':   renderExpandTxSample(body, ['refunded','partially_refunded'], false); break;
      case 'kpi_fallback': renderExpandTxSample(body, null, true); break;
      case 'chart_timeline': renderExpandTimeline(body); break;
      case 'chart_methods':  renderExpandMethods(body);  break;
      case 'list_countries': renderExpandCountries(body); break;
      case 'list_tx':         renderExpandTxList(body); break;
      default: body.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin vista ampliada disponible</div>';
    }
  }

  function destroyExpandChart() {
    if (chartInstances.expand) { chartInstances.expand.destroy(); chartInstances.expand = null; }
  }

  function renderExpandTimeSeries(body, field, label, isCurrency, color) {
    var tl = data.timeline && data.timeline.timeline;
    if (!tl || !tl.length) { body.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos para este período</div>'; return; }
    body.innerHTML = '<div style="height:300px;position:relative"><canvas id="c_expand"></canvas></div>';
    destroyExpandChart();
    chartInstances.expand = new Chart(document.getElementById('c_expand').getContext('2d'), {
      type: 'line',
      data: {
        labels: tl.map(function (d) { return (d.date || '').slice(5); }),
        datasets: [{ label: label, data: tl.map(function (d) { return d[field]; }), borderColor: color, backgroundColor: color + '26', fill: true, tension: .3 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return isCurrency ? fmt(c.parsed.y) : c.parsed.y; } } } },
        scales: {
          x: { ticks: { color: '#6b6390', font: { size: 10 } }, grid: { color: 'rgba(124,111,224,.06)' } },
          y: { ticks: { color: '#6b6390', font: { size: 10 }, callback: function (v) { return isCurrency ? fmt(v) : v; } }, grid: { color: 'rgba(124,111,224,.06)' } }
        }
      }
    });
  }

  function renderExpandRateSeries(body, numeratorField, label) {
    var tl = data.timeline && data.timeline.timeline;
    if (!tl || !tl.length) { body.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos para este período</div>'; return; }
    var rates = tl.map(function (d) { return d.count ? Math.round((d[numeratorField] / d.count) * 1000) / 10 : 0; });
    body.innerHTML = '<div style="height:300px;position:relative"><canvas id="c_expand"></canvas></div>';
    destroyExpandChart();
    chartInstances.expand = new Chart(document.getElementById('c_expand').getContext('2d'), {
      type: 'line',
      data: { labels: tl.map(function (d) { return (d.date || '').slice(5); }), datasets: [{ label: label, data: rates, borderColor: '#5b9cf6', backgroundColor: 'rgba(91,156,246,.15)', fill: true, tension: .3 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return c.parsed.y + '%'; } } } },
        scales: {
          x: { ticks: { color: '#6b6390', font: { size: 10 } }, grid: { color: 'rgba(124,111,224,.06)' } },
          y: { min: 0, max: 100, ticks: { color: '#6b6390', font: { size: 10 }, callback: function (v) { return v + '%'; } }, grid: { color: 'rgba(124,111,224,.06)' } }
        }
      }
    });
  }

  function renderExpandAvgTicket(body) {
    var tl = data.timeline && data.timeline.timeline;
    if (!tl || !tl.length) { body.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos para este período</div>'; return; }
    var avgs = tl.map(function (d) { return d.count ? Math.round((d.volume / d.count) * 100) / 100 : 0; });
    body.innerHTML = '<div style="height:300px;position:relative"><canvas id="c_expand"></canvas></div>';
    destroyExpandChart();
    chartInstances.expand = new Chart(document.getElementById('c_expand').getContext('2d'), {
      type: 'line',
      data: { labels: tl.map(function (d) { return (d.date || '').slice(5); }), datasets: [{ label: 'Ticket medio', data: avgs, borderColor: '#3ecf8e', backgroundColor: 'rgba(62,207,142,.15)', fill: true, tension: .3 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return fmt(c.parsed.y); } } } },
        scales: {
          x: { ticks: { color: '#6b6390', font: { size: 10 } }, grid: { color: 'rgba(124,111,224,.06)' } },
          y: { ticks: { color: '#6b6390', font: { size: 10 }, callback: function (v) { return fmt(v); } }, grid: { color: 'rgba(124,111,224,.06)' } }
        }
      }
    });
  }

  // KPIs de refund/fallback: la muestra sale de las últimas transacciones ya
  // cargadas en cliente (no es una consulta exhaustiva del período completo,
  // se avisa explícitamente). Para el listado completo → widget "Últimas
  // transacciones" expandido, que sí consulta el servidor con filtros.
  function renderExpandTxSample(body, statuses, fallbackOnly) {
    var pool = data.txList || [];
    var list = pool.filter(function (t) {
      if (fallbackOnly) return !!t.fallbackUsed;
      return statuses && statuses.indexOf(t.status) >= 0;
    });
    var note = '<div style="font-size:11px;color:var(--text3);margin-bottom:10px">Muestra de las últimas ' + pool.length + ' transacciones cargadas — no es el listado completo del período. Usa el widget "Últimas transacciones" ampliado para buscar en todo el histórico.</div>';
    if (!list.length) { body.innerHTML = note + '<div style="color:var(--text3);font-size:12px">Ninguna en la muestra actual</div>'; return; }
    var table = document.createElement('table'); table.className = 'tx-table';
    table.innerHTML = '<thead><tr><th>Payment ID</th><th>Referencia</th><th>Importe</th><th>Estado</th><th>Conector</th><th>Fecha</th></tr></thead>';
    var tbody = document.createElement('tbody');
    list.forEach(function (t) {
      var tr = document.createElement('tr'); tr.style.cursor = 'pointer';
      tr.innerHTML = '<td style="font-family:monospace;font-size:11px">' + (t.paymentId || '–').slice(0, 14) + '…</td>' +
        '<td>' + (t.merchantReference || '–') + '</td>' + '<td>' + fmt(t.amount) + '</td>' + '<td>' + statusBadge(t.status) + '</td>' +
        '<td>' + (t.processor || '–') + '</td>' + '<td>' + (t.createdAt || '').slice(0, 10) + '</td>';
      tr.addEventListener('click', (function (tx) { return function (e) { if (e && e.stopPropagation) e.stopPropagation(); closeExpandAndShowTx(tx); }; })(t));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.innerHTML = note; body.appendChild(table);
  }

  function renderExpandTimeline(body) {
    var tl = data.timeline && data.timeline.timeline;
    if (!tl || !tl.length) { body.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos</div>'; return; }
    var html = '<div style="height:320px;position:relative;margin-bottom:16px"><canvas id="c_expand"></canvas></div>';
    html += '<table class="tx-table"><thead><tr><th>Fecha</th><th>Total</th><th>Aprobadas</th><th>Rechazadas</th><th>Volumen</th></tr></thead><tbody>';
    tl.slice().reverse().forEach(function (d) {
      html += '<tr><td>' + d.date + '</td><td>' + d.count + '</td><td>' + d.approved + '</td><td>' + d.declined + '</td><td>' + fmt(d.volume) + '</td></tr>';
    });
    html += '</tbody></table>';
    body.innerHTML = html;
    destroyExpandChart();
    chartInstances.expand = new Chart(document.getElementById('c_expand').getContext('2d'), {
      type: 'bar',
      data: {
        labels: tl.map(function (d) { return (d.date || '').slice(5); }),
        datasets: [
          { label: 'Total', data: tl.map(function (d) { return d.count; }), backgroundColor: 'rgba(124,111,224,.6)', borderRadius: 3 },
          { label: 'Aprobadas', data: tl.map(function (d) { return d.approved; }), backgroundColor: 'rgba(62,207,142,.5)', borderRadius: 3 },
          { label: 'Rechazadas', data: tl.map(function (d) { return d.declined; }), backgroundColor: 'rgba(240,96,96,.4)', borderRadius: 3 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#a89ec8', font: { size: 10 }, boxWidth: 8 } } },
        scales: { x: { ticks: { color: '#6b6390', font: { size: 10 } }, grid: { color: 'rgba(124,111,224,.06)' } }, y: { ticks: { color: '#6b6390', font: { size: 10 } }, grid: { color: 'rgba(124,111,224,.06)' } } }
      }
    });
  }

  function renderExpandMethods(body) {
    var m = data.methods;
    if (!m || !m.length) { body.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos</div>'; return; }
    var html = '<div style="height:280px;position:relative;margin-bottom:16px"><canvas id="c_expand"></canvas></div>';
    html += '<table class="tx-table"><thead><tr><th>Conector</th><th>Método</th><th>Nº tx</th><th>Volumen</th><th>Tasa aprobación</th></tr></thead><tbody>';
    m.forEach(function (x) {
      html += '<tr><td>' + (x.processor || '–') + '</td><td>' + (x.method || '–') + '</td><td>' + x.count + '</td><td>' + fmt(x.volume) + '</td><td>' + (x.approvalRate || 0) + '%</td></tr>';
    });
    html += '</tbody></table>';
    body.innerHTML = html;
    destroyExpandChart();
    chartInstances.expand = new Chart(document.getElementById('c_expand').getContext('2d'), {
      type: 'doughnut',
      data: { labels: m.map(function (x) { return x.processor || x.method || '–'; }), datasets: [{ data: m.map(function (x) { return x.count; }), backgroundColor: METHOD_COLORS, borderWidth: 0, hoverOffset: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#a89ec8', font: { size: 11 }, boxWidth: 10 } } } }
    });
  }

  function renderExpandCountries(body) {
    var cs = data.countries;
    if (!cs || !cs.length) { body.innerHTML = '<div style="color:var(--text3);font-size:12px">Sin datos de países</div>'; return; }
    var html = '<table class="tx-table"><thead><tr><th>País</th><th>Nº tx</th><th>Volumen</th></tr></thead><tbody>';
    cs.forEach(function (c) {
      html += '<tr><td>' + (FLAGS[c.country] || '🌍') + ' ' + c.country + '</td><td>' + c.count + '</td><td>' + fmt(c.volume) + '</td></tr>';
    });
    html += '</tbody></table>';
    body.innerHTML = html;
  }

  /* ── LISTA COMPLETA DE TRANSACCIONES (paginada + filtrable) ──
     Consulta directamente al servidor (GET /backoffice/transactions),
     no depende de lo ya cargado en cliente — así cubre todo el histórico,
     no solo el top 10 del widget colapsado. */
  var expandTxState = { page: 1, limit: 20, status: '', processor: '', country: '', q: '' };

  function closeExpandAndShowTx(tx) {
    document.getElementById('expandModal').classList.remove('open');
    destroyExpandChart();
    showTxDetail(tx);
  }

  function renderExpandTxList(body) {
    expandTxState = { page: 1, limit: 20, status: '', processor: '', country: '', q: '' };
    body.innerHTML =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
      '<select id="etxStatus" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px">' +
      '<option value="">Todos los estados</option>' +
      '<option value="authorized">authorized</option><option value="approved">approved</option>' +
      '<option value="declined">declined</option><option value="captured">captured</option>' +
      '<option value="partially_captured">partially_captured</option>' +
      '<option value="refunded">refunded</option><option value="partially_refunded">partially_refunded</option>' +
      '<option value="canceled">canceled</option><option value="pending">pending</option><option value="pending_3ds">pending_3ds</option>' +
      '</select>' +
      '<input type="text" id="etxProcessor" placeholder="Conector" style="width:120px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px"/>' +
      '<input type="text" id="etxCountry" placeholder="País emisor" style="width:120px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px"/>' +
      '<input type="text" id="etxSearch" placeholder="Buscar paymentId / referencia" style="flex:1;min-width:180px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px"/>' +
      '<button class="btn btn-primary" id="etxApply">Filtrar</button>' +
      '</div>' +
      '<div id="etxTableWrap"><div class="spinner"></div></div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px">' +
      '<button class="btn btn-ghost" id="etxPrev">← Anterior</button>' +
      '<span id="etxPageInfo" style="font-size:12px;color:var(--text3)"></span>' +
      '<button class="btn btn-ghost" id="etxNext">Siguiente →</button>' +
      '</div>';

    document.getElementById('etxApply').addEventListener('click', function () {
      expandTxState.status    = document.getElementById('etxStatus').value;
      expandTxState.processor = document.getElementById('etxProcessor').value.trim();
      expandTxState.country   = document.getElementById('etxCountry').value.trim();
      expandTxState.q         = document.getElementById('etxSearch').value.trim();
      expandTxState.page      = 1;
      loadExpandTxList();
    });
    document.getElementById('etxPrev').addEventListener('click', function () {
      if (expandTxState.page > 1) { expandTxState.page -= 1; loadExpandTxList(); }
    });
    document.getElementById('etxNext').addEventListener('click', function () {
      expandTxState.page += 1; loadExpandTxList();
    });

    loadExpandTxList();
  }

  function loadExpandTxList() {
    var wrap = document.getElementById('etxTableWrap');
    if (!wrap) return; // el modal pudo cerrarse mientras cargaba
    wrap.innerHTML = '<div class="spinner"></div>';
    var qs = '?page=' + expandTxState.page + '&limit=' + expandTxState.limit;
    if (expandTxState.status)    qs += '&status=' + encodeURIComponent(expandTxState.status);
    if (expandTxState.processor) qs += '&processor=' + encodeURIComponent(expandTxState.processor);
    if (expandTxState.country)   qs += '&country=' + encodeURIComponent(expandTxState.country);
    if (expandTxState.q)         qs += '&q=' + encodeURIComponent(expandTxState.q);

    api('/backoffice/transactions' + qs).then(function (r) {
      var wrapNow = document.getElementById('etxTableWrap');
      if (!wrapNow) return;
      renderExpandTxTable(r.transactions || []);
      var p = r.pagination || {};
      var pageInfo = document.getElementById('etxPageInfo');
      if (pageInfo) pageInfo.textContent = 'Página ' + (p.page || 1) + ' de ' + (p.pages || 1) + ' · ' + (p.total || 0) + ' transacciones';
      var prevBtn = document.getElementById('etxPrev'); if (prevBtn) prevBtn.disabled = (p.page || 1) <= 1;
      var nextBtn = document.getElementById('etxNext'); if (nextBtn) nextBtn.disabled = (p.page || 1) >= (p.pages || 1);
    }).catch(function (e) {
      var wrapNow = document.getElementById('etxTableWrap');
      if (wrapNow) wrapNow.innerHTML = '<div style="color:var(--red);font-size:12px">' + e.message + '</div>';
    });
  }

  function renderExpandTxTable(txs) {
    var wrap = document.getElementById('etxTableWrap');
    if (!wrap) return;
    if (!txs.length) { wrap.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px 0">Sin resultados</div>'; return; }
    var table = document.createElement('table'); table.className = 'tx-table';
    table.innerHTML = '<thead><tr><th>Payment ID</th><th>Referencia</th><th>Importe</th><th>Estado</th><th>Conector</th><th>País</th><th>Fecha</th></tr></thead>';
    var tbody = document.createElement('tbody');
    txs.forEach(function (t) {
      var tr = document.createElement('tr'); tr.style.cursor = 'pointer';
      tr.innerHTML =
        '<td style="font-family:monospace;font-size:11px">' + (t.paymentId || '–').slice(0, 14) + '…</td>' +
        '<td>' + (t.merchantReference || '–') + '</td>' +
        '<td>' + fmt(t.amount) + '</td>' +
        '<td>' + statusBadge(t.status) + '</td>' +
        '<td>' + (t.processor || '–') + '</td>' +
        '<td>' + (t.issuerCountry || '–') + '</td>' +
        '<td>' + (t.createdAt || '').slice(0, 10) + '</td>';
      tr.addEventListener('click', (function (tx) { return function (e) { if (e && e.stopPropagation) e.stopPropagation(); closeExpandAndShowTx(tx); }; })(t));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.innerHTML = ''; wrap.appendChild(table);
  }

  /* ── TX DETAIL ── */
  function showTxDetail(t) {
    currentTx = t;
    var detail=document.getElementById('txDetail');
    detail.innerHTML='<div class="spinner"></div>';
    document.getElementById('txModal').classList.add('open');
    api('/backoffice/transactions/'+t.paymentId)
      .then(function(r){ renderTxDetail(r.transaction||t, r.operations||[], r.refundableAmount); })
      .catch(function(){ renderTxDetail(t,[],(t.amount||0)); });
  }

  function renderTxDetail(tx, ops, refundableAmount) {
    currentTx = tx;
    var fields=[
      ['Payment ID',tx.paymentId],['Merchant Ref',tx.merchantReference],
      ['Importe',fmt(tx.amount)],['Moneda',tx.currency],
      ['Estado',tx.status],['Conector',tx.processor],
      ['Método',tx.method],['BIN',tx.bin],
      ['Marca',tx.cardBrand],['Tipo',tx.cardType],
      ['País emisor',tx.issuerCountry],['Fallback',tx.fallbackUsed?'Sí':'No'],
      ['Auth Code',tx.authCode],['Creado',(tx.createdAt||'').slice(0,19).replace('T',' ')],
    ];
    var html='<div style="margin-bottom:12px">'+statusBadge(tx.status)+'</div>';
    html+='<div class="detail-grid">';
    fields.forEach(function(f){html+='<div class="detail-item"><label>'+f[0]+'</label><span>'+(f[1]||'–')+'</span></div>';});
    html+='</div>';
    if(ops.length){
      html+='<div style="margin-top:16px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Operaciones</div>';
      ops.forEach(function(o){html+='<div style="font-size:12px;color:var(--text2);padding:4px 0;border-bottom:1px solid var(--border)">'+o.type+' · '+o.status+' · '+fmt(o.amount||0)+' · '+(o.createdAt||'').slice(0,10)+'</div>';});
    }
    document.getElementById('txDetail').innerHTML=html;

    // Botones de acción
    var actionsEl = document.getElementById('txActions');
    actionsEl.innerHTML = '';
    var canCancel = ['initialized','hosted_pending','processing','authorized','approved','pending'].indexOf(tx.status)>=0;
    var canRefund = ['approved','authorized','partially_refunded'].indexOf(tx.status)>=0 && (refundableAmount||0)>0;
    var role = session && session.user && session.user.role;
    var canAct = role==='superadmin'||role==='admin'||role==='operator';

    if(canAct && canRefund){
      var refBtn=document.createElement('button'); refBtn.className='btn btn-warning'; refBtn.textContent='Reembolsar';
      refBtn.style.cssText='background:#2a1f0a;border:1px solid #6b4a0a;color:var(--amber);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;margin-right:8px';
      refBtn.addEventListener('click',function(){openRefundModal(tx,refundableAmount);});
      actionsEl.appendChild(refBtn);
    }
    if(canAct && canCancel){
      var canBtn=document.createElement('button'); canBtn.className='btn btn-danger'; canBtn.textContent='Cancelar';
      canBtn.style.cssText='background:#3d1818;border:1px solid #6b2020;color:var(--red);padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500';
      canBtn.addEventListener('click',function(){cancelTx(tx.paymentId);});
      actionsEl.appendChild(canBtn);
    }
  }

  /* ── REFUND MODAL ──
     maxRefundable llega del servidor en CÉNTIMOS. El input se maneja en EUROS
     de cara al usuario; la conversión a céntimos se hace al enviar (doRefund). */
  function openRefundModal(tx, maxRefundable) {
    document.getElementById('txModal').classList.remove('open');
    var maxEur = Math.round((Number(maxRefundable)||0)) / 100; // céntimos → euros
    document.getElementById('refundPaymentId').textContent = tx.paymentId;
    document.getElementById('refundMax').textContent = fmt(maxRefundable); // fmt espera céntimos
    document.getElementById('refundAmount').value = maxEur;
    document.getElementById('refundAmount').max = maxEur;
    document.getElementById('refundAmount').step = '0.01';
    document.getElementById('refundReason').value = '';
    document.getElementById('refundErr').textContent = '';
    document.getElementById('refundBtn').disabled = false;
    document.getElementById('refundBtn').textContent = 'Confirmar reembolso';
    document.getElementById('refundModal').classList.add('open');
    // Actualizar preview al cambiar importe (input en euros → fmt espera céntimos)
    document.getElementById('refundAmount').oninput = function(){
      var vEur=parseFloat(this.value)||0;
      document.getElementById('refundPreview').textContent = fmt(vEur*100);
      var pctV = maxEur>0?Math.round(vEur/maxEur*1000)/10:0;
      document.getElementById('refundPct').textContent = pctV+'%';
    };
    document.getElementById('refundPreview').textContent = fmt(maxRefundable);
    document.getElementById('refundPct').textContent = '100%';
  }

  function doRefund() {
    var paymentId = document.getElementById('refundPaymentId').textContent;
    var amountEur = parseFloat(document.getElementById('refundAmount').value); // euros
    var reason = document.getElementById('refundReason').value.trim() || 'backoffice_refund';
    var maxEur = parseFloat(document.getElementById('refundAmount').max);       // euros
    var errEl = document.getElementById('refundErr');
    var btn = document.getElementById('refundBtn');

    errEl.textContent = '';
    if(isNaN(amountEur)||amountEur<=0){errEl.textContent='Importe inválido';return;}
    if(amountEur>maxEur){errEl.textContent='Supera el importe reembolsable ('+fmt(maxEur*100)+')';return;}
    if(!confirm('¿Confirmar reembolso de '+fmt(amountEur*100)+'?')) return;

    var amountCents = Math.round(amountEur*100); // euros → céntimos para el servidor
    btn.disabled=true; btn.textContent='Procesando…';
    api('/backoffice/transactions/'+paymentId+'/refund',{
      method:'POST', body:JSON.stringify({amount:amountCents,reason:reason})
    }).then(function(r){
      document.getElementById('refundModal').classList.remove('open');
      alert('✅ Reembolso procesado: '+fmt(r.refundAmount)+'\nNuevo estado: '+r.newStatus);
      loadAll();
    }).catch(function(e){
      errEl.textContent='Error: '+e.message;
      btn.disabled=false; btn.textContent='Confirmar reembolso';
    });
  }

  function cancelTx(paymentId) {
    if(!confirm('¿Cancelar esta transacción?')) return;
    api('/backoffice/transactions/'+paymentId+'/cancel',{method:'POST',body:JSON.stringify({reason:'backoffice_manual_cancel'})})
      .then(function(){ document.getElementById('txModal').classList.remove('open'); loadAll(); })
      .catch(function(e){alert('Error: '+e.message);});
  }

  /* ── USERS PANEL ── */
  function loadUsers() {
    api('/backoffice/users').then(function(r){
      renderUsersTable(r.users||[]);
    }).catch(function(e){
      document.getElementById('usersTableBody').innerHTML='<tr><td colspan="6" style="color:var(--red);padding:12px">'+e.message+'</td></tr>';
    });
  }

  function renderUsersTable(users) {
    var tbody = document.getElementById('usersTableBody');
    if(!users.length){tbody.innerHTML='<tr><td colspan="6" style="color:var(--text3);padding:12px">No hay usuarios</td></tr>';return;}
    tbody.innerHTML=users.map(function(u){
      return '<tr>'+
        '<td>'+u.name+'</td>'+
        '<td>'+u.email+'</td>'+
        '<td><span class="badge badge-role-'+u.role+'">'+u.role+'</span></td>'+
        '<td style="font-size:11px">'+(u.merchantScope||[]).join(', ')+'</td>'+
        '<td>'+statusBadge(u.active?'approved':'cancelled')+'</td>'+
        '<td style="display:flex;gap:6px">'+
          '<button class="btn-sm" data-id="'+u._id+'" data-action="edit">Editar</button>'+
          (u.email!==session.user.email?'<button class="btn-sm btn-sm-danger" data-id="'+u._id+'" data-action="deactivate">'+(u.active?'Desactivar':'Activado')+'</button>':'')+
        '</td></tr>';
    }).join('');

    tbody.querySelectorAll('button[data-action]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var id=this.dataset.id; var action=this.dataset.action;
        var u=users.filter(function(x){return x._id===id;})[0];
        if(action==='edit') openEditUser(u);
        if(action==='deactivate') deactivateUser(id, u.email);
      });
    });
  }

  function openEditUser(u) {
    document.getElementById('editUserId').value = u._id;
    document.getElementById('editUserName').value = u.name;
    document.getElementById('editUserRole').value = u.role;
    document.getElementById('editUserScope').value = (u.merchantScope||[]).join(', ');
    document.getElementById('editUserErr').textContent = '';
    document.getElementById('editUserModal').classList.add('open');
  }

  function saveEditUser() {
    var id    = document.getElementById('editUserId').value;
    var name  = document.getElementById('editUserName').value.trim();
    var role  = document.getElementById('editUserRole').value;
    var scope = document.getElementById('editUserScope').value.split(',').map(function(s){return s.trim();}).filter(Boolean);
    var errEl = document.getElementById('editUserErr');
    if(!name){errEl.textContent='Nombre requerido';return;}
    api('/backoffice/users/'+id,{method:'PATCH',body:JSON.stringify({name:name,role:role,merchantScope:scope})})
      .then(function(){
        document.getElementById('editUserModal').classList.remove('open');
        loadUsers();
      }).catch(function(e){errEl.textContent='Error: '+e.message;});
  }

  function deactivateUser(id, email) {
    if(!confirm('¿Desactivar usuario '+email+'?')) return;
    api('/backoffice/users/'+id,{method:'DELETE'})
      .then(function(){loadUsers();})
      .catch(function(e){alert('Error: '+e.message);});
  }

  function openCreateUser() {
    document.getElementById('newUserName').value='';
    document.getElementById('newUserEmail').value='';
    document.getElementById('newUserPassword').value='';
    document.getElementById('newUserRole').value='viewer';
    document.getElementById('newUserScope').value='all';
    document.getElementById('newUserErr').textContent='';
    document.getElementById('createUserModal').classList.add('open');
  }

  function saveNewUser() {
    var name  = document.getElementById('newUserName').value.trim();
    var email = document.getElementById('newUserEmail').value.trim();
    var pass  = document.getElementById('newUserPassword').value;
    var role  = document.getElementById('newUserRole').value;
    var scope = document.getElementById('newUserScope').value.split(',').map(function(s){return s.trim();}).filter(Boolean);
    var errEl = document.getElementById('newUserErr');
    if(!name||!email||!pass){errEl.textContent='Todos los campos son requeridos';return;}
    if(pass.length<8){errEl.textContent='Contraseña mínimo 8 caracteres';return;}
    api('/backoffice/users',{method:'POST',body:JSON.stringify({name:name,email:email,password:pass,role:role,merchantScope:scope})})
      .then(function(){
        document.getElementById('createUserModal').classList.remove('open');
        loadUsers();
      }).catch(function(e){errEl.textContent='Error: '+e.message;});
  }

  /* ── MERCHANTS PANEL ── */
  var currentApiKeysMerchant = null;

  function loadMerchants() {
    document.getElementById('merchantsTableBody').innerHTML = '<tr><td colspan="6" style="color:var(--text3);padding:12px">Cargando…</td></tr>';
    api('/backoffice/merchants').then(function(r){
      renderMerchantsTable(r.merchants||[]);
    }).catch(function(e){
      document.getElementById('merchantsTableBody').innerHTML='<tr><td colspan="6" style="color:var(--red);padding:12px">'+e.message+'</td></tr>';
    });
  }

  function renderMerchantsTable(merchants) {
    var tbody = document.getElementById('merchantsTableBody');
    if(!merchants.length){tbody.innerHTML='<tr><td colspan="6" style="color:var(--text3);padding:12px">No hay merchants</td></tr>';return;}
    tbody.innerHTML = merchants.map(function(m){
      var statusKey = m.status==='active' ? 'approved' : (m.status==='suspended' ? 'cancelled' : 'pending');
      return '<tr>'+
        '<td style="font-family:monospace">'+m.merchantId+'</td>'+
        '<td>'+(m.name||'–')+'</td>'+
        '<td>'+(m.country||'–')+'</td>'+
        '<td>'+(m.plan||'–')+'</td>'+
        '<td>'+statusBadge(statusKey)+'</td>'+
        '<td style="display:flex;gap:6px">'+
          '<button class="btn-sm" data-id="'+m.merchantId+'" data-action="edit">Editar</button>'+
          '<button class="btn-sm" data-id="'+m.merchantId+'" data-action="keys">API Keys</button>'+
        '</td></tr>';
    }).join('');

    tbody.querySelectorAll('button[data-action]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = this.dataset.id; var action = this.dataset.action;
        var m = merchants.filter(function(x){return x.merchantId===id;})[0];
        if(action==='edit') openEditMerchant(m);
        if(action==='keys') openApiKeysModal(id);
      });
    });
  }

  function openCreateMerchant() {
    document.getElementById('merchantModalTitle').textContent = 'Nuevo merchant';
    document.getElementById('merchantEditId').value = '';
    document.getElementById('merchantIdInput').value = '';
    document.getElementById('merchantIdInput').disabled = false;
    document.getElementById('merchantName').value = '';
    document.getElementById('merchantCountry').value = '';
    document.getElementById('merchantPlan').value = 'starter';
    document.getElementById('merchantStatus').value = 'active';
    document.getElementById('merchantWebhookUrl').value = '';
    document.getElementById('merchantErr').textContent = '';
    document.getElementById('merchantModal').classList.add('open');
  }

  function openEditMerchant(m) {
    if(!m) return;
    document.getElementById('merchantModalTitle').textContent = 'Editar merchant';
    document.getElementById('merchantEditId').value = m.merchantId;
    document.getElementById('merchantIdInput').value = m.merchantId;
    document.getElementById('merchantIdInput').disabled = true;
    document.getElementById('merchantName').value = m.name||'';
    document.getElementById('merchantCountry').value = m.country||'';
    document.getElementById('merchantPlan').value = m.plan||'starter';
    document.getElementById('merchantStatus').value = m.status||'active';
    document.getElementById('merchantWebhookUrl').value = m.webhookUrl||'';
    document.getElementById('merchantErr').textContent = '';
    document.getElementById('merchantModal').classList.add('open');
  }

  function saveMerchant() {
    var editId = document.getElementById('merchantEditId').value;
    var errEl  = document.getElementById('merchantErr');
    var btn    = document.getElementById('saveMerchantBtn');
    var body = {
      name:       document.getElementById('merchantName').value.trim(),
      country:    document.getElementById('merchantCountry').value.trim(),
      plan:       document.getElementById('merchantPlan').value,
      status:     document.getElementById('merchantStatus').value,
      webhookUrl: document.getElementById('merchantWebhookUrl').value.trim()
    };
    errEl.textContent = '';
    btn.disabled = true;

    var req;
    if (editId) {
      req = api('/backoffice/merchants/'+editId, { method:'PATCH', body: JSON.stringify(body) });
    } else {
      var merchantId = document.getElementById('merchantIdInput').value.trim();
      if (!merchantId) { errEl.textContent = 'Merchant ID requerido'; btn.disabled = false; return; }
      body.merchantId = merchantId;
      req = api('/backoffice/merchants', { method:'POST', body: JSON.stringify(body) });
    }

    req.then(function(){
      btn.disabled = false;
      document.getElementById('merchantModal').classList.remove('open');
      loadMerchants();
    }).catch(function(e){
      btn.disabled = false;
      errEl.textContent = 'Error: '+e.message;
    });
  }

  /* ── API KEYS PANEL ── */
  function openApiKeysModal(merchantId) {
    currentApiKeysMerchant = merchantId;
    document.getElementById('apiKeysMerchantId').textContent = merchantId;
    document.getElementById('newKeyReveal').style.display = 'none';
    document.getElementById('newKeyLabel').value = '';
    document.getElementById('apiKeysModal').classList.add('open');
    loadApiKeys(merchantId);
  }

  function loadApiKeys(merchantId) {
    document.getElementById('apiKeysTableBody').innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:12px">Cargando…</td></tr>';
    api('/backoffice/merchants/'+merchantId+'/api-keys').then(function(r){
      renderApiKeysTable(r.keys||[]);
    }).catch(function(e){
      document.getElementById('apiKeysTableBody').innerHTML='<tr><td colspan="5" style="color:var(--red);padding:12px">'+e.message+'</td></tr>';
    });
  }

  function renderApiKeysTable(keys) {
    var tbody = document.getElementById('apiKeysTableBody');
    if(!keys.length){tbody.innerHTML='<tr><td colspan="5" style="color:var(--text3);padding:12px">No hay keys todavía</td></tr>';return;}
    tbody.innerHTML = keys.map(function(k){
      var lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('es-ES') : 'nunca';
      var revokeBtn = k.active
        ? '<button class="btn-sm btn-sm-danger" data-id="'+k._id+'" data-action="revoke">Revocar</button>'
        : '<span style="color:var(--text3);font-size:11px">revocada</span>';
      return '<tr>'+
        '<td style="font-family:monospace">'+(k.keyPrefix||'–')+'…</td>'+
        '<td>'+(k.label||'–')+'</td>'+
        '<td>'+statusBadge(k.active?'approved':'cancelled')+'</td>'+
        '<td style="font-size:11px">'+lastUsed+'</td>'+
        '<td>'+revokeBtn+'</td>'+
        '</tr>';
    }).join('');

    tbody.querySelectorAll('button[data-action="revoke"]').forEach(function(btn){
      btn.addEventListener('click', function(){ revokeKey(this.dataset.id); });
    });
  }

  function createApiKeyForCurrentMerchant() {
    if (!currentApiKeysMerchant) return;
    var label = document.getElementById('newKeyLabel').value.trim();
    var btn = document.getElementById('createKeyBtn');
    btn.disabled = true;
    api('/backoffice/merchants/'+currentApiKeysMerchant+'/api-keys', { method:'POST', body: JSON.stringify({ label: label }) })
      .then(function(r){
        btn.disabled = false;
        document.getElementById('newKeyId').textContent = r.rawKeyId;
        document.getElementById('newKeySecret').textContent = r.rawSecret;
        document.getElementById('newKeyReveal').style.display = 'block';
        document.getElementById('newKeyLabel').value = '';
        loadApiKeys(currentApiKeysMerchant);
      }).catch(function(e){
        btn.disabled = false;
        alert('Error: '+e.message);
      });
  }

  function revokeKey(keyId) {
    if (!confirm('¿Revocar esta API key? No se podrá deshacer y dejará de funcionar de inmediato.')) return;
    api('/backoffice/merchants/'+currentApiKeysMerchant+'/api-keys/'+keyId, { method:'DELETE' })
      .then(function(){ loadApiKeys(currentApiKeysMerchant); })
      .catch(function(e){ alert('Error: '+e.message); });
  }

  /* ── TABS ── */
  function showTab(tab) {
    document.getElementById('tabDashboard').style.display  = tab==='dashboard'?'block':'none';
    document.getElementById('tabUsers').style.display      = tab==='users'?'block':'none';
    document.getElementById('tabMerchants').style.display  = tab==='merchants'?'block':'none';
    if(tab==='users') loadUsers();
    if(tab==='merchants') loadMerchants();
  }

  /* ── SEARCH ── */
  function bindSearch() {
    document.getElementById('txSearch').addEventListener('input', function () {
      var q=this.value.toLowerCase(); var el=document.getElementById('wb_list_tx');
      if(!el) return; var orig=data.txList;
      if(!q){renderWidget('list_tx',el);return;}
      data.txList=(orig||[]).filter(function(t){
        return (t.paymentId||'').toLowerCase().indexOf(q)>=0||(t.merchantReference||'').toLowerCase().indexOf(q)>=0||(t.status||'').indexOf(q)>=0;
      });
      renderWidget('list_tx',el); data.txList=orig;
    });
  }

  /* ── DRAG ── */
  function bindDrag() {
    document.querySelectorAll('.widget').forEach(function(el){
      el.addEventListener('dragstart',function(e){dragSrc=el;el.classList.add('dragging');e.dataTransfer.effectAllowed='move';});
      el.addEventListener('dragend',function(){el.classList.remove('dragging');document.querySelectorAll('.widget').forEach(function(w){w.classList.remove('drag-over');});});
      el.addEventListener('dragover',function(e){e.preventDefault();el.classList.add('drag-over');});
      el.addEventListener('dragleave',function(){el.classList.remove('drag-over');});
      el.addEventListener('drop',function(e){
        e.preventDefault();el.classList.remove('drag-over');
        if(dragSrc&&dragSrc!==el){
          var g=document.getElementById('grid');var els=Array.prototype.slice.call(g.children);
          g.insertBefore(dragSrc,els.indexOf(el)<els.indexOf(dragSrc)?el:el.nextSibling);
          activeWidgets=Array.prototype.slice.call(g.children).map(function(e){return e.dataset.id;}).filter(Boolean);
          localStorage.setItem('m_widgets',JSON.stringify(activeWidgets));
        }
      });
    });
  }

  /* ── SHOW/HIDE PASSWORD ── */
  function bindPasswordToggle(inputId, btnId) {
    var btn = document.getElementById(btnId);
    if(!btn) return;
    btn.addEventListener('click', function(){
      var inp = document.getElementById(inputId);
      var isPass = inp.type === 'password';
      inp.type = isPass ? 'text' : 'password';
      btn.textContent = isPass ? '🙈' : '👁';
    });
  }

  /* ── BIND ALL ── */
  function bindButtons() {
    document.getElementById('loginBtn').addEventListener('click', doLogin);
    document.getElementById('loginPass').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
    document.getElementById('logoutBtn').addEventListener('click', doLogout);
    document.getElementById('refreshBtn').addEventListener('click', loadAll);
    document.getElementById('widgetToggleBtn').addEventListener('click', toggleWidgetEditor);
    document.getElementById('txModalClose').addEventListener('click',function(){document.getElementById('txModal').classList.remove('open');});
    document.getElementById('expandModalClose').addEventListener('click',function(){document.getElementById('expandModal').classList.remove('open');destroyExpandChart();});
    document.getElementById('refundModalClose').addEventListener('click',function(){document.getElementById('refundModal').classList.remove('open');});
    document.getElementById('refundBtn').addEventListener('click', doRefund);
    document.getElementById('editUserModalClose').addEventListener('click',function(){document.getElementById('editUserModal').classList.remove('open');});
    document.getElementById('saveEditUserBtn').addEventListener('click', saveEditUser);
    document.getElementById('createUserModalClose').addEventListener('click',function(){document.getElementById('createUserModal').classList.remove('open');});
    document.getElementById('saveNewUserBtn').addEventListener('click', saveNewUser);
    document.getElementById('createUserBtn').addEventListener('click', openCreateUser);
    document.getElementById('merchantModalClose').addEventListener('click',function(){document.getElementById('merchantModal').classList.remove('open');});
    document.getElementById('saveMerchantBtn').addEventListener('click', saveMerchant);
    document.getElementById('createMerchantBtn').addEventListener('click', openCreateMerchant);
    document.getElementById('apiKeysModalClose').addEventListener('click',function(){document.getElementById('apiKeysModal').classList.remove('open');});
    document.getElementById('createKeyBtn').addEventListener('click', createApiKeyForCurrentMerchant);
    var tabDash = document.getElementById('tabBtnDashboard');
    var tabUsr  = document.getElementById('tabBtnUsers');
    var tabMer  = document.getElementById('tabBtnMerchants');
    if(tabDash) tabDash.addEventListener('click',function(){showTab('dashboard');});
    if(tabUsr)  tabUsr.addEventListener('click',function(){showTab('users');});
    if(tabMer)  tabMer.addEventListener('click',function(){showTab('merchants');});
    bindPasswordToggle('loginPass','toggleLoginPass');
    bindPasswordToggle('newUserPassword','toggleNewUserPass');
  }

  /* ── BOOT ── */
  bindButtons();
  bindSearch();
  session = loadSession();
  if(session) showApp();

})();
