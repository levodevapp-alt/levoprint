// ============================================================
// LevoPrint · servidor de la red del local (:9120) (LP-O02, portado de F2)
// ------------------------------------------------------------
// PORQUE: los trabajos llegan desde la nube; con el internet del local caido
// la impresora a un metro no imprime (D'Amour, 16-oct, 44 comandas vencidas).
// Con este servidor la caja / el mozo mandan el papel directo por la LAN.
// APAGADO por defecto: lo enciende el interruptor «Imprimir sin internet» de
// la ventana local (127.0.0.1:9110).
//
// Contrato (JSON; todo menos /v1/hola y /v1/emparejar exige token):
//   GET  /v1/hola       -> { ok, app:'levoprint', version, equipo (15 car.), emparejable }
//                          (sin nombre del local: no exige token)
//   POST /v1/emparejar  { pin, nombre } -> { ok, token, vence }
//                          | 401 PIN_INVALIDO/PIN_ANULADO/SIN_PIN | 429 ESPERA | 423 PIN_BLOQUEADO
//   POST /v1/imprimir   tipo solo COMANDA | PRECUENTA | TICKET | PRUEBA (nada de CPE ni CIERRE)
//   GET  /v1/estado     -> { ok, version, nube, estaciones:[{id,nombre,transporte,listo,app}] }
//   POST /v1/imprimir   { jobId, estacion, tipo, payload, reimpresion? }
//                       -> { ok, via:'LAN', estado:'IMPRESO'|'YA_IMPRESO' } |
//                          { ok:false, error, estado:'DUDOSO'?, dudoso? }
//   POST /v1/prueba     { estacion } -> { ok }
//   GET  /v1/diario     -> { ok, recientes:[{jobId,estacion,estado,origen,ts}] }
//
// Seguridad:
//   · solo IP de origen privada (10/8, 172.16/12, 192.168/16) o loopback
//     (la misma PC); 100.64/10 (CGNAT, datos moviles), 169.254 y publicas no;
//   · Host = IP literal, localhost o *.local (corta el DNS rebinding);
//   · CORS solo https://levodev.app y https://*.levodev.app (+ LEVO_ORIGENES
//     solo en desarrollo: el .exe lo ignora); nunca "*"; preflight con
//     Access-Control-Allow-Private-Network: true (Chrome PNA/LNA);
//   · token por equipo (lib/emparejar); cuerpo maximo 64 KB; cabeceras 10 s,
//     pedido 30 s; conexiones keep-alive cerradas (Connection: close);
//   · respuestas de error sin detalle crudo de red ni de Windows (va al log).
// RIESGO ACEPTADO: HTTP en claro dentro de la red del local (ver
// docs/LP_O02_IMPRESION_LAN.md). No hay certificados ni llaves del cliente
// aqui: el agente solo imprime papel; el CPE se firma en la nube.
// ============================================================
'use strict';
const http = require('http');
const os = require('os');

const MAX_CUERPO = 64 * 1024;
const PUERTO_LAN = 9120, PUERTOS_EXTRA = 4;

function limpiarIp(addr) {
  let a = String(addr || '').trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);       // IPv4 mapeada en IPv6
  return a;
}
function esIpv4(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(a || ''));
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}
// IP privada del LOCAL: 10/8, 172.16/12, 192.168/16. 100.64/10 no (CGNAT).
function esIpLan(a) {
  if (!esIpv4(a)) return false;
  const [x, y] = a.split('.').map(Number);
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}
// Origen aceptado: LAN o la misma PC (127/8, ::1).
function origenIpPermitido(addr) {
  const a = limpiarIp(addr).toLowerCase();
  if (a === '::1') return true;
  if (esIpv4(a) && a.startsWith('127.')) return true;
  return esIpLan(a);
}
function hostSinPuerto(host) {
  const h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}
function hostPermitido(host) {
  const h = hostSinPuerto(host);
  if (!h) return false;
  if (h === 'localhost' || /^[a-z0-9-]{1,63}\.local$/.test(h)) return true;
  return esIpv4(h) || h === '::1';
}
const ORIGEN_LEVO = /^https:\/\/([a-z0-9-]+\.)*levodev\.app$/;
function origenPermitido(origin, extra) {
  const o = String(origin || '').trim().toLowerCase();
  if (!o) return false;
  if (ORIGEN_LEVO.test(o)) return true;
  return (extra || []).some((e) => String(e).trim().toLowerCase().replace(/\/+$/, '') === o);
}
function leerOrigenesExtra(txt) {
  return String(txt || '').split(/[,\s]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
// IPv4 privadas de las interfaces de esta PC (para el latido): maximo 4.
function ipsLan(ifaces) {
  const out = [];
  const ifs = ifaces || os.networkInterfaces();
  for (const nombre of Object.keys(ifs)) {
    for (const i of ifs[nombre] || []) {
      if (i.internal || (i.family !== 'IPv4' && i.family !== 4)) continue;
      if (esIpLan(i.address) && !out.includes(i.address)) out.push(i.address);
    }
  }
  return out.slice(0, 4);
}

// op = { emparejador, version, hola():obj, bloqueado():bool, origenesExtra[],
//        manejadores:{ estado, imprimir, prueba, diario }, log(), error(),
//        ipDe(req) (solo pruebas) }
function crearServidorLan(op) {
  const { emparejador } = op;
  const extra = op.origenesExtra || [];
  const m = op.manejadores || {};
  const log = op.log || (() => {});
  const logErr = op.error || log;
  const ipDe = op.ipDe || ((req) => limpiarIp(req.socket.remoteAddress));

  function cabecerasCors(req) {
    const origin = req.headers.origin;
    if (!origin || !origenPermitido(origin, extra)) return {};
    const h = {
      'Access-Control-Allow-Origin': String(origin),
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    };
    // Chrome Private Network Access: el preflight hacia una IP privada pide este permiso.
    if (req.method === 'OPTIONS') h['Access-Control-Allow-Private-Network'] = 'true';
    return h;
  }
  function responder(req, res, code, obj) {
    if (res.headersSent) return;
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' }, cabecerasCors(req)));
    res.end(JSON.stringify(obj));
  }
  function leerCuerpo(req) {
    return new Promise((resolve, reject) => {
      const largo = parseInt(req.headers['content-length'] || '0', 10) || 0;
      if (largo > MAX_CUERPO) return reject(Object.assign(new Error('cuerpo muy grande'), { status: 413 }));
      let n = 0, listo = false; const trozos = [];
      req.on('data', (c) => {
        if (listo) return;
        n += c.length;
        if (n > MAX_CUERPO) { listo = true; reject(Object.assign(new Error('cuerpo muy grande'), { status: 413 })); return; }
        trozos.push(c);
      });
      req.on('end', () => {
        if (listo) return;
        listo = true;
        const txt = Buffer.concat(trozos).toString('utf8');
        if (!txt) return resolve({});
        try {
          const j = JSON.parse(txt);
          if (!j || typeof j !== 'object' || Array.isArray(j)) return reject(Object.assign(new Error('JSON invalido'), { status: 400 }));
          resolve(j);
        } catch { reject(Object.assign(new Error('JSON invalido'), { status: 400 })); }
      });
      req.on('error', (e) => { if (!listo) { listo = true; reject(e); } });
    });
  }
  function tokenDe(req) {
    const a = String(req.headers.authorization || '');
    return /^Bearer /i.test(a) ? a.slice(7).trim() : '';
  }
  function esJson(req) { return /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || '')); }

  const servidor = http.createServer(async (req, res) => {
    const ip = ipDe(req);
    // 1) solo la red del local (o esta misma PC)
    if (!origenIpPermitido(ip)) { res.writeHead(403, { Connection: 'close' }); return res.end(); }
    // 2) anti DNS rebinding
    if (!hostPermitido(req.headers.host)) return responder(req, res, 421, { ok: false, error: 'HOST_NO_PERMITIDO' });
    // 3) una pagina de otro sitio no entra (el navegador manda Origin)
    const origin = req.headers.origin;
    if (origin !== undefined && !origenPermitido(origin, extra)) return responder(req, res, 403, { ok: false, error: 'ORIGEN_NO_PERMITIDO' });

    const url = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({ Connection: 'close' }, cabecerasCors(req)));
      return res.end();
    }
    try {
      if (req.method === 'GET' && url === '/v1/hola') {
        // [QA BAJO-2] Sin token: nada del negocio (ni el nombre del local). Solo lo que
        // necesita la app para saber que aqui hay un LevoPrint y si acepta emparejar.
        const h = op.hola ? op.hola() || {} : {};
        return responder(req, res, 200, {
          ok: true, app: 'levoprint', version: op.version,
          equipo: String(h.equipo || 'PC').slice(0, 15), emparejable: !!h.emparejable,
        });
      }
      if (op.bloqueado && op.bloqueado()) {
        return responder(req, res, 423, { ok: false, error: 'AGENTE_DESACTIVADO', mensaje: 'Este LevoPrint está desactivado en la consola de la app.' });
      }
      if (req.method === 'POST' && !esJson(req)) return responder(req, res, 415, { ok: false, error: 'TIPO_CONTENIDO' });
      if (req.method === 'POST' && url === '/v1/emparejar') {
        const b = await leerCuerpo(req);
        const r = emparejador.intentar(b.pin, b.nombre, ip);
        if (r.ok) log('[lan] equipo emparejado: ' + r.equipo.nombre + ' (' + ip + ')');
        else log('[lan] PIN rechazado desde ' + ip + ': ' + r.error);
        if (op.alEmparejar) op.alEmparejar(r);
        return responder(req, res, r.ok ? 200 : (r.error === 'ESPERA' ? 429 : r.error === 'PIN_BLOQUEADO' ? 423 : 401), r);
      }

      const equipo = emparejador.validar(tokenDe(req));
      if (!equipo) return responder(req, res, 401, { ok: false, error: 'NO_EMPAREJADO', mensaje: 'Este equipo no está emparejado con LevoPrint (o su permiso venció).' });
      const ctx = { equipo, ip };

      if (req.method === 'GET' && url === '/v1/estado') return responder(req, res, 200, await m.estado(ctx));
      if (req.method === 'GET' && url === '/v1/diario') return responder(req, res, 200, await m.diario(ctx));
      if (req.method === 'POST' && url === '/v1/prueba') {
        const r = await m.prueba(await leerCuerpo(req), ctx);
        return responder(req, res, r.status || (r.ok ? 200 : 502), Object.assign({}, r, { status: undefined }));
      }
      if (req.method === 'POST' && url === '/v1/imprimir') {
        const r = await m.imprimir(await leerCuerpo(req), ctx);
        return responder(req, res, r.status || (r.ok ? 200 : 502), Object.assign({}, r, { status: undefined }));
      }
      return responder(req, res, 404, { ok: false, error: 'NO_ENCONTRADO' });
    } catch (e) {
      const st = e && e.status;
      if (!st) logErr('[lan] ' + (e && e.stack || e));
      return responder(req, res, st || 500, { ok: false, error: st === 413 ? 'MUY_GRANDE' : st === 400 ? 'JSON_INVALIDO' : 'ERROR' });
    }
  });
  servidor.headersTimeout = 10000;
  servidor.requestTimeout = 30000;
  servidor.keepAliveTimeout = 1;
  return servidor;
}

// Escucha en 0.0.0.0:<base> y, si esta ocupado, en base+1..base+4.
function escuchar(servidor, base, host) {
  return new Promise((resolve, reject) => {
    let intento = 0;
    const probar = () => {
      const puerto = base + intento;
      const alError = (e) => {
        servidor.removeListener('listening', alEscuchar);
        if (e && e.code === 'EADDRINUSE' && intento < PUERTOS_EXTRA) { intento++; probar(); }
        else reject(e);
      };
      const alEscuchar = () => { servidor.removeListener('error', alError); resolve(servidor.address().port); };
      servidor.once('error', alError);
      servidor.once('listening', alEscuchar);
      servidor.listen(puerto, host || '0.0.0.0');
    };
    probar();
  });
}

module.exports = {
  crearServidorLan, escuchar, MAX_CUERPO, PUERTO_LAN,
  limpiarIp, esIpv4, esIpLan, origenIpPermitido, hostSinPuerto, hostPermitido, origenPermitido, leerOrigenesExtra, ipsLan,
};
