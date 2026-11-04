# LevoPrint · Instructivo de prueba (PC .exe y Android .apk)

> Objetivo: verificar en equipo real que un cliente puede **descargar, vincular
> en 1 código e imprimir**, sin editar ningún archivo de texto.
> Versiones publicadas: **exe v1.6** (ventana visual) · **APK v1.2.0** (código/QR).
> Publicado el 2026-09-16 en `descargas/levoprint/` — los botones de la consola ya lo sirven.

---

## 0. Antes de empezar (una sola vez)
- Ten a la mano una **impresora térmica** (58 u 80 mm) conectada a la **misma red WiFi**
  que la PC/celular, y su **IP** (suele salir en el ticket de autotest de la impresora,
  o en tu router). Si es por **Bluetooth**, tenla emparejada en el sistema.
- Entra a la consola del negocio: **KIPU → Configuración → Estaciones**
  (o en KOMO, cuando se porte el módulo). Ahí está el botón **"🔗 Vincular LevoPrint"**.

---

## A. Prueba en PC (Windows, el .exe)

1. **Generar el código.** En *Estaciones*, elige la estación (p. ej. "Caja") y pulsa
   **Vincular LevoPrint → Generar código**. Aparece un **código de 9 caracteres** (empieza con K en KOMO, P en KIPU o T en KUTI) y un **QR**.
   El código dura **15 minutos**.
2. **Descargar el programa.** En la misma pantalla, botón **"Descargar (PC)"** →
   baja `LevoPrint-Windows.zip`. Descomprímelo (clic derecho → *Extraer todo*).
3. **Abrir.** Doble clic a **`LevoPrint.exe`**.
   - Si Windows muestra *"Windows protegió tu PC"* (SmartScreen): **Más información →
     Ejecutar de todas formas**. Es normal en programas nuevos sin firma comercial.
   - Se abre **una ventanita en el navegador** (localhost) con un **semáforo** y campos.
4. **Vincular.** Escribe el **código de 9 caracteres** (empieza con K en KOMO, P en KIPU o T en KUTI) en el campo y pulsa **Vincular**.
   → Debe decir *"Vinculado como: Caja · <tu negocio>. Listo."* y el semáforo pasa a **verde**.
   *(A partir de aquí se configura solo: no se toca ningún .txt.)*
5. **Poner la IP de la impresora.** En la ventanita, campo **IP** → escribe la IP
   (ej. `192.168.1.50`) y guarda. Elige **58 u 80 mm** según tu papel.
6. **Imprimir prueba.** Botón **"Imprimir prueba"** → debe salir un ticket de prueba.
7. **Prueba real.** Haz una **venta** en KIPU en esa caja → el ticket debe imprimirse solo.

**✔ Éxito si:** semáforo verde + imprime la prueba + imprime una venta real.

### Qué reportar si algo falla (PC)
- ¿SmartScreen impidió abrir? (esperado; anota si confunde al cliente).
- ¿El navegador **no** abrió solo? (anota; se puede abrir a mano en `http://127.0.0.1:9110`).
- ¿El código dio error? Anota el texto exacto: *CODIGO_VENCIDO* (pasaron 15 min, genera otro),
  *CODIGO_USADO* (ya se canjeó, genera otro), *CODIGO_INVALIDO* (mal tipeado).
- ¿No imprime con IP correcta? Anota marca/modelo de impresora y si es red o Bluetooth.

---

## B. Prueba en Android (el .apk)

1. **Generar el código** igual que en A.1 (código + QR en pantalla).
2. **Descargar la app.** Botón **"Descargar (Android)"** → baja `LevoPrint.apk`.
   - Android pedirá permiso para **instalar apps de esta fuente**: **Permitir**.
   - Instala. (Si ya tenías una versión vieja, esta se instala **encima** — versionCode 12.)
3. **Abrir LevoPrint.** Verás la sección de **vinculación**.
4. **Vincular — dos caminos, cualquiera vale:**
   - **Escanear QR:** botón **"Escanear QR"** → permite la **cámara** → apunta al QR de la
     consola. Se vincula solo.
   - **O código:** escribe las **9 letras y números** (con o sin guiones) y pulsa **Vincular**. Sale un papel de prueba y el aviso en verde; si falla, en rojo con doble vibración. Si aparece la tarjeta del ahorro de batería, toca **Permitir**.
   → Debe confirmar la vinculación y quedar listo.
5. **Poner la IP** de la impresora (o elegir la impresora **Bluetooth**) y **guardar**.
6. **Imprimir prueba** y luego una **venta real** desde KIPU.

**✔ Éxito si:** vincula por QR **y** por código, y ambos imprimen.

### Qué reportar si algo falla (Android)
- ¿El **QR** no se leyó? (luz, distancia, permiso de cámara denegado).
- ¿El **deep-link** (abrir el QR desde la cámara del sistema) abrió la app? (opcional, es un plus).
- ¿La instalación se bloqueó? Anota la versión de Android.
- Mismos errores de código que en PC (vencido/usado/inválido).

---

## C. Notas para el equipo (no para el cliente)
- **Un código = un uso, 15 min.** Al generar uno nuevo se invalidan los anteriores de esa estación.
- **KOMO y KIPU comparten el mismo proyecto Supabase**, por eso la app prueba prefijos
  conocidos y no hace falta que el QR lleve la URL. Cuando exista otro proyecto, habrá que
  meter `&u=&a=&p=` en el QR (ya está preparado en `Emparejamiento.parseLink`).
- **Publicación automática (opcional):** el CI ya tiene el paso de subir al bucket; solo
  falta el secret `SUPABASE_SERVICE_KEY` en el repo. Mientras no esté, se publica a mano
  (descargar artifact del CI → subir al bucket). Con el secret puesto, se publica con *Run workflow*
  desde `main` y la casilla **publicar** (un push o merge ya no publica solo; ver README › Publicar).
- **Antes de publicar, siempre:** lanza el run a mano **sin** marcar publicar y verifica que salga en **verde**
  (pruebas, APK/.exe y `LevoPrint.json` válido). Solo entonces vuelve a lanzarlo desde `main` con **publicar** ✔.
- **Aviso de actualización (APK 1.7.0+):** tras publicar, abre LevoPrint en un equipo con una versión anterior
  (desde la 1.7.0): debe salir la tarjeta «Hay una versión nueva de LevoPrint (X) → Actualizar» y, en menos de
  12 h, la notificación. Sin internet no debe salir nada ni dejar de imprimir.
- **Portar a KOMO:** el backend del código de estación está aplicado en KIPU; en KOMO queda
  generado, falta `node apply.mjs komo levoprint` + un smoke test.

> **Nota (MM4-07):** el permiso de ahorro de batería es para la instalación desde el bucket. Si LevoPrint
> se publica en Play Store, quitar `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` o ponerlo en un *flavor* aparte
> (ver README).

## D. Impresora por estación (LP-F3/F4 · .exe 1.13 · APK 1.7.0)
Necesita el backend `levoprint_transporte` aplicado en la app (si no, LevoPrint sigue como antes y al elegir dice «Escribe esta IP en…»).

**PC**
1. Abre LevoPrint 1.13 y vincula con el código. En unos segundos la ventana pregunta **«¿Dónde está la impresora de <estación>?»** con dos grupos: *En la red* y *Conectadas a esta PC (USB)*.
2. Toca **Probar** en una → sale un papel → **Sí, salió** → «Listo: <estación> imprime en …». En tu app, la estación muestra esa impresora.
3. Con una impresora USB instalada en Windows: elige la USB y haz una venta: debe salir por USB.
4. **No la veo** → escribe la IP a mano → Probar.
5. Si tienes el programa antiguo de KOMO: deja `komo-agente.txt` junto a LevoPrint y ábrelo; debe aparecer KOMO vinculado y el aviso **Cerrar y quitar KOMO Agente**.

**Android**
1. Instala el APK 1.7.0 encima del anterior (versionCode 12) y vincula.
2. La pantalla pregunta **«¿Dónde está la impresora de <estación>?»** con *En la red*, *Bluetooth* y *USB*. **Buscar de nuevo** pide permiso de Bluetooth cercano y busca 12 s.
3. Bluetooth sin emparejar: al tocarla Android pide el PIN (0000 o 1234), luego sale el papel → **Sí, salió**.
4. USB (cable OTG): al conectarla Android ofrece abrir LevoPrint; marca «usar por defecto» para no volver a pedir permiso.

**Qué reportar:** marca/modelo, si es red/Bluetooth/USB, el texto exacto del error y, en PC, `levoprint.log`.
**Consola:** en otro equipo, un trabajo de una estación USB/BT de este equipo NO debe imprimirse ahí.

## Paso extra: revisa el logo del pie (APK 1.7.0 / .exe 1.13)
El papel de prueba trae el pie con el logo de LevoDev. Si en la impresora sale basura o signos raros (no imprime imágenes), apaga el logo: APK → Opciones avanzadas › «Pie con logo» apagado; .exe → botón «Pie con logo» de la ventana o `LEVO_IMAGEN=0` en `levoprint.txt`. El pie sale igual, solo en texto.
