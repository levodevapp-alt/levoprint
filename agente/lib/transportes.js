// ============================================================
// LevoPrint · transportes de salida (F2)
// ------------------------------------------------------------
// Un destino = { transporte, destino }:
//   TCP      "ip:puerto" (puerto 9100 por defecto). Igual que siempre.
//   USB_WIN  nombre de la impresora de Windows (spooler RAW, lib/usbwin).
//   USB_ANDROID / BT / BLE  solo existen en el APK: aqui fallan claro.
// Estacion vieja (sin transporte): TCP con su ip/puerto de siempre.
// ============================================================
'use strict';
const net = require('net');
const usbwin = require('./usbwin');

const TRANSPORTES = ['TCP', 'USB_WIN', 'USB_ANDROID', 'BT', 'BLE'];

// TCP con tope total (antes solo habia timeout de inactividad de 5 s y una
// impresora que aceptaba la conexion pero no leia colgaba el ciclo entero).
function tcp(ip, puerto, datos, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let listo = false;
    const sock = net.createConnection({ host: ip, port: puerto || 9100, timeout: 5000 });
    const fin = (err) => {
      if (listo) return;
      listo = true;
      clearTimeout(tope);
      if (err) { sock.destroy(); reject(err); } else resolve();
    };
    const tope = setTimeout(() => fin(new Error(`timeout ${ip}:${puerto}`)), timeoutMs);
    sock.on('connect', () => sock.end(Buffer.isBuffer(datos) ? datos : Buffer.from(datos, 'binary'), () => fin()));
    sock.on('timeout', () => fin(new Error(`timeout ${ip}:${puerto}`)));
    sock.on('error', (e) => fin(e));
  });
}

function partirIpPuerto(destino, puertoDef = 9100) {
  const s = String(destino || '').trim();
  const m = /^\[?([0-9a-fA-F:.]+?)\]?(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  return { ip: m[1], puerto: m[2] ? Number(m[2]) : puertoDef };
}

// Ruta efectiva de una estacion: asignacion local > transporte de la nube > ip vieja.
function rutaDeEstacion(est, asignacionLocal) {
  if (asignacionLocal && asignacionLocal.transporte) return { transporte: asignacionLocal.transporte, destino: asignacionLocal.destino, fuente: 'local' };
  if (est && est.transporte && est.destino) return { transporte: est.transporte, destino: est.destino, fuente: 'nube' };
  if (est && est.ip) return { transporte: 'TCP', destino: `${est.ip}:${est.puerto || 9100}`, fuente: 'ip' };
  return null;
}

function describir(ruta) {
  if (!ruta) return 'sin impresora';
  if (ruta.transporte === 'USB_WIN') return 'USB ' + ruta.destino;
  return ruta.transporte + ' ' + ruta.destino;
}

async function enviar(ruta, datos, opciones = {}) {
  if (!ruta || !ruta.transporte) throw new Error('estacion sin impresora asignada');
  if (ruta.transporte === 'TCP') {
    const d = partirIpPuerto(ruta.destino);
    if (!d) throw new Error('destino TCP invalido: ' + ruta.destino);
    return tcp(d.ip, d.puerto, datos, opciones.timeoutMs);
  }
  if (ruta.transporte === 'USB_WIN') return usbwin.imprimir(ruta.destino, datos, { timeoutMs: opciones.timeoutMs, archivoSalida: opciones.archivoSalida });
  throw new Error(`el transporte ${ruta.transporte} solo funciona en el APK de Android`);
}

module.exports = { TRANSPORTES, tcp, partirIpPuerto, rutaDeEstacion, describir, enviar };
