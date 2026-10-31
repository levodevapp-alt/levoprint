// ============================================================
// LevoPrint · una cola por estacion (F2)
// ------------------------------------------------------------
// PORQUE: antes el agente imprimia en serie TODO; una impresora atascada
// (sin papel, apagada a medias) frenaba la cocina, la barra y la caja a la
// vez (PLAN §4.1.5). Ahora cada destino tiene su propia fila: los trabajos
// de la misma impresora salen en orden; los de otra impresora no esperan.
// Cada trabajo tiene un tope de tiempo (timeoutMs): si se cuelga, la fila
// sigue con el siguiente y el colgado se da por fallido.
// [re-QA F2] La tarea recibe { abandonada }: si el tope vencio mientras
// esperaba (p. ej. el render remoto tardo), NO debe mandar nada: quien pidio
// el papel ya recibio un error y podria reintentarlo por otra ruta.
// ============================================================
'use strict';

class Colas {
  constructor(opciones = {}) {
    this.timeoutMs = opciones.timeoutMs || 25000;
    this.cadenas = new Map();      // clave -> promesa de la ultima tarea
    this.pendientes = new Map();   // clave -> cuantas esperan o corren
  }

  encolar(clave, tarea, timeoutMs) {
    const k = String(clave || 'sin-estacion');
    const previa = this.cadenas.get(k) || Promise.resolve();
    this.pendientes.set(k, (this.pendientes.get(k) || 0) + 1);
    const tope = timeoutMs || this.timeoutMs;
    const actual = previa.catch(() => {}).then(() => new Promise((resolve, reject) => {
      let listo = false;
      const estado = { abandonada: false };
      const t = setTimeout(() => {
        if (listo) return;
        listo = true;
        estado.abandonada = true;
        reject(new Error(`la impresora no respondio en ${Math.round(tope / 1000)} s`));
      }, tope);
      Promise.resolve().then(() => tarea(estado)).then(
        (v) => { if (!listo) { listo = true; clearTimeout(t); resolve(v); } },
        (e) => { if (!listo) { listo = true; clearTimeout(t); reject(e); } });
    }));
    const fin = () => {
      const n = (this.pendientes.get(k) || 1) - 1;
      if (n <= 0) { this.pendientes.delete(k); if (this.cadenas.get(k) === cola) this.cadenas.delete(k); }
      else this.pendientes.set(k, n);
    };
    const cola = actual.then(fin, fin);
    this.cadenas.set(k, cola);
    return actual;
  }

  enEspera(clave) { return this.pendientes.get(String(clave)) || 0; }

  resumen() { return Object.fromEntries(this.pendientes); }
}

module.exports = { Colas };
