// ============================================================
// LevoPrint · asistente "Buscar impresoras" (F2, PLAN §4.3.2)
// ------------------------------------------------------------
// Busca en orden y junta todo en UNA lista para asignar con un toque:
//   1) USB (y BT/serie) instaladas en Windows: Get-Printer (lib/usbwin).
//   2) Red: barrido del /24 de cada interfaz al puerto 9100 (200 ms por
//      host, 64 a la vez: ~1 s por red) + mDNS.
//   3) Bluetooth: en PC solo las que Windows ya instalo como impresora
//      (puerto BTH/COM); el emparejado BT de verdad vive en el APK.
// Cada hallazgo: { id, via: USB|RED|BT|SERIAL, transporte, destino, nombre,
// detalle, ticketera }. `transporte`/`destino` es lo que se guarda en la
// estacion al asignar.
// ============================================================
'use strict';
const net = require('net');
const usbwin = require('./usbwin');
const mdns = require('./mdns');
const { ipsLocales } = require('./red');

function probarPuerto(ip, puerto, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: ip, port: puerto });
    const fin = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

// Hosts del /24 de cada IP local (aunque la mascara sea mas grande: barrer un
// /16 tardaria minutos; las ticketeras casi siempre estan en el /24 del router).
function hostsDeRed(locales) {
  const out = new Set();
  for (const l of locales) {
    const base = l.ip.split('.').slice(0, 3).join('.');
    for (let i = 1; i < 255; i++) out.add(`${base}.${i}`);
  }
  return [...out];
}

async function barrerLan(opciones = {}) {
  const puerto = opciones.puerto || 9100;
  const timeoutMs = opciones.timeoutMs || 200;
  const conc = opciones.concurrencia || 64;
  const hosts = opciones.hosts || hostsDeRed(ipsLocales());
  const hallados = [];
  let i = 0;
  async function trabajador() {
    while (i < hosts.length) {
      const h = hosts[i++];
      if (await probarPuerto(h, puerto, timeoutMs)) hallados.push(h);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, hosts.length) }, trabajador));
  return hallados.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((ip) => ({ ip, puerto }));
}

async function buscarTodo(opciones = {}) {
  const avisos = [];
  const tareas = [
    opciones.usb === false ? Promise.resolve([]) : usbwin.listar().catch((e) => { avisos.push('Windows: ' + e.message); return []; }),
    opciones.lan === false ? Promise.resolve([]) : barrerLan(opciones).catch((e) => { avisos.push('Red: ' + e.message); return []; }),
    opciones.mdns === false ? Promise.resolve([]) : mdns.buscar(opciones.mdnsMs || 1500).catch(() => []),
  ];
  const [win, lan, anuncios] = await Promise.all(tareas);
  const lista = [];
  const visto = new Set();
  const poner = (h) => { if (!visto.has(h.id)) { visto.add(h.id); lista.push(h); } };

  for (const p of win) {
    if (p.via === 'VIRTUAL' || p.via === 'OTRA') continue;     // PDF, fax, OneNote...
    if (p.via === 'RED' && p.ipRed) continue;                  // la red se ofrece directo por TCP abajo
    poner({
      id: 'win:' + p.nombre, via: p.via === 'SERIAL' ? 'SERIAL' : p.via, transporte: 'USB_WIN', destino: p.nombre,
      nombre: p.nombre, detalle: `${p.puerto} · ${p.driver}`, ticketera: !!p.ticketera, estado: p.estado || null,
    });
  }
  const porIp = new Map(anuncios.map((m) => [m.ip, m]));
  for (const h of lan) {
    const m = porIp.get(h.ip);
    poner({ id: `tcp:${h.ip}:${h.puerto}`, via: 'RED', transporte: 'TCP', destino: `${h.ip}:${h.puerto}`, nombre: m ? m.nombre : 'Impresora de red ' + h.ip, detalle: `${h.ip}:${h.puerto}`, ticketera: true });
  }
  for (const m of anuncios) {
    poner({ id: `tcp:${m.ip}:${m.puerto}`, via: 'RED', transporte: 'TCP', destino: `${m.ip}:${m.puerto}`, nombre: m.nombre, detalle: `${m.ip}:${m.puerto} (mDNS)`, ticketera: m.servicio.startsWith('_pdl') });
  }
  // Ticketeras primero; luego por via y nombre.
  lista.sort((a, b) => (b.ticketera - a.ticketera) || a.via.localeCompare(b.via) || a.nombre.localeCompare(b.nombre));
  return { ok: true, impresoras: lista, avisos, ts: Date.now() };
}

module.exports = { buscarTodo, barrerLan, probarPuerto, hostsDeRed };
