// ============================================================
// LevoPrint · fixtures de render (pruebas doradas, F2)
// Payloads representativos de KOMO, KIPU y KUTI. Los dorados (.bin) se
// generaron con el render ORIGINAL de agente/index.js (rama kuti, b8b1517)
// ANTES de mover el render a lib/render.js: si un byte cambia, la prueba
// lo grita. Mismos fixtures para core/escpos (levodev-modules).
// ============================================================
'use strict';
const items = [
  { cantidad: 2, nombre: 'Lomo saltado', precio: 28.5, nota: 'sin cebolla', total: 57 },
  { cantidad: 1.25, nombre: 'Queso andino (kg)', precio: 32, total: 40 },
  { cantidad: 1, nombre: 'Chicha morada jarra grande con hielo', precio: 15, total: 15 },
];
const marca = { app: 'KOMO', lema: 'Tu restaurante en orden' };
module.exports = [
  { nombre: 'prueba', job: { tipo: 'PRUEBA', payload: {} } },
  { nombre: 'comanda', job: { tipo: 'COMANDA', payload: { mesa: '7', mozo: 'Ana', hora: '13:05', ronda: 2, items, nota: 'Cliente apurado', ...marca } } },
  { nombre: 'comanda_correccion', job: { tipo: 'COMANDA', payload: { correccion: true, mesa: '3', mozo: 'Luis', hora: '20:10', mensaje: 'ANULA 1 LOMO', items: items.slice(0, 1) } } },
  { nombre: 'comanda_reimpresion', job: { tipo: 'COMANDA', payload: { reimpresion: true, mesa: '4', mozo: 'Ana', hora: '12:00', items } } },
  { nombre: 'comanda_atrasada', job: { tipo: 'COMANDA', payload: { atrasada: true, mesa: '5', mozo: 'Ana', hora: '11:40', items } } },
  { nombre: 'precuenta', job: { tipo: 'PRECUENTA', payload: { mesa: '7', mozo: 'Ana', hora: '13:40', cuenta: { n: 1, de: 2 }, items, total: 112, qr: 'https://komo.levodev.app/p/abc', ...marca } } },
  { nombre: 'ticket_komo', job: { tipo: 'TICKET', payload: { mesa: '7', mozo: 'Ana', hora: '14:00', items, total: 112, pagos: [{ medio: 'EFECTIVO', monto: 100 }, { medio: 'YAPE', monto: 12 }], ...marca } } },
  { nombre: 'ticket_kipu', job: { tipo: 'TICKET', payload: { negocio: 'Bodega Rosita', vendedor: 'Carla', nota: 'NV01-00000123', hora: '09:15', items, total: 112, pagos: [{ medio: 'EFECTIVO', monto: 112 }], app: 'KIPU' } } },
  { nombre: 'ticket_kuti', job: { tipo: 'TICKET', payload: { negocio: 'Barberia Sur', local: 'Local Centro', refTipo: 'ALQUILER', vendedor: 'Rosa', cliente: 'Juan Perez', hora: '18:30', copia: true, reimpresion: true, items: [{ cantidad: 1, nombre: 'Corte clasico', precio: 25, profesional: 'Pedro' }], total: 25, pagos: [{ medio: 'PLIN', monto: 25 }], propinas: [{ profesional: 'Pedro', medio: 'EFECTIVO', monto: 5 }], app: 'KUTI' } } },
  { nombre: 'cpe_boleta', job: { tipo: 'CPE', payload: { tipo: 'BOLETA', serie: 'B001', numero: 45, fecha: '2026-10-31', empresa: { razonSocial: 'INVERSIONES DEMO SAC', ruc: '20123456789', direccion: 'Av. Paracas 123, Pisco' }, cliente: { nombre: 'Maria Lopez', tipoDoc: 'DNI', doc: '45678912' }, items, totales: { gravada: 94.92, igv: 17.08 }, total: 112, pagos: [{ medio: 'TARJETA', monto: 112 }], qr: '20123456789|03|B001|45|17.08|112.00|2026-10-31|1|45678912|', hash: 'abcdefghijklmnopqrstuvwxyz0123456789', ...marca } } },
  { nombre: 'cpe_factura_stub', job: { tipo: 'CPE', payload: { tipo: 'FACTURA', estado: 'STUB', serie: 'F001', numero: 7, fecha: '2026-10-31', empresa: { nombre: 'Demo' }, cliente: { nombre: 'EMPRESA CLIENTE SAC', tipoDoc: 'RUC', doc: '20999999991', direccion: 'Jr. Lima 456' }, items: items.slice(0, 1), totales: { exonerada: 57, inafecta: 0 }, total: 1234567.89 } } },
  { nombre: 'carta_qr', job: { tipo: 'CARTA_QR', payload: { titulo: "D'Amour", sub: 'Mira la carta', url: 'https://komo.levodev.app/c/damour', ...marca } } },
  { nombre: 'cierre_kuti', job: { tipo: 'CIERRE', payload: { negocio: 'Barberia Sur', lineas: [{ izq: 'Efectivo', der: 'S/ 120.00' }, { sep: '-' }, { izq: 'Total con un nombre largo que no cabe en la linea', der: 'S/ 300.00', negrita: true }], app: 'KUTI' } } },
  { nombre: 'cierre_json', job: { tipo: 'CIERRE', payload: { total: 300, efectivo: 120 } } },
  { nombre: 'desconocido', job: { tipo: 'OTRO', payload: { a: 1, b: 'dos' } } },
];
