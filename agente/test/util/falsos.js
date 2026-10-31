// ============================================================
// LevoPrint · dobles de prueba: impresora TCP falsa y nube falsa (F2)
// ------------------------------------------------------------
// impresoraFalsa(): servidor TCP que guarda los bytes de cada conexion
//   (= un papel). Sirve de "ticketera :9100" sin hardware.
// nubeFalsa(): imita PostgREST + la Edge <p>-print del proyecto:
//   /rest/v1/rpc/<p>_agente_config | _print_tomar | _print_marcar |
//   _agente_lan | _agente_asignar ; /functions/v1/<p>-print (500: render local).
//   nube.caida = true -> corta toda conexion (internet del local caido).
// ============================================================
'use strict';
const net = require('net');
const http = require('http');

function impresoraFalsa() {
  const papeles = [];
  const server = net.createServer((sock) => {
    const trozos = [];
    sock.on('data', (c) => trozos.push(c));
    sock.on('end', () => { papeles.push(Buffer.concat(trozos)); sock.end(); });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    puerto: server.address().port, papeles,
    textos: () => papeles.map((p) => p.toString('latin1')),
    cerrar: () => new Promise((r) => server.close(() => r())),
  })));
}

function nubeFalsa({ prefijo = 'komo', estaciones = [] } = {}) {
  const estado = {
    caida: false, estaciones, cola: [], sigId: 1, marcados: [], latidosLan: [], asignados: [], llamadas: [],
    transportes: [],      // [{id, transporte, destino}] que devuelve _agente_lan
  };
  const conexiones = new Set();
  const server = http.createServer((req, res) => {
    if (estado.caida) { req.socket.destroy(); return; }
    // estado.invalido: la consola desactivo el agente (PostgREST 400 AGENTE_INVALIDO).
    if (estado.invalido && req.url.startsWith('/rest/v1/rpc/')) { req.resume(); res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'AGENTE_INVALIDO' })); }
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let p = {};
      try { p = (JSON.parse(cuerpo || '{}').p) || {}; } catch { /* nada */ }
      estado.llamadas.push(url);
      if (url === `/functions/v1/${prefijo}-print`) return json(500, { ok: false });
      const m = /^\/rest\/v1\/rpc\/(.+)$/.exec(url);
      if (!m) return json(404, {});
      const fn = m[1];
      if (fn === `${prefijo}_agente_config`) return json(200, { ok: true, estaciones: estado.estaciones });
      if (fn === `${prefijo}_print_tomar`) {
        const libres = estado.cola.filter((j) => j.estado === 'PENDIENTE' && !j.tomado);
        libres.forEach((j) => { j.tomado = true; });
        return json(200, { ok: true, jobs: libres.map((j) => ({ id: j.id, tipo: j.tipo, estacion: j.estacion, payload: j.payload })) });
      }
      if (fn === `${prefijo}_print_marcar`) {
        estado.marcados.push(p);
        const j = estado.cola.find((x) => x.id === p.id);
        if (j) { j.estado = p.ok ? 'IMPRESO' : 'ERROR'; j.error = p.error || null; }
        return json(200, { ok: true });
      }
      if (fn === `${prefijo}_agente_lan`) {
        estado.latidosLan.push(p);
        return json(200, { ok: true, estaciones: estado.transportes, registrados: (p.impresos || []).map((x) => x.clave) });
      }
      if (fn === `${prefijo}_agente_asignar`) { estado.asignados.push(p); return json(200, { ok: true }); }
      return json(404, { code: 'PGRST202', message: 'Could not find the function' });
    });
  });
  server.on('connection', (s) => { conexiones.add(s); s.on('close', () => conexiones.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, estado,
    encolar(tipo, estacion, payload) { const j = { id: estado.sigId++, tipo, estacion, payload, estado: 'PENDIENTE' }; estado.cola.push(j); return j; },
    cerrar: () => new Promise((r) => { for (const s of conexiones) s.destroy(); server.close(() => r()); }),
  })));
}

// Puerto libre (el SO elige; se libera enseguida).
function puertoLibre() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// Pedido HTTP simple con cabeceras a gusto (fetch no deja tocar Host).
function pedir(puerto, metodo, ruta, { cuerpo, cabeceras } = {}) {
  return new Promise((resolve, reject) => {
    const datos = cuerpo === undefined ? null : Buffer.from(JSON.stringify(cuerpo));
    const req = http.request({ host: '127.0.0.1', port: puerto, method: metodo, path: ruta, headers: {
      ...(datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {}), ...(cabeceras || {}) } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* vacio */ } resolve({ status: res.statusCode, json: j, headers: res.headers }); });
    });
    req.on('error', reject);
    if (datos) req.write(datos);
    req.end();
  });
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 10000, paso = 100) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (await cond()) return true; await esperar(paso); }
  return false;
}

module.exports = { impresoraFalsa, nubeFalsa, puertoLibre, pedir, esperar, hasta };
