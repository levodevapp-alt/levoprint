// ============================================================
// LevoPrint · emparejamiento de equipos de la red (LP-O02, portado de F2)
// ------------------------------------------------------------
// El servidor LAN (:9120) solo atiende a equipos EMPAREJADOS:
//   1) En la ventana local de LevoPrint (127.0.0.1:9110, solo en esta PC),
//      con «Imprimir sin internet» encendido, alguien toca «Emparejar equipo»
//      y recien ahi existe un PIN de 6 digitos. Vale 3 min y sirve UNA vez;
//      al usarse o vencer NO se genera otro solo ([QA MEDIO-1]: sin PIN
//      permanente no hay a que adivinarle). Uno a la vez.
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
//     local (alguien en la PC se entera de que lo estan atacando).
//   · [QA MEDIO-1] contador ACUMULADO de fallos entre PINs (no se reinicia al
//     pedir otro PIN): 100 en 1 h, 200 en 24 h o 500 en 7 dias -> BLOQUEADO
//     hasta que alguien pulse «Otro PIN» en la ventana local (aviso rojo).
//     Corta el goteo (pocos intentos por PIN, muchos PIN). Contador y bloqueo
//     van a disco (mismo archivo que los equipos): reiniciar LevoPrint no los
//     borra. Solo «Otro PIN» con el bloqueo puesto los limpia.
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

const PIN_MS = 3 * 60000;
const FALLOS_IP = 5, ESPERA_IP_MS = 60000;
const FALLOS_MINUTO = 30;
const MAX_IPS = 1000;
const FALLOS_POR_PIN = 50;
const BLOQUEO_PIN_MS = 10 * 60000;
const HORA_MS = 3600000, DIA_MS = 24 * HORA_MS, SEMANA_MS = 7 * DIA_MS;
// [QA MEDIO-1] Topes del contador acumulado (entre PINs, persistido).
const FALLOS_HORA = 100, FALLOS_DIA = 200, FALLOS_SEMANA = 500;
const VIDA_TOKEN_MS = 90 * 86400000;
const MAX_EQUIPOS = 50;

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class Emparejador {
  constructor(archivo, opciones) {
    const o = opciones || {};
    this.archivo = archivo;
    this.ahora = o.ahora || (() => Date.now());
    this.equipos = [];
    this.pin = null;               // { valor, expira, fallos }  (solo en memoria: existe tras «Emparejar equipo»)
    this.pinVencido = false;       // el ultimo PIN vencio sin usarse -> PIN_VENCIDO (hasta pedir otro o apagar)
    this.bloqueo = null;           // { hasta, acumulado } sin PIN hasta «Otro PIN» (y no antes de hasta). En disco.
    this.fallos = [];              // [QA MEDIO-1] ts de fallos de los ultimos 7 dias, entre PINs. En disco.
    this.porIp = new Map();        // ip -> { fallos, hasta }
    this.fallosGlobal = [];        // ts de fallos del ultimo minuto
    try {
      const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      if (j && Array.isArray(j.equipos)) {
        this.equipos = j.equipos
          .filter((e) => e && typeof e.id === 'string' && typeof e.hash === 'string' && /^[0-9a-f]{64}$/.test(e.hash) && typeof e.vence === 'number')
          .slice(0, MAX_EQUIPOS);
      }
      if (j && Array.isArray(j.fallos)) {
        // Basura o fechas absurdas (mas de 1 dia en el futuro: nunca envejecerian) se ignoran.
        const desde = this.ahora() - SEMANA_MS, tope = this.ahora() + DIA_MS;
        this.fallos = j.fallos.filter((t) => Number.isFinite(t) && t > desde && t <= tope).slice(-FALLOS_SEMANA);
      }
      if (j && j.bloqueo && typeof j.bloqueo === 'object' && Number.isFinite(j.bloqueo.hasta)) {
        this.bloqueo = { hasta: j.bloqueo.hasta, acumulado: j.bloqueo.acumulado === true };
      }
    } catch { /* primera vez o archivo roto: sin equipos */ }
    this.purgarVencidos();
  }

  guardar() {
    try {
      const tmp = this.archivo + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      const datos = { equipos: this.equipos, fallos: this.fallos, bloqueo: this.bloqueo };
      try { fs.writeSync(fd, JSON.stringify(datos, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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
    this.pinVencido = false;
    return this.pin;
  }

  // PIN vigente o null. NUNCA genera uno: solo «Emparejar equipo» / «Otro PIN» en la ventana local.
  pinVigente() {
    if (this.pin && this.pin.expira > this.ahora()) return this.pin;
    if (this.pin) this.pinVencido = true;   // vencio sin usarse
    this.pin = null;
    return null;
  }

  // Apagar el interruptor: el PIN muere (no queda "vencido": al encender no hay PIN).
  anularPin() { this.pin = null; this.pinVencido = false; }

  // [QA MEDIO-1] ¿El contador acumulado paso algun tope? (100/h, 200/24 h, 500/7 dias)
  fallosAcumulados() {
    const ahora = this.ahora();
    let hora = 0, dia = 0, semana = 0;
    for (const t of this.fallos) {
      if (t > ahora - SEMANA_MS) semana++;
      if (t > ahora - DIA_MS) dia++;
      if (t > ahora - HORA_MS) hora++;
    }
    return { hora, dia, semana, excedido: hora >= FALLOS_HORA || dia >= FALLOS_DIA || semana >= FALLOS_SEMANA };
  }

  // { bloqueado, hasta, esperaS, requiereOtroPin, acumulado }: para la ventana local y /v1/hola.
  estadoBloqueo() {
    if (!this.bloqueo) return { bloqueado: false, hasta: null, esperaS: 0, requiereOtroPin: false, acumulado: false };
    const falta = this.bloqueo.hasta - this.ahora();
    return { bloqueado: true, hasta: this.bloqueo.hasta, esperaS: falta > 0 ? Math.ceil(falta / 1000) : 0, requiereOtroPin: true, acumulado: !!this.bloqueo.acumulado };
  }

  // Boton «Emparejar equipo» de la ventana local: PIN nuevo por 3 min (reemplaza al anterior: uno a la vez).
  // Con el emparejamiento bloqueado se niega: solo «Otro PIN» (pedirOtroPin) lo levanta, a proposito.
  pedirPin() {
    const b = this.estadoBloqueo();
    if (b.bloqueado) {
      return { ok: false, error: 'PIN_BLOQUEADO', esperaS: b.esperaS, acumulado: b.acumulado,
        mensaje: b.acumulado ? 'Alguien intentó muchos PIN. Emparejamiento bloqueado: toca «Otro PIN» si eres tú.'
          : 'Hubo demasiados intentos con PIN errado desde la red. Emparejar está bloqueado: toca «Otro PIN».' };
    }
    return { ok: true, pin: this.nuevoPin() };
  }

  // Boton «Otro PIN» de la ventana local (127.0.0.1). Durante el bloqueo de 10 min se niega.
  // Si habia bloqueo, una persona en la PC lo levanta: se limpia tambien el contador acumulado
  // (si no, el primer fallo siguiente lo volveria a bloquear). Sin bloqueo, el contador SIGUE.
  pedirOtroPin() {
    const b = this.estadoBloqueo();
    if (b.bloqueado && b.esperaS > 0) {
      return { ok: false, error: 'PIN_BLOQUEADO', esperaS: b.esperaS, acumulado: b.acumulado,
        mensaje: 'Hubo demasiados intentos con PIN errado desde la red. Podrás pedir otro PIN en ' + Math.ceil(b.esperaS / 60) + ' min.' };
    }
    if (b.bloqueado) {
      this.bloqueo = null;
      this.fallos = [];
      this.guardar();
    }
    return { ok: true, pin: this.nuevoPin() };
  }

  intentar(pin, nombre, ip) {
    const ahora = this.ahora();
    if (this.bloqueo) {
      const b = this.estadoBloqueo();
      return { ok: false, error: 'PIN_BLOQUEADO', esperaS: b.esperaS, acumulado: b.acumulado,
        mensaje: 'Emparejar está bloqueado por demasiados intentos. Pide en la PC de LevoPrint «Otro PIN»' + (b.esperaS > 0 ? ' (en ' + Math.ceil(b.esperaS / 60) + ' min).' : '.') };
    }
    this.fallosGlobal = this.fallosGlobal.filter((t) => t > ahora - 60000);
    if (this.fallosGlobal.length >= FALLOS_MINUTO) return { ok: false, error: 'ESPERA', mensaje: 'Demasiados intentos en la red. Espera un minuto.', esperaS: 60 };
    const reg = this.porIp.get(ip) || { fallos: 0, hasta: 0 };
    if (reg.hasta > ahora) return { ok: false, error: 'ESPERA', mensaje: 'Demasiados intentos. Espera un minuto.', esperaS: Math.ceil((reg.hasta - ahora) / 1000) };
    const vigente = this.pinVigente();
    if (!vigente) {
      if (this.pinVencido) return { ok: false, error: 'PIN_VENCIDO', mensaje: 'Ese PIN venció (dura 3 minutos). En la PC de LevoPrint toca «Emparejar equipo» y usa el PIN nuevo.' };
      return { ok: false, error: 'SIN_PIN', mensaje: 'En la PC de LevoPrint toca «Emparejar equipo» (con «Imprimir sin internet» encendido) y usa el PIN que muestra.' };
    }
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
      // [QA MEDIO-1] Contador acumulado entre PINs (en disco; tope de largo = el de la semana).
      this.fallos.push(ahora);
      if (this.fallos.length > FALLOS_SEMANA) this.fallos = this.fallos.slice(-FALLOS_SEMANA);
      const acum = this.fallosAcumulados().excedido;
      const anulado = vigente.fallos >= FALLOS_POR_PIN;
      if (acum || anulado) {
        this.pin = null;
        this.bloqueo = { hasta: anulado ? ahora + BLOQUEO_PIN_MS : ahora, acumulado: acum };
      }
      this.guardar();
      if (acum) {
        return { ok: false, error: 'PIN_BLOQUEADO', acumulado: true, esperaS: anulado ? Math.ceil(BLOQUEO_PIN_MS / 1000) : 0,
          mensaje: 'Demasiados intentos con PIN errado: emparejar queda bloqueado. Pide en la PC de LevoPrint «Otro PIN».' };
      }
      if (anulado) {
        return { ok: false, error: 'PIN_ANULADO', esperaS: Math.ceil(BLOQUEO_PIN_MS / 1000),
          mensaje: 'Demasiados intentos: el PIN se anuló y emparejar queda bloqueado 10 minutos. Luego pide en la PC de LevoPrint «Otro PIN».' };
      }
      return { ok: false, error: 'PIN_INVALIDO', mensaje: 'PIN incorrecto. Revisa el que muestra LevoPrint.' };
    }
    this.porIp.delete(ip);
    this.pin = null;                                  // un solo uso: el proximo equipo pide otro con «Emparejar equipo»
    this.pinVencido = false;
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

module.exports = { Emparejador, sha, VIDA_TOKEN_MS, PIN_MS, FALLOS_POR_PIN, BLOQUEO_PIN_MS, FALLOS_HORA, FALLOS_DIA, FALLOS_SEMANA };
