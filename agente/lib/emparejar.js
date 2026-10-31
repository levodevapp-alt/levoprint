// ============================================================
// LevoPrint · emparejamiento de equipos de la red (F2)
// ------------------------------------------------------------
// El servidor LAN solo atiende a equipos EMPAREJADOS (PLAN §3.10):
//   1) La ventana de LevoPrint (solo en esta PC, 127.0.0.1) muestra un PIN
//      de 6 digitos que vence a los 10 min y sirve UNA vez.
//   2) La caja/el mozo escribe el PIN en la app (Estaciones > Imprimir sin
//      internet) y recibe un token propio, que guarda en su navegador.
//   3) Cada pedido trae "Authorization: Bearer <token>".
// El archivo guarda solo el sha256 del token (si alguien copia el archivo
// no obtiene tokens validos). Quitar un equipo en la ventana lo deja fuera.
//
// [QA F2 MEDIO-6] El token VENCE a los 90 dias sin uso: cada uso lo renueva
// (un equipo que imprime todos los dias no se entera; uno perdido o robado
// deja de servir solo). Un vencido se borra de la lista.
// [QA F2 BAJO] Al cargar se descartan entradas con un hash que no sea sha256.
//
// Freno contra adivinar el PIN (1 en un millon por intento) [QA F2 BAJO]:
//   · 5 fallos desde una IP -> esa IP espera 60 s;
//   · tope GLOBAL de 30 fallos por minuto (de todas las IP juntas): pasado el
//     tope se responde "espera" sin anular el PIN. Antes 20 fallos anulaban el
//     PIN y cualquiera de la red podia impedir emparejar (negacion de servicio).
//     Con el tope, en los 10 min de vida del PIN caben ~300 intentos: 0,03 %.
//   · el mapa de IPs tiene tope (1000): no crece sin limite.
// Por que PIN local y no un secreto de la nube: funciona sin internet (que
// es justo cuando importa) y no deja un secreto de la empresa en la BD.
// ============================================================
'use strict';
const fs = require('fs');
const crypto = require('crypto');

const PIN_MS = 10 * 60000;
const FALLOS_IP = 5, ESPERA_IP_MS = 60000;
const FALLOS_MINUTO = 30;
const MAX_IPS = 1000;
const VIDA_TOKEN_MS = 90 * 86400000;

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class Emparejador {
  constructor(archivo) {
    this.archivo = archivo;
    this.equipos = [];
    this.pin = null;               // { valor, expira }
    this.porIp = new Map();        // ip -> { fallos, hasta }
    this.fallosGlobal = [];        // ts de fallos del ultimo minuto
    try {
      const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      if (Array.isArray(j.equipos)) {
        this.equipos = j.equipos
          .filter((e) => e && e.id && typeof e.hash === 'string' && /^[0-9a-f]{64}$/.test(e.hash))
          .map((e) => ({ ...e, vence: e.vence || (e.visto || e.creado || Date.now()) + VIDA_TOKEN_MS }));
      }
    } catch { /* primera vez */ }
    this.purgarVencidos();
  }

  guardar() {
    try {
      const tmp = this.archivo + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ equipos: this.equipos }, null, 1));
      fs.renameSync(tmp, this.archivo);
    } catch { /* solo lectura: queda en memoria */ }
  }

  purgarVencidos() {
    const antes = this.equipos.length;
    this.equipos = this.equipos.filter((e) => e.vence > Date.now());
    if (this.equipos.length !== antes) this.guardar();
  }

  nuevoPin() {
    const valor = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.pin = { valor, expira: Date.now() + PIN_MS };
    return this.pin;
  }

  pinVigente() {
    if (!this.pin || this.pin.expira < Date.now()) return null;
    return this.pin;
  }

  intentar(pin, nombre, ip) {
    const ahora = Date.now();
    this.fallosGlobal = this.fallosGlobal.filter((t) => t > ahora - 60000);
    if (this.fallosGlobal.length >= FALLOS_MINUTO) return { ok: false, error: 'ESPERA', mensaje: 'Demasiados intentos en la red. Espera un minuto.', esperaS: 60 };
    const reg = this.porIp.get(ip) || { fallos: 0, hasta: 0 };
    if (reg.hasta > ahora) return { ok: false, error: 'ESPERA', mensaje: 'Demasiados intentos. Espera un minuto.', esperaS: Math.ceil((reg.hasta - ahora) / 1000) };
    const vigente = this.pinVigente();
    if (!vigente) return { ok: false, error: 'SIN_PIN', mensaje: 'Abre la ventana de LevoPrint en la PC y genera un PIN nuevo.' };
    const dado = String(pin || '').replace(/\D/g, '');
    const okPin = dado.length === 6 && crypto.timingSafeEqual(Buffer.from(dado), Buffer.from(vigente.valor));
    if (!okPin) {
      reg.fallos += 1;
      if (reg.fallos >= FALLOS_IP) { reg.hasta = ahora + ESPERA_IP_MS; reg.fallos = 0; }
      if (!this.porIp.has(ip) && this.porIp.size >= MAX_IPS) {
        // Tope del mapa: se olvidan las IP sin bloqueo vigente (y si todas
        // lo tienen, la mas vieja).
        for (const [k, v] of this.porIp) if (v.hasta <= ahora) this.porIp.delete(k);
        if (this.porIp.size >= MAX_IPS) this.porIp.delete(this.porIp.keys().next().value);
      }
      this.porIp.set(ip, reg);
      this.fallosGlobal.push(ahora);
      return { ok: false, error: 'PIN_INVALIDO', mensaje: 'PIN incorrecto o vencido. Revisa el que muestra LevoPrint.' };
    }
    this.porIp.delete(ip);
    this.pin = null;                                  // un solo uso
    const token = crypto.randomBytes(24).toString('base64url');
    const equipo = {
      id: crypto.randomBytes(6).toString('hex'),
      nombre: String(nombre || 'Equipo').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Equipo',
      hash: sha(token), creado: ahora, visto: ahora, vence: ahora + VIDA_TOKEN_MS, ip,
    };
    this.equipos.push(equipo);
    this.guardar();
    return { ok: true, token, equipo: { id: equipo.id, nombre: equipo.nombre }, venceDias: 90 };
  }

  validar(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const h = Buffer.from(sha(token));
    const ahora = Date.now();
    for (const e of this.equipos) {
      if (crypto.timingSafeEqual(h, Buffer.from(e.hash))) {
        if (!(e.vence > ahora)) { this.purgarVencidos(); return null; }
        // Uso = renovacion (se guarda como mucho una vez por minuto).
        if (ahora - (e.visto || 0) > 60000) { e.visto = ahora; e.vence = ahora + VIDA_TOKEN_MS; this.guardar(); }
        return e;
      }
    }
    return null;
  }

  quitar(id) {
    const antes = this.equipos.length;
    this.equipos = this.equipos.filter((e) => e.id !== id);
    if (this.equipos.length !== antes) this.guardar();
    return this.equipos.length !== antes;
  }

  lista() {
    return this.equipos.map((e) => ({ id: e.id, nombre: e.nombre, creado: e.creado, visto: e.visto, vence: e.vence, ip: e.ip }));
  }
}

module.exports = { Emparejador, sha, VIDA_TOKEN_MS };
