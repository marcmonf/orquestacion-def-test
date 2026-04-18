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
    // Mostrar tab de usuarios solo a superadmin
    var usersTab = document.getElementById('usersTab');
    if (usersTab) usersTab.style.display = u.role === 'superadmin' ? 'inline-flex' : 'none';
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
      var rm = document.createElement('button'); rm.className = 'widget-remove'; rm.textContent = '×';
      rm.addEventListener('click', (function (wid) { return function () { removeWidget(wid); }; })(id));
      header.appendChild(title); header.appendChild(rm);
      var body = document.createElement('div'); body.id = 'wb_' + id;
      var sp = document.createElement('div'); sp.className = 'spinner'; body.appendChild(sp);
      div.appendChild(header); div.appendChild(body); grid.appendChild(div);
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

  function fmt(v) { return new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',maximumFractionDigits:2}).format(v||0); }
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
      tr.addEventListener('click',(function(tx){return function(){showTxDetail(tx);};})(t));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); el.innerHTML=''; el.appendChild(table);
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

  /* ── REFUND MODAL ── */
  function openRefundModal(tx, maxRefundable) {
    document.getElementById('txModal').classList.remove('open');
    var max = Math.round((maxRefundable||0)*100)/100;
    document.getElementById('refundPaymentId').textContent = tx.paymentId;
    document.getElementById('refundMax').textContent = fmt(max);
    document.getElementById('refundAmount').value = max;
    document.getElementById('refundAmount').max = max;
    document.getElementById('refundReason').value = '';
    document.getElementById('refundErr').textContent = '';
    document.getElementById('refundBtn').disabled = false;
    document.getElementById('refundBtn').textContent = 'Confirmar reembolso';
    document.getElementById('refundModal').classList.add('open');
    // Actualizar preview al cambiar importe
    document.getElementById('refundAmount').oninput = function(){
      var v=parseFloat(this.value)||0;
      document.getElementById('refundPreview').textContent = fmt(v);
      var pctV = max>0?Math.round(v/max*1000)/10:0;
      document.getElementById('refundPct').textContent = pctV+'%';
    };
    document.getElementById('refundPreview').textContent = fmt(max);
    document.getElementById('refundPct').textContent = '100%';
  }

  function doRefund() {
    var paymentId = document.getElementById('refundPaymentId').textContent;
    var amount = parseFloat(document.getElementById('refundAmount').value);
    var reason = document.getElementById('refundReason').value.trim() || 'backoffice_refund';
    var max = parseFloat(document.getElementById('refundAmount').max);
    var errEl = document.getElementById('refundErr');
    var btn = document.getElementById('refundBtn');

    errEl.textContent = '';
    if(isNaN(amount)||amount<=0){errEl.textContent='Importe inválido';return;}
    if(amount>max){errEl.textContent='Supera el importe reembolsable ('+fmt(max)+')';return;}
    if(!confirm('¿Confirmar reembolso de '+fmt(amount)+'?')) return;

    btn.disabled=true; btn.textContent='Procesando…';
    api('/backoffice/transactions/'+paymentId+'/refund',{
      method:'POST', body:JSON.stringify({amount:amount,reason:reason})
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

  /* ── TABS ── */
  function showTab(tab) {
    document.getElementById('tabDashboard').style.display = tab==='dashboard'?'block':'none';
    document.getElementById('tabUsers').style.display     = tab==='users'?'block':'none';
    if(tab==='users') loadUsers();
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
    document.getElementById('refundModalClose').addEventListener('click',function(){document.getElementById('refundModal').classList.remove('open');});
    document.getElementById('refundBtn').addEventListener('click', doRefund);
    document.getElementById('editUserModalClose').addEventListener('click',function(){document.getElementById('editUserModal').classList.remove('open');});
    document.getElementById('saveEditUserBtn').addEventListener('click', saveEditUser);
    document.getElementById('createUserModalClose').addEventListener('click',function(){document.getElementById('createUserModal').classList.remove('open');});
    document.getElementById('saveNewUserBtn').addEventListener('click', saveNewUser);
    document.getElementById('createUserBtn').addEventListener('click', openCreateUser);
    var tabDash = document.getElementById('tabBtnDashboard');
    var tabUsr  = document.getElementById('tabBtnUsers');
    if(tabDash) tabDash.addEventListener('click',function(){showTab('dashboard');});
    if(tabUsr)  tabUsr.addEventListener('click',function(){showTab('users');});
    bindPasswordToggle('loginPass','toggleLoginPass');
    bindPasswordToggle('newUserPassword','toggleNewUserPass');
  }

  /* ── BOOT ── */
  bindButtons();
  bindSearch();
  session = loadSession();
  if(session) showApp();

})();
