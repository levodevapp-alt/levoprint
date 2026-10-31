// ============================================================
// LevoPrint · mDNS minimo para descubrir impresoras de red (F2)
// ------------------------------------------------------------
// Muchas ticketeras de red (y casi todas las impresoras de oficina) se
// anuncian por mDNS: _pdl-datastream._tcp (puerto RAW 9100) y _printer._tcp.
// Una consulta PTR al grupo 224.0.0.251:5353 y se juntan las respuestas
// (SRV = puerto, A = IP) durante ~1,5 s. Sin dependencias: el parser de DNS
// de abajo cubre lo justo (nombres comprimidos, PTR/SRV/A/TXT).
// Si el sistema no deja abrir el 5353 (otro servicio lo tiene en exclusiva)
// devuelve [] y el barrido del puerto 9100 sigue cubriendo la red.
// ============================================================
'use strict';
const dgram = require('dgram');

const SERVICIOS = ['_pdl-datastream._tcp.local', '_printer._tcp.local'];
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33 };

function nombreABytes(nombre) {
  const partes = String(nombre).split('.').filter(Boolean);
  const bufs = partes.map((p) => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function armarConsulta(servicios) {
  const cab = Buffer.alloc(12);
  cab.writeUInt16BE(servicios.length, 4);            // QDCOUNT
  const qs = servicios.map((s) => {
    const q = Buffer.alloc(4);
    q.writeUInt16BE(T.PTR, 0);
    q.writeUInt16BE(0x8001, 2);                       // clase IN + bit "respuesta unicast"
    return Buffer.concat([nombreABytes(s), q]);
  });
  return Buffer.concat([cab, ...qs]);
}

function leerNombre(buf, off) {
  const partes = [];
  let saltos = 0, fin = -1;
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) { off += 1; break; }
    if ((len & 0xc0) === 0xc0) {                      // puntero de compresion
      if (++saltos > 20) throw new Error('mdns: bucle de punteros');
      if (fin < 0) fin = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    partes.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { nombre: partes.join('.'), off: fin >= 0 ? fin : off };
}

function parsear(buf) {
  if (buf.length < 12) return [];
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { off = leerNombre(buf, off).off + 4; }
  const regs = [];
  for (let i = 0; i < an + ns + ar && off < buf.length; i++) {
    const n = leerNombre(buf, off); off = n.off;
    const tipo = buf.readUInt16BE(off); const rdlen = buf.readUInt16BE(off + 8); off += 10;
    const ini = off; off += rdlen;
    const r = { nombre: n.nombre, tipo };
    if (tipo === T.PTR) r.valor = leerNombre(buf, ini).nombre;
    else if (tipo === T.A && rdlen === 4) r.valor = [...buf.slice(ini, ini + 4)].join('.');
    else if (tipo === T.SRV) r.valor = { puerto: buf.readUInt16BE(ini + 4), host: leerNombre(buf, ini + 6).nombre };
    else continue;
    regs.push(r);
  }
  return regs;
}

// Junta registros de varias respuestas en impresoras {nombre, ip, puerto, servicio}.
function resolver(registros) {
  const srv = new Map(), a = new Map(), inst = [];
  for (const r of registros) {
    if (r.tipo === T.PTR && SERVICIOS.includes(r.nombre.toLowerCase())) inst.push({ inst: r.valor, servicio: r.nombre });
    if (r.tipo === T.SRV) srv.set(r.nombre.toLowerCase(), r.valor);
    if (r.tipo === T.A) a.set(r.nombre.toLowerCase(), r.valor);
  }
  const out = [], visto = new Set();
  for (const { inst: i, servicio } of inst) {
    const s = srv.get(String(i).toLowerCase());
    const ip = s ? a.get(String(s.host).toLowerCase()) : null;
    if (!ip) continue;
    const puerto = servicio.startsWith('_pdl-datastream') ? s.puerto : 9100;
    const k = ip + ':' + puerto;
    if (visto.has(k)) continue;
    visto.add(k);
    out.push({ nombre: String(i).split('.')[0], ip, puerto, servicio });
  }
  return out;
}

function buscar(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const regs = [];
    let sock;
    const terminar = () => { try { sock.close(); } catch { /* ya cerrado */ } resolve(resolver(regs)); };
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => terminar());
      sock.on('message', (msg) => { try { regs.push(...parsear(msg)); } catch { /* paquete raro */ } });
      sock.bind(0, () => {
        try { sock.send(armarConsulta(SERVICIOS), 5353, '224.0.0.251'); } catch { /* sin multicast */ }
        setTimeout(terminar, timeoutMs);
      });
    } catch { resolve([]); }
  });
}

module.exports = { buscar, parsear, resolver, armarConsulta, nombreABytes, T, SERVICIOS };
