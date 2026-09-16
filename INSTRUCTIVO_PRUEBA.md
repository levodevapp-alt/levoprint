# LevoPrint · Instructivo de prueba (PC .exe y Android .apk)

> Objetivo: verificar en equipo real que un cliente puede **descargar, emparejar
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
   **Vincular LevoPrint → Generar código**. Aparece un **código de 8 letras** y un **QR**.
   El código dura **15 minutos**.
2. **Descargar el programa.** En la misma pantalla, botón **"Descargar (PC)"** →
   baja `LevoPrint-Windows.zip`. Descomprímelo (clic derecho → *Extraer todo*).
3. **Abrir.** Doble clic a **`LevoPrint.exe`**.
   - Si Windows muestra *"Windows protegió tu PC"* (SmartScreen): **Más información →
     Ejecutar de todas formas**. Es normal en programas nuevos sin firma comercial.
   - Se abre **una ventanita en el navegador** (localhost) con un **semáforo** y campos.
4. **Emparejar.** Escribe el **código de 8 letras** en el campo y pulsa **Vincular**.
   → Debe decir *"Emparejado como: Caja · <tu negocio>. Listo."* y el semáforo pasa a **verde**.
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
   - Instala. (Si ya tenías una versión vieja, esta se instala **encima** — versionCode 4.)
3. **Abrir LevoPrint.** Verás la sección de **emparejamiento**.
4. **Emparejar — dos caminos, cualquiera vale:**
   - **Escanear QR:** botón **"Escanear QR"** → permite la **cámara** → apunta al QR de la
     consola. Se empareja solo.
   - **O código:** escribe las **8 letras** y pulsa **Emparejar**.
   → Debe confirmar el emparejamiento y quedar listo.
5. **Poner la IP** de la impresora (o elegir la impresora **Bluetooth**) y **guardar**.
6. **Imprimir prueba** y luego una **venta real** desde KIPU.

**✔ Éxito si:** empareja por QR **y** por código, y ambos imprimen.

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
  (descargar artifact del CI → subir al bucket). Con el secret puesto, **cada push publica solo**.
- **Portar a KOMO:** el backend del código de estación está aplicado en KIPU; en KOMO queda
  generado, falta `node apply.mjs komo levoprint` + un smoke test.
