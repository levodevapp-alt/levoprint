// ============================================================
// LevoPrint · emparejamiento de equipos de la red (LP-O02, portado de F2)
// ------------------------------------------------------------
// El servidor LAN (:9120) solo atiende a equipos EMPAREJADOS:
//   1) La ventana local de LevoPrint (127.0.0.1:9110, solo en esta PC)
//      muestra un PIN de 6 digitos mientras «Imprimir sin internet» esta
//      encendido. Vence a los 10 min y sirve UNA vez; al usarse o vencer se
//      genera otro (rota solo).
//   2) La caja / el mozo escribe el PIN en la app y recibe un token propio,
//      que guarda en su navegador.
//   3) Cada pedido trae "Authorization: Bearer <token>".
// En disco solo se guarda el sha256 del token (copiar el archivo no da
// tokens validos). Quitar un equipo en la ventana lo deja fuera al toque.
// El token VENCE a los 90 dias sin uso: cada uso lo renueva (un equipo que
// imprime todos los dias no se entera; uno perdido o robado deja de servir).
//
// Freno contra adivinar el PIN (1 en un millon por intento):
//   · 5 fallos desde una IP -> esa IP espera 60 s;
//   · tope GLOBAL de 30 fallos por minuto (todas las IP): se responde
//     "espera" sin anular el PIN (nadie de la red impide emparejar);
//   · 50 fallos ACUMULADOS contra el mismo PIN lo anulan (adivinarlo antes:
//     50 / 1 000 000) y el emparejamiento queda BLOQUEADO 10 min; pasado ese
//     tiempo NO se genera otro solo: hay que pulsar «Otro PIN» en la ventana
//     local (alguien en la PC se entera de que lo estan atacando). El bloqueo
//     vive en memoria: reiniciar LevoPrint exige estar en la PC.
//   · el mapa de IPs tiene tope (1000).
// DoS MENOR ACEPTADO: el tope global (30/min) y el bloqueo por anulacion los
// puede provocar cualquier equipo de la red del local rotando IPs: impide
// EMPAREJAR equipos nuevos un rato, pero no imprimir (los ya emparejados
// siguen con su token). Preferimos eso a dejar adivinar el PIN.
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
const FALLOS_POR_PIN = 50;
const BLOQUEO_PIN_MS = 10 * 60000;
const VIDA_TOKEN_MS = 90 * 86400000;
const MAX_EQUIPOS = 50;

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class Emparejador {
  constructor(archivo, opciones) {
    const o = opciones || {};
    this.archivo = archivo;
    this.ahora = o.ahora || (() => Date.now());
    this.equipos = [];
    this.pin = null;               // { valor, expira, fallos }
    this.bloqueo = null;           // { hasta } tras PIN_ANULADO: sin PIN hasta «Otro PIN» (y no antes de hasta)
    this.porIp = new Map();        // ip -> { fallos, hasta }
    this.fallosGlobal = [];        // ts de fallos del ultimo minuto
    try {
      const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      if (j && Array.isArray(j.equipos)) {
        this.equipos = j.equipos
          .filter((e) => e && typeof e.id === 'string' && typeof e.hash === 'string' && /^[0-9a-f]{64}$/.test(e.hash) && typeof e.vence === 'number')
          .slice(0, MAX_EQUIPOS);
      }
    } catch { /* primera vez o archivo roto: sin equipos */ }
    this.purgarVencidos();
  }

  guardar() {
    try {
      const tmp = this.archivo + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, JSON.stringify({ equipos: this.equipos }, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.archivo);
      return true;
    } catch { return false; /* solo lectura: queda en memoria */ }
  }

  purgarVencidos() {
    const antes = this.equipos.length;
    const ahora = this.ahora();
    this.equipos = this.equipos.filter((e) => e.vence > ahora);
    if (this.equipos.length !== antes) this.guardar();
  }

  nuevoPin() {
    const valor = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.pin = { valor, expira: this.ahora() + PIN_MS, fallos: 0 };
    return this.pin;
  }

  // PIN vigente; con rotar=true genera uno nuevo si no hay (el interruptor esta encendido).
  // Bloqueado tras PIN_ANULADO: nunca se regenera solo (ni al apagar/encender el interruptor).
  pinVigente(rotar) {
    if (this.pin && this.pin.expira > this.ahora()) return this.pin;
    this.pin = null;
    if (this.bloqueo) return null;
    return rotar ? this.nuevoPin() : null;
  }

  anularPin() { this.pin = null; }

  // { bloqueado, hasta, esperaS, requiereOtroPin }: para la ventana local y /v1/hola.
  estadoBloqueo() {
    if (!this.bloqueo) return { bloqueado: false, hasta: null, esperaS: 0, requiereOtroPin: false };
    const falta = this.bloqueo.hasta - this.ahora();
    return { bloqueado: true, hasta: this.bloqueo.hasta, esperaS: falta > 0 ? Math.ceil(falta / 1000) : 0, requiereOtroPin: true };
  }

  // Boton «Otro PIN» de la ventana local (127.0.0.1). Durante el bloqueo de 10 min se niega.
  pedirOtroPin() {
    const b = this.estadoBloqueo();
    if (b.bloqueado && b.esperaS > 0) {
      return { ok: false, error: 'PIN_BLOQUEADO', esperaS: b.esperaS,
        mensaje: 'Hubo demasiados intentos con PIN errado desde la red. Podrás pedir otro PIN en ' + Math.ceil(b.esperaS / 60) + ' min.' };
    }
    this.bloqueo = null;
    return { ok: true, pin: this.nuevoPin() };
  }

  intentar(pin, nombre, ip) {
    const ahora = this.ahora();
    if (this.bloqueo) {
      const b = this.estadoBloqueo();
      return { ok: false, error: 'PIN_BLOQUEADO', esperaS: b.esperaS,
        mensaje: 'Emparejar está bloqueado por demasiados intentos. Pide en la PC de LevoPrint «Otro PIN»' + (b.esperaS > 0 ? ' (en ' + Math.ceil(b.esperaS / 60) + ' min).' : '.') };
    }
    this.fallosGlobal = this.fallosGlobal.filter((t) => t > ahora - 60000);
    if (this.fallosGlobal.length >= FALLOS_MINUTO) return { ok: false, error: 'ESPERA', mensaje: 'Demasiados intentos en la red. Espera un minuto.', esperaS: 60 };
    const reg = this.porIp.get(ip) || { fallos: 0, hasta: 0 };
    if (reg.hasta > ahora) return { ok: false, error: 'ESPERA', mensaje: 'Demasiados intentos. Espera un minuto.', esperaS: Math.ceil((reg.hasta - ahora) / 1000) };
    const vigente = this.pinVigente(false);
    if (!vigente) return { ok: false, error: 'SIN_PIN', mensaje: 'Enciende «Imprimir sin internet» en la ventana de LevoPrint de la PC y usa el PIN que muestra.' };
    const dado = String(pin == null ? '' : pin).replace(/\D/g, '');
    const okPin = dado.length === 6 && crypto.timingSafeEqual(Buffer.from(dado), Buffer.from(vigente.valor));
    if (!okPin) {
      reg.fallos += 1;
      if (reg.fallos >= FALLOS_IP) { reg.hasta = ahora + ESPERA_IP_MS; reg.fallos = 0; }
      if (!this.porIp.has(ip) && this.porIp.size >= MAX_IPS) {
        for (const [k, v] of this.porIp) if (v.hasta <= ahora) this.porIp.delete(k);
        if (this.porIp.size >= MAX_IPS) this.porIp.delete(this.porIp.keys().next().value);
      }
      this.porIp.set(ip, reg);
      this.fallosGlobal.push(ahora);
      vigente.fallos += 1;
      if (vigente.fallos >= FALLOS_POR_PIN) {
        this.pin = null;
        this.bloqueo = { hasta: ahora + BLOQUEO_PIN_MS };
        return { ok: false, error: 'PIN_ANULADO', esperaS: Math.ceil(BLOQUEO_PIN_MS / 1000),
          mensaje: 'Demasiados intentos: el PIN se anuló y emparejar queda bloqueado 10 minutos. Luego pide en la PC de LevoPrint «Otro PIN».' };
      }
      return { ok: false, error: 'PIN_INVALIDO', mensaje: 'PIN incorrecto o vencido. Revisa el que muestra LevoPrint.' };
    }
    this.porIp.delete(ip);
    this.pin = null;                                  // un solo uso (el interruptor genera otro)
    if (this.equipos.length >= MAX_EQUIPOS) {
      // Se libera el que lleva mas tiempo sin usarse.
      this.equipos.sort((a, b) => (a.visto || 0) - (b.visto || 0)).shift();
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const equipo = {
      id: crypto.randomBytes(6).toString('hex'),
      nombre: String(nombre || 'Equipo').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'Equipo',
      hash: sha(token), creado: ahora, visto: ahora, vence: ahora + VIDA_TOKEN_MS, ip: String(ip || ''),
    };
    this.equipos.push(equipo);
    this.guardar();
    return { ok: true, token, vence: new Date(equipo.vence).toISOString(), equipo: { id: equipo.id, nombre: equipo.nombre } };
  }

  validar(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const h = Buffer.from(sha(token));
    const ahora = this.ahora();
    for (const e of this.equipos) {
      if (crypto.timingSafeEqual(h, Buffer.from(e.hash))) {
        if (!(e.vence > ahora)) { this.purgarVencidos(); return null; }
        // Uso = renovacion (se guarda como mucho una vez por hora).
        if (ahora - (e.visto || 0) > 3600000) { e.visto = ahora; e.vence = ahora + VIDA_TOKEN_MS; this.guardar(); }
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

module.exports = { Emparejador, sha, VIDA_TOKEN_MS, PIN_MS, FALLOS_POR_PIN, BLOQUEO_PIN_MS };
