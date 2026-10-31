// ============================================================
// LevoPrint · servidor LOCAL de la red del negocio (:9120) (F2)
// ------------------------------------------------------------
// PORQUE: hoy los trabajos llegan SOLO desde la nube; con el internet del
// local caido la impresora a un metro no imprime (D'Amour, 16-oct, 44
// comandas vencidas). Este servidor recibe la impresion directo por la LAN.
//
// Contrato (JSON; todo menos /v1/hola y /v1/emparejar exige token):
//   GET  /v1/hola        -> { levoprint, version, prefijo } (deteccion; sin datos)
//   POST /v1/emparejar   { pin, nombre } -> { token }   (PIN de la ventana)
//   GET  /v1/estado      -> estaciones con su ruta, nube, colas, version
//   POST /v1/imprimir    { jobId, tipo, payload, estacion } -> { ok, via, duplicado? }
//   GET  /v1/impresoras  -> asistente "Buscar impresoras" (USB, red, BT)
//   POST /v1/prueba      { transporte, destino } | { estacion } -> papel de prueba
//   POST /v1/refrescar   -> relee estaciones de la nube (tras asignar en la app)
//   GET  /v1/diario      -> ultimos jobId (para impresoLocal al sincronizar)
//
// Seguridad (PLAN §3.10 y §4.2):
//   · solo IP de origen privada; Host IP literal/localhost/.local (anti DNS
//     rebinding); CORS solo para *.levodev.app (+ LEVO_ORIGENES); nunca "*";
//   · preflight con Access-Control-Allow-Private-Network (Chrome LNA/PNA);
//   · token por equipo (lib/emparejar). Aqui NO hay certificados ni llaves
//     del cliente: el agente solo imprime papel; el CPE se firma en la nube.
//   · cuerpo maximo 256 KB.
// ============================================================
'use strict';
const http = require('http');
const red = require('./red');

const MAX_CUERPO = 256 * 1024;

function crearServidorLan(op) {
  const { emparejador, version, log } = op;
  const extra = op.origenesExtra || [];
  const m = op.manejadores || {};

  function cabecerasCors(req) {
    const origin = req.headers.origin;
    if (!origin || !red.origenPermitido(origin, extra)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    };
  }

  function responder(req, res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecerasCors(req) });
    res.end(JSON.stringify(obj));
  }

  function leerCuerpo(req) {
    return new Promise((resolve, reject) => {
      let n = 0; const trozos = [];
      req.on('data', (c) => {
        n += c.length;
        if (n > MAX_CUERPO) { reject(Object.assign(new Error('cuerpo muy grande'), { status: 413 })); req.destroy(); return; }
        trozos.push(c);
      });
      req.on('end', () => {
        const txt = Buffer.concat(trozos).toString('utf8');
        if (!txt) return resolve({});
        try { resolve(JSON.parse(txt)); } catch { reject(Object.assign(new Error('JSON invalido'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function tokenDe(req) {
    const a = String(req.headers.authorization || '');
    return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
  }

  const servidor = http.createServer(async (req, res) => {
    const ip = red.limpiarIp(req.socket.remoteAddress);
    // 1) solo la red del local
    if (!red.esIpPrivada(ip)) { res.writeHead(403); return res.end(); }
    // 2) anti DNS rebinding
    if (!red.hostPermitido(req.headers.host)) return responder(req, res, 421, { ok: false, error: 'HOST_NO_PERMITIDO' });
    // 3) una pagina de otro sitio no entra (el navegador manda Origin)
    const origin = req.headers.origin;
    if (origin && !red.origenPermitido(origin, extra)) return responder(req, res, 403, { ok: false, error: 'ORIGEN_NO_PERMITIDO' });

    const url = (req.url || '/').split('?')[0];
    if (req.method === 'OPTIONS') { res.writeHead(204, cabecerasCors(req)); return res.end(); }

    try {
      if (req.method === 'GET' && url === '/v1/hola') {
        return responder(req, res, 200, { ok: true, levoprint: true, version, prefijo: op.prefijo ? op.prefijo() : null });
      }
      if (req.method === 'POST' && url === '/v1/emparejar') {
        const b = await leerCuerpo(req);
        const r = emparejador.intentar(b.pin, b.nombre, ip);
        if (r.ok) log && log(`[lan] equipo emparejado: ${r.equipo.nombre} (${ip})`);
        return responder(req, res, r.ok ? 200 : (r.error === 'ESPERA' ? 429 : 401), r);
      }

      const equipo = emparejador.validar(tokenDe(req));
      if (!equipo) return responder(req, res, 401, { ok: false, error: 'NO_EMPAREJADO', mensaje: 'Este equipo no esta emparejado con LevoPrint.' });
      const ctx = { equipo, ip };

      if (req.method === 'GET' && url === '/v1/estado') return responder(req, res, 200, await m.estado(ctx));
      if (req.method === 'GET' && url === '/v1/diario') return responder(req, res, 200, await m.diario(ctx));
      if (req.method === 'GET' && url === '/v1/impresoras') return responder(req, res, 200, await m.impresoras(ctx));
      if (req.method === 'POST' && url === '/v1/refrescar') return responder(req, res, 200, await m.refrescar(ctx));
      if (req.method === 'POST' && url === '/v1/prueba') {
        const r = await m.prueba(await leerCuerpo(req), ctx);
        return responder(req, res, r.ok ? 200 : 502, r);
      }
      if (req.method === 'POST' && url === '/v1/imprimir') {
        const r = await m.imprimir(await leerCuerpo(req), ctx);
        return responder(req, res, r.status || (r.ok ? 200 : 502), r);
      }
      return responder(req, res, 404, { ok: false, error: 'NO_ENCONTRADO' });
    } catch (e) {
      return responder(req, res, e.status || 500, { ok: false, error: e.status === 413 ? 'MUY_GRANDE' : e.status === 400 ? 'JSON_INVALIDO' : 'ERROR', mensaje: e.message });
    }
  });
  servidor.headersTimeout = 10000;
  servidor.requestTimeout = 60000;
  return servidor;
}

module.exports = { crearServidorLan };
