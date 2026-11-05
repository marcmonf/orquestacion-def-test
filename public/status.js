// public/status.js — página pública de estado (sin JavaScript en línea: CSP).
(function () {
  'use strict';
  var LABEL = { operational: 'Operativo', degraded: 'Degradado', delayed: 'Con retraso', recovering: 'Recuperándose', major_outage: 'Caído', unknown: 'Desconocido' };
  var BANNER = { operational: 'Todos los sistemas operativos', degraded: 'Algunos sistemas con incidencias', major_outage: 'Incidencia grave', unknown: 'Estado desconocido' };
  function row(name, state) {
    var r = document.createElement('div'); r.className = 'row';
    var n = document.createElement('span'); n.textContent = name;
    var s = document.createElement('span'); s.className = 'state ' + state; s.textContent = LABEL[state] || state;
    r.appendChild(n); r.appendChild(s); return r;
  }
  function render(d) {
    document.getElementById('env').textContent = 'Entorno: ' + (d.environment === 'production' ? 'Producción' : 'Pruebas (sandbox)');
    var b = document.getElementById('banner'); b.className = 'banner ' + d.status; b.textContent = BANNER[d.status] || d.status;
    var c = document.getElementById('components'); c.textContent = '';
    c.appendChild(row('API y checkout', d.components.api.state));
    c.appendChild(row('Base de datos', d.components.database.state));
    c.appendChild(row('Notificaciones a comercios (webhooks)', d.components.webhooks.state));
    (d.components.acquirers || []).forEach(function (a) { c.appendChild(row('Adquirente: ' + a.name, a.state)); });
    document.getElementById('foot').textContent = 'Última comprobación: ' + new Date(d.checkedAt).toLocaleString('es-ES') + ' · se actualiza cada 60 s';
  }
  function load() {
    fetch('/status.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(render).catch(function () {
      var b = document.getElementById('banner'); b.className = 'banner unknown'; b.textContent = 'No se pudo obtener el estado';
    });
  }
  load(); setInterval(load, 60000);
})();
