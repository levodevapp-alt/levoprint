# LevoPrint F2 · Impresión local (red del local + USB) con detección automática

Rama `feat/offline-f2` · Plan: `levodev-modules/docs/PLAN_OFFLINE_E_IMPRESION.md` §4 y §6 F2.
Estado: **código y pruebas automáticas listas; falta la prueba con hardware real** (sección 5).

## 1. Qué cambia

| Antes (1.7 / APK 1.4) | Ahora (1.8 / APK con F2) |
|---|---|
| Los papeles llegan **solo desde la nube**: sin internet en el local, no imprime | Además escucha en la **red del local** (`:9120`): la caja y el mozo mandan el papel directo, sin internet |
| Solo impresoras de red (TCP 9100) y Bluetooth (APK) | + **USB en Windows** (cola de impresión, RAW) y **USB por OTG en Android** |
| La IP de la impresora se escribía a mano en la consola | **Buscar impresoras**: USB, red (barrido del puerto 9100 + mDNS) y Bluetooth; se asigna a una estación con un toque |
| Si `marcar` fallaba, el papel podía salir dos veces | **Diario** de trabajos por `jobId` (7 días): el mismo papel nunca sale dos veces, venga por la LAN o por la nube |
| Una impresora atascada frenaba a todas | **Una cola por impresora**, con tope de tiempo |
| Estaciones solo en memoria | Estaciones guardadas en disco: **arranca e imprime sin internet** |

## 2. Contrato del servidor local (igual en el .exe y en el APK)

`http://<ip-del-equipo>:9120` · JSON · todo menos `hola` y `emparejar` exige `Authorization: Bearer <token>`.

| Ruta | Para qué |
|---|---|
| `GET /v1/hola` | Detección: `{levoprint, version, prefijo}` (sin datos del negocio) |
| `POST /v1/emparejar` `{pin, nombre}` | Da el token del equipo. El PIN (6 dígitos, 10 min, un uso) lo muestra LevoPrint |
| `GET /v1/estado` | Estaciones con su ruta (`via`), cola, si hay nube |
| `POST /v1/imprimir` `{jobId, tipo, payload, estacion}` | Imprime. `duplicado:true` si ese `jobId` ya salió |
| `GET /v1/impresoras` | Asistente "Buscar impresoras" |
| `POST /v1/prueba` `{transporte, destino}` o `{estacion}` | Papel de prueba |
| `POST /v1/refrescar` | Relee estaciones de la nube (tras asignar en la app) |
| `GET /v1/diario` | Últimos `jobId` y su estado |

**Seguridad**
- Solo IP de origen privada (192.168/16, 10/8, 172.16/12, loopback, link-local). `100.64/10` (datos móviles) no.
- `Host` debe ser IP literal, `localhost` o `*.local` (corta el DNS rebinding).
- CORS solo para `https://*.levodev.app` (+ `LEVO_ORIGENES` en desarrollo). Nunca `*`. Preflight con `Access-Control-Allow-Private-Network`.
- Token por equipo; en disco solo su sha256. Freno: 5 PIN fallidos por IP → 60 s; 20 en 10 min → el PIN se anula.
- La ventana local del .exe (`127.0.0.1:9110`) ahora rechaza órdenes de otras páginas (exige JSON, sin `Origin` ajeno y `Host` 127.0.0.1/localhost).
- **LevoPrint no guarda ni recibe certificados, claves SOL ni llaves del cliente.** El comprobante se firma en la nube (LevoFact); el agente solo imprime papel.
- TCP solo hacia IP privada: el agente no sirve de puente hacia internet.

## 3. Transportes y "destino"

| Transporte | Destino | Dónde |
|---|---|---|
| `TCP` | `ip:puerto` (9100) | .exe y APK |
| `USB_WIN` | nombre de la impresora en Windows | .exe (cola de impresión RAW vía PowerShell + `winspool.drv`) |
| `USB_ANDROID` | `VID:PID` en hex (`04B8:0E15`) | APK (USB host / OTG) |
| `BT` | MAC | APK (SPP) |
| `BLE` | reservado | — |

Ruta de una estación: asignación hecha en ese equipo > `transporte/destino` de la nube > `impresora_ip` de siempre > (APK) interruptor Bluetooth viejo.

## 4. Cómo compilar

**.exe** (igual que antes, ahora con un paso más): `cd agente && node build-exe.mjs`.
- `empaquetar.mjs` junta `index.js` + `lib/*.js` en `dist/levoprint.bundle.js` (Node SEA solo acepta un archivo) y ese es el `main` de `sea-config.json`.
- CI (`build-exe.yml`) no cambia: corre `build-exe.mjs`. **Solo corre en `main`**: esta rama no publica nada.
- Pruebas: `cd agente && npm test` (40 pruebas: dorados, unidades, punta a punta). `npm run test:usb` (Windows, abre PowerShell). `npm run test:e2e-exe` corre la punta a punta contra el empaquetado.

**APK**: `gradle assembleRelease` como siempre (CI `build.yml`, solo en `main`).
- En esta PC compiló con Gradle 8.9 del caché, sin daemon y con poca memoria:
  `gradle --offline --no-daemon -Dorg.gradle.jvmargs=-Xmx900m -Pkotlin.compiler.execution.strategy=in-process :app:testDebugUnitTest`
  (requiere `local.properties` con `sdk.dir=C:/Users/ISO/AppData/Local/Android/Sdk`, que no se versiona).
- **Antes de publicar: subir `versionCode` (hoy 6) y `versionName`**, si no Android no instala la actualización. No se subió en esta rama a propósito (lo decide quien publica).

## 5. Prueba con hardware REAL (obligatoria antes de venderlo)

Nada de esto se pudo probar aquí: no hay ticketera, ni Android, ni Bluetooth en esta PC.

### 5.1 PC Windows + ticketera USB (Epson TM-T20 o Xprinter 80 mm)
1. Conectar la ticketera por USB e instalar su driver. Si no hay driver: Panel de control → Agregar impresora → "Generic / Text Only" en el puerto `USB001`.
2. Abrir LevoPrint.exe (1.8). En la ventana: **Buscar impresoras** → debe aparecer "USB · <nombre>" marcada *ticketera*.
3. **Probar** → sale "PRUEBA LEVOPRINT OK" con corte.
4. Elegir la estación (Cocina) → **Asignar**. En la app (Estaciones) la estación debe mostrar la ruta nueva en ≤ 1 min.
5. Desde la app, una comanda normal (con internet) → sale por USB.
6. Repetir con la impresora de red: Buscar → "Impresora de red 192.168.x.x" → Probar → Asignar.
7. Antivirus: verificar que no bloquee el puerto 9120 ni el PowerShell del helper (si pasa: excluir la carpeta de LevoPrint).

### 5.2 Internet caído, LAN viva (el caso D'Amour)
1. PC con LevoPrint 1.8 + tablet/celular Android con Chrome en la misma WiFi.
2. En la app (Chrome Android), Estaciones → **Imprimir sin internet** → escribir la dirección que muestra LevoPrint y el PIN (botón "Emparejar un equipo" de la ventana) → **Emparejar este equipo**.
3. **Chrome pedirá "Acceso a la red local": tocar Permitir.** Anotar la versión de Chrome Android. Si NO aparece el permiso y falla: la ruta local no sirve en esa versión (ver 6).
4. Desenchufar el cable de internet del router (la WiFi sigue). Mandar una prueba / una comanda.
5. Debe salir **un** papel. Volver a enchufar el internet: **no** debe salir de nuevo cuando la nube entregue el trabajo.
6. Con datos móviles en el celular y la WiFi del local sin internet (escenario E1): verificar que Android mantiene la WiFi para la LAN.

### 5.3 Android con ticketera USB (OTG)
1. APK nuevo en una tablet; cable OTG; enchufar la ticketera → Android ofrece abrir LevoPrint ("Usar de forma predeterminada").
2. **Buscar impresoras** → "USB · VID:PID" → Imprimir prueba → Asignar a Caja.
3. Desde la app en la misma tablet, con LevoPrint local `http://127.0.0.1:9120`.

### 5.4 Portátil Bluetooth 58 mm
Emparejar en Ajustes de Android → LevoPrint → Buscar impresoras → aparece en BT → Probar → Asignar.

## 6. Limitaciones conocidas

- **iPhone / iPad (Safari): no hay impresión sin internet.** Safari bloquea `http://` desde `https://` y no tiene WebUSB ni Web Bluetooth. Solo imprimen por la nube (con internet). Decirlo en ventas.
- **Chrome Android: el permiso "Acceso a la red local" (LNA) depende de la versión.** Hay que probarlo en un equipo real antes de prometerlo (5.2). La app lo pide con `targetAddressSpace`.
- WebUSB solo es respaldo en Android sin LevoPrint (en Windows el driver `usbprint.sys` toma la impresora). No probado en hardware.
- El APK no compila el render único: sigue con su render Kotlin (probado contra el original). El render JS del agente y el espejo del navegador (`core/front/lib/escpos.js`) son idénticos byte a byte (30 dorados).
- USB en Windows abre un PowerShell por papel (~1–3 s la primera vez). Suficiente para tickets.
- Un papel que falla por tiempo pero que la impresora sí sacó puede repetirse si se reintenta (no hay forma de saberlo desde el agente).
- El emparejamiento del mozo/caja hoy está en la pantalla de Estaciones (dueño). Llevarlo a la pantalla del mozo es parte de F3.

## 7. Qué reutiliza F5 (puente multi-equipo)

- El **servidor LAN** (`lib/servidorLan.js` / `ServidorLocal.kt`): mismo puerto, mismo emparejamiento con token, misma seguridad (IP privada, Host, CORS). F5 agrega `GET /v1/eventos` (SSE) y `POST /v1/publicar` sobre él.
- La **detección del agente** desde la app (`<p>_print_local`, `basesSugeridas()`, `lpLocal` en `core/front/lib/impresora.js`).
- El **diario por clave** como patrón de dedupe de eventos (`jobId` → `eventoId`).
- La **cola por destino** como modelo de "un hilo por canal".
