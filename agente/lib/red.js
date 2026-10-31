// ============================================================
// LevoPrint · reglas de red del servidor local (F2)
// ------------------------------------------------------------
// El servidor LAN (:9120) solo debe ser alcanzable desde la red del local.
// Tres filtros, todos aqui para poder probarlos sin sockets:
//   1) IP de origen PRIVADA (RFC 1918, loopback, link-local, IPv6 ULA).
//      100.64/10 (CGNAT) NO cuenta: es la red del operador movil, no el local.
//   2) Host PERMITIDO: IP literal, "localhost" o *.local. Corta el DNS
//      rebinding (un dominio de internet que resuelve a la IP del agente).
//   3) Origin PERMITIDO para CORS: https://levodev.app y sus subdominios,
//      mas los que el dueno agregue en LEVO_ORIGENES (desarrollo). Nunca "*".
// ============================================================
'use strict';
const os = require('os');

function limpiarIp(addr) {
  let a = String(addr || '').trim();
  if (a.startsWith('::ffff:')) a = a.slice(7);       // IPv4 mapeada en IPv6
  return a;
}

function esIpv4(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

function esIpPrivada(addr) {
  const a = limpiarIp(addr).toLowerCase();
  if (esIpv4(a)) {
    const [x, y] = a.split('.').map(Number);
    if (x === 10 || x === 127) return true;
    if (x === 172 && y >= 16 && y <= 31) return true;
    if (x === 192 && y === 168) return true;
    if (x === 169 && y === 254) return true;          // link-local (cable directo PC-impresora)
    return false;
  }
  if (a === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;       // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;       // fc00::/7 (ULA)
  return false;
}

// Host de la peticion (cabecera Host) sin puerto.
function hostSinPuerto(host) {
  const h = String(host || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

function hostPermitido(host) {
  const h = hostSinPuerto(host);
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (esIpv4(h)) return true;
  if (h.includes(':')) return true;                    // IPv6 literal
  return false;
}

const ORIGEN_LEVO = /^https:\/\/([a-z0-9-]+\.)*levodev\.app$/;

function origenPermitido(origin, extra) {
  const o = String(origin || '').trim().toLowerCase();
  if (!o) return false;
  if (ORIGEN_LEVO.test(o)) return true;
  return (extra || []).some((e) => String(e).trim().toLowerCase() === o);
}

function leerOrigenesExtra(txt) {
  return String(txt || '').split(/[,\s]+/).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

// IPv4 privadas de este equipo (para publicar en el latido y para el barrido).
function ipsLocales() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const nombre of Object.keys(ifs)) {
    for (const i of ifs[nombre] || []) {
      if (i.internal || (i.family !== 'IPv4' && i.family !== 4)) continue;
      if (!esIpPrivada(i.address) || i.address.startsWith('127.') || i.address.startsWith('169.254.')) continue;
      out.push({ interfaz: nombre, ip: i.address, mascara: i.netmask });
    }
  }
  return out;
}

module.exports = { limpiarIp, esIpv4, esIpPrivada, hostSinPuerto, hostPermitido, origenPermitido, leerOrigenesExtra, ipsLocales };
