// Pruebas doradas del render: lib/render.js debe dar EXACTAMENTE los bytes
// del index.js original (dorados generados por test/generar-dorados.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { crearRender } = require('../lib/render');
const fixtures = require('./fixtures');

for (const ancho of [48, 64]) {
  const R = crearRender(ancho);
  for (const f of fixtures) {
    test(`render ${f.nombre} @${ancho}`, () => {
      const dorado = fs.readFileSync(path.join(__dirname, 'dorados', `${f.nombre}.${ancho}.bin`));
      const sale = Buffer.from(R.render(JSON.parse(JSON.stringify(f.job))), 'binary');
      assert.ok(sale.equals(dorado), `difiere del dorado (${sale.length} vs ${dorado.length} bytes)`);
    });
  }
}
