// ============================================================
// LevoPrint · mock de PostgREST para probar el agente sin Supabase · LevoDev
// ------------------------------------------------------------
//   node agente/mock_rpc.cjs [puerto]      (servidor suelto, para probar a mano)
//   const { crearMock } = require('./mock_rpc.cjs')   (lo usa prueba_integracion.cjs)
// Imita lo que el agente llama: POST /rest/v1/rpc/<prefijo>_<fn> con {p}, y
// /functions/v1/<prefijo>-print (responde 404: el agente cae al render local).
// RPC: agente_config, print_tomar, print_marcar, estacion_codigo_canjear y las
// de [LP-F3] (contrato docs/LEVOPRINT.md §8): agente_impresoras y
// agente_estacion_elegir. Un prefijo con «ausente: true» responde a estas dos
// como un backend viejo: 404 PGRST202 («Could not find the function»).
// Errores como el real: token desconocido → 400 {message:'AGENTE_INVALIDO'}.
// ============================================================
'use strict';
const http = require('http');

function nuevoEstado(apps) {
  const est = {};
  for (const [pfx, a] of Object.entries(apps || {})) {
    est[pfx] = {
      ausente: !!a.ausente,
      devices: new Set(a.devices || []),
      estaciones: (a.estaciones || []).map((e) => ({ id: e.id, nombre: e.nombre })),
      // destino por estación: { transporte, ip, puerto, btMac, usbId, impresoraNombre, equipo }
      destinos: new Map(Object.entries(a.destinos || {})),
      vistas: new Map(),       // device -> encontradas[]
      jobs: [],                // cola de trabajos { id, estacion, tipo, payload }
      marcados: [],            // { id, ok, error, device }
      buscar: false,
      estacionVinculo: a.estacionVinculo || null,
      elegidos: [],            // cuerpos recibidos en agente_estacion_elegir
    };
  }
  return est;
}

function crearMock(opts) {
  const estado = nuevoEstado((opts && opts.apps) || {});
  const llamadas = []; // { fn, prefijo, p, ts }
  const ausente = (fn) => ({ code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.' + fn + '(p) in the schema cache' });

  function destinoPublico(a, e, device) {
    const d = a.destinos.get(e.id) || { transporte: 'red' };
    const t = d.transporte || 'red';
    return {
      estacion: e.id, nombre: e.nombre, transporte: t,
      ip: t === 'red' ? d.ip || null : null, puerto: t === 'red' ? d.puerto || 9100 : null,
      btMac: t === 'bluetooth' ? d.btMac || null : null, usbId: t === 'usb' ? d.usbId || null : null,
      impresoraNombre: d.impresoraNombre || null,
      propio: t === 'red' ? true : d.equipo === device,
    };
  }

  function atender(pfx, fn, p) {
    const a = estado[pfx];
    if (!a) return [404, ausente(pfx + '_' + fn)];
    if (fn === 'estacion_codigo_canjear') return [200, { ok: false, error: 'CODIGO_INVALIDO' }];
    if (!p || !a.devices.has(p.device)) return [400, { code: 'P0001', message: 'AGENTE_INVALIDO' }];
    if (fn === 'agente_config') {
      return [200, { ok: true, estaciones: a.estaciones.map((e) => { const d = destinoPublico(a, e, p.device); return { id: e.id, nombre: e.nombre, ip: d.ip, puerto: d.puerto || 9100 }; }) }];
    }
    if (fn === 'print_tomar') { const jobs = a.jobs.splice(0, p.limite || 10); return [200, { ok: true, jobs }]; }
    if (fn === 'print_marcar') { a.marcados.push({ id: p.id, ok: p.ok, error: p.error || null, device: p.device }); return [200, { ok: true }]; }
    if (fn === 'agente_impresoras') {
      if (a.ausente) return [404, ausente(pfx + '_' + fn)];
      if (Array.isArray(p.encontradas)) a.vistas.set(p.device, p.encontradas.slice(0, 64));
      if (p.buscado) a.buscar = false;
      return [200, { ok: true, buscar: a.buscar, estacionVinculo: a.estacionVinculo, destinos: a.estaciones.map((e) => destinoPublico(a, e, p.device)) }];
    }
    if (fn === 'agente_estacion_elegir') {
      if (a.ausente) return [404, ausente(pfx + '_' + fn)];
      a.elegidos.push(p);
      const e = a.estaciones.find((x) => x.id === p.estacion);
      if (!e) return [200, { ok: false, error: 'ESTACION_NO_EXISTE' }];
      let d;
      if (p.transporte === 'red') {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(p.ip || ''))) return [200, { ok: false, error: 'PARAMETRO_INVALIDO' }];
        d = { transporte: 'red', ip: p.ip, puerto: p.puerto || 9100 };
      } else if (p.transporte === 'usb' || p.transporte === 'bluetooth') {
        const ref = p.transporte === 'usb' ? p.usbId : p.btMac;
        const visto = (a.vistas.get(p.device) || []).some((x) => x.transporte === p.transporte && x.ref === ref);
        if (!visto) return [200, { ok: false, error: 'DESTINO_NO_VISTO' }];
        d = { transporte: p.transporte, usbId: p.usbId || null, btMac: p.btMac || null, impresoraNombre: p.nombre || null, equipo: p.device };
      } else return [200, { ok: false, error: 'PARAMETRO_INVALIDO' }];
      a.destinos.set(e.id, d);
      return [200, { ok: true, destino: destinoPublico(a, e, p.device) }];
    }
    return [404, ausente(pfx + '_' + fn)];
  }

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const url = (req.url || '').split('?')[0];
      let code = 404, body = { message: 'no encontrado' };
      const m = url.match(/^\/rest\/v1\/rpc\/([a-z0-9]+)_([a-z_]+)$/);
      if (req.method === 'POST' && m) {
        let p = null;
        try { p = (JSON.parse(data || '{}') || {}).p || null; } catch { p = null; }
        llamadas.push({ fn: m[2], prefijo: m[1], p, ts: Date.now() });
        [code, body] = atender(m[1], m[2], p);
      }
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen((opts && opts.puerto) || 0, '127.0.0.1', () => {
      const puerto = server.address().port;
      resolve({ server, puerto, url: 'http://127.0.0.1:' + puerto, estado, llamadas, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { crearMock };

if (require.main === module) {
  const puerto = parseInt(process.argv[2] || '54321', 10);
  crearMock({
    puerto,
    apps: { komo: { devices: ['00000000-0000-4000-8000-000000000001'], estaciones: [{ id: 'e1', nombre: 'Cocina' }, { id: 'e2', nombre: 'Caja' }], estacionVinculo: 'e1' } },
  }).then((m) => console.log('mock PostgREST en ' + m.url + ' (device 00000000-0000-4000-8000-000000000001)'));
}
