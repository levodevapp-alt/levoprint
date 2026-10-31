// ============================================================
// LevoPrint · transportes de salida (F2)
// ------------------------------------------------------------
// Un destino = { transporte, destino }:
//   TCP      "ip:puerto" (puerto 9100 por defecto). Igual que siempre.
//   USB_WIN  nombre de la impresora de Windows (spooler RAW, lib/usbwin).
//   USB_ANDROID / BT / BLE  solo existen en el APK: aqui fallan claro.
// Estacion vieja (sin transporte): TCP con su ip/puerto de siempre.
//
// [QA F2 MEDIO-4] UN SOLO punto de validacion del destino (validarDestino),
// usado al asignar Y al enviar: el agente no debe servir de puente para
// tocar cualquier puerto de cualquier equipo. TCP solo a:
//   · IPv4 privada de la red del local (10/8, 172.16/12, 192.168/16),
//     SIN loopback (127/8) ni link-local (169.254/16);
//   · puertos de impresion RAW 9100-9109 (servidores de impresion de
//     varios puertos usan 9101, 9102...).
// La misma regla vive en SQL (_il_destino_error) y en el APK (Motor.validar).
// LEVO_TCP_PRUEBAS=1 (solo pruebas automaticas) permite 127.0.0.1 y
// cualquier puerto: las impresoras falsas escuchan en puertos al azar.
//
// [QA F2 MEDIO-1] Todo error lleva `sinEnviar`: true si es SEGURO que la
// impresora no recibio nada (conexion rechazada, destino invalido, no se
// pudo abrir la impresora de Windows). Si no, el motor marca el papel
// DUDOSO y el reintento sale con sello REIMPRESION.
// ============================================================
'use strict';
const net = require('net');
const usbwin = require('./usbwin');

const TRANSPORTES = ['TCP', 'USB_WIN', 'USB_ANDROID', 'BT', 'BLE'];
const modoPruebas = () => process.env.LEVO_TCP_PRUEBAS === '1';

function errorSinEnviar(mensaje, codigo) {
  const e = new Error(mensaje);
  e.sinEnviar = true;
  if (codigo) e.codigo = codigo;
  return e;
}

// TCP con tope total (antes solo habia timeout de inactividad de 5 s y una
// impresora que aceptaba la conexion pero no leia colgaba el ciclo entero).
function tcp(ip, puerto, datos, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let listo = false;
    let conectado = false;
    const sock = net.createConnection({ host: ip, port: puerto || 9100, timeout: 5000 });
    const fin = (err) => {
      if (listo) return;
      listo = true;
      clearTimeout(tope);
      if (err) {
        sock.destroy();
        // Antes de conectar no salio ningun byte: reintentar es seguro.
        if (!conectado) err.sinEnviar = true;
        reject(err);
      } else resolve();
    };
    const tope = setTimeout(() => fin(new Error(`timeout ${ip}:${puerto}`)), timeoutMs);
    sock.on('connect', () => { conectado = true; sock.end(Buffer.isBuffer(datos) ? datos : Buffer.from(datos, 'binary'), () => fin()); });
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

// IPv4 de la red del local donde puede haber una impresora (sin 127/8 ni 169.254/16).
function ipImpresoraValida(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255)) return false;
  if (modoPruebas() && a === 127) return true;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function puertoImpresoraValido(p) {
  if (modoPruebas()) return p >= 1 && p <= 65535;
  return p >= 9100 && p <= 9109;
}

// Devuelve el texto del problema o null si el destino se acepta.
function validarDestino(transporte, destino) {
  if (!TRANSPORTES.includes(transporte)) return 'transporte invalido';
  const d = String(destino || '');
  if (!d || d.length > 120 || /[\x00-\x1f]/.test(d)) return 'destino invalido';
  if (transporte === 'TCP') {
    const p = partirIpPuerto(d);
    if (!p || !ipImpresoraValida(p.ip)) return 'la impresora de red debe tener una IP del local (192.168.x.x, 10.x.x.x o 172.16-31.x.x)';
    if (!puertoImpresoraValido(p.puerto)) return 'el puerto de la impresora de red debe ser 9100 (o 9101 a 9109)';
    return null;
  }
  if (transporte === 'USB_WIN') return null;
  return 'ese transporte solo funciona en el APK de Android';
}

// Ruta efectiva de una estacion: asignacion local > transporte de la nube > ip vieja.
function rutaDeEstacion(est, asignacionLocal) {
  if (asignacionLocal && asignacionLocal.transporte) return { transporte: asignacionLocal.transporte, destino: asignacionLocal.destino, fuente: 'local', pendienteNube: !!asignacionLocal.pendienteNube };
  if (est && est.transporte && est.destino) return { transporte: est.transporte, destino: est.destino, fuente: 'nube' };
  if (est && est.ip) return { transporte: 'TCP', destino: `${est.ip}:${est.puerto || 9100}`, fuente: 'nube' };
  return null;
}

function describir(ruta) {
  if (!ruta) return 'sin impresora';
  if (ruta.transporte === 'USB_WIN') return 'USB ' + ruta.destino;
  return ruta.transporte + ' ' + ruta.destino;
}

// Mensaje para quien pidio el papel (app o ventana): nunca el error crudo de
// la red o de Windows (eso queda en el log de la PC).
function mensajePublico(e) {
  if (e && e.codigo === 'DESTINO_NO_PERMITIDO') return e.message;
  if (e && e.sinEnviar) return 'No se pudo conectar con la impresora: revisa que este encendida, con papel y en la red (o el cable USB).';
  return 'La impresora no confirmo el papel. Revisa si salio antes de reintentar.';
}

async function enviar(ruta, datos, opciones = {}) {
  if (!ruta || !ruta.transporte) throw errorSinEnviar('estacion sin impresora asignada');
  const problema = validarDestino(ruta.transporte, ruta.destino);
  if (problema) throw errorSinEnviar(problema, 'DESTINO_NO_PERMITIDO');
  if (ruta.transporte === 'TCP') {
    const d = partirIpPuerto(ruta.destino);
    return tcp(d.ip, d.puerto, datos, opciones.timeoutMs);
  }
  return usbwin.imprimir(ruta.destino, datos, { timeoutMs: opciones.timeoutMs, archivoSalida: opciones.archivoSalida });
}

module.exports = { TRANSPORTES, tcp, partirIpPuerto, rutaDeEstacion, describir, enviar, validarDestino, mensajePublico, ipImpresoraValida };
