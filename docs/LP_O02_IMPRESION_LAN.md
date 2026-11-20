# LevoPrint · LP-O02 · Imprimir sin internet por la red del local

Rama `feat/lp-o02` · agente `.exe` **1.15.0** · solo el agente de Windows (el APK sigue imprimiendo por la nube; ver §8).
Diseño heredado de `feat/offline-f2` (`docs/F2_IMPRESION_LOCAL.md` de esa rama, 3 rondas de QA), **rehecho sobre el `index.js` de main** (F3/F4 + LP-U1): no se duplican transportes, búsqueda, cola USB ni render; se usan `destinoDe`, `imprimirDestino` (candado por destino) y `render` de main.

## 1. Qué hace

| Antes (1.14.1) | Ahora (1.15.0) |
|---|---|
| Sin internet en el local no sale ningún papel | La caja / el mozo **emparejados con PIN** mandan el papel directo a la PC con LevoPrint por la red del local (`:9120`) |
| Si `print_marcar` fallaba tras imprimir, el servidor podía reentregar el trabajo y salía dos veces | **Diario anti-duplicado** en disco: el mismo papel (`jobId` + estación) no sale dos veces, venga por la LAN o por la nube |
| Estaciones solo en memoria: arrancar sin red = no saber dónde imprimir | La última config de estaciones y destinos (la que baja de la nube) queda en disco |

Archivos: `agente/lib/servidorLan.js` (servidor y reglas de red), `agente/lib/emparejar.js` (PIN y tokens), `agente/lib/diario.js` (diario), enganchados desde `agente/index.js` (bloque `[LP-O02]`). `agente/empaquetar.mjs` junta todo en `dist/levoprint.bundle.js` para el `.exe` (Node SEA no carga archivos sueltos); `build-exe.mjs` lo llama solo.

Datos en `%LOCALAPPDATA%\LevoPrint\` (o la carpeta del `.txt` si no existe):
- `levoprint-diario.jsonl` — diario (7 días).
- `levoprint-equipos.json` — equipos emparejados (solo el **sha256** del token).
- `levoprint-estaciones.json` — última config de estaciones y destinos por app (sin el token del equipo: va una huella).
- El interruptor se guarda en `levoprint.txt` como `LEVO_LAN=1` / `LEVO_LAN=0`.

## 2. Contrato del servidor de la red (`http://<ip-de-la-PC>:9120`)

JSON. Todo menos `hola` y `emparejar` exige `Authorization: Bearer <token>`. Los `POST` exigen `Content-Type: application/json`.

| Ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /v1/hola` | — | `{ok, app:'levoprint', version, equipo, nombre, emparejable}` (`equipo` = nombre de la PC; `nombre` = nombre del vínculo; `emparejable` = interruptor encendido) |
| `POST /v1/emparejar` | `{pin, nombre}` | `200 {ok, token, vence (ISO), equipo:{id,nombre}}` · `401 {error:'PIN_INVALIDO'|'SIN_PIN'|'PIN_ANULADO'}` · `429 {error:'ESPERA', esperaS}` |
| `GET /v1/estado` | — | `{ok, version, nube:boolean, equipo, estaciones:[{id, nombre, app, transporte, listo}]}` |
| `POST /v1/imprimir` | `{jobId, estacion, tipo, payload, reimpresion?, app?}` | ver abajo |
| `POST /v1/prueba` | `{estacion, app?}` | `{ok, via:'LAN'}` o error como en imprimir |
| `GET /v1/diario` | — | `{ok, recientes:[{jobId, estacion, estado, origen, tipo, ts}]}` (50) |

`POST /v1/imprimir`:
- `200 {ok:true, via:'LAN', estado:'IMPRESO', jobId, reimpresion?}` — salió (con `reimpresion:true` si era un reintento de un DUDOSO: salió con sello REIMPRESION).
- `200 {ok:true, via:'LAN', estado:'YA_IMPRESO', jobId}` — ese papel ya había salido (por la LAN o por la nube): no se imprime de nuevo.
- `502 {ok:false, via:'LAN', estado:'DUDOSO', dudoso:true, error:'DUDOSO'}` — falló **después** de empezar a mandar: pudo salir. **Reintentar con el MISMO jobId** (si sale, sale con sello REIMPRESION). Nunca con uno nuevo.
- `502 {ok:false, error:'IMPRESORA_NO_RESPONDE'}` — no salió nada (conexión rechazada, impresora apagada). Reintentar con el mismo jobId sale normal.
- `409 {ok:false, error:'OTRO_EQUIPO'}` — la estación imprime por USB/Bluetooth conectada a **otro** equipo (usar la nube o ese equipo).
- `409 {ok:false, error:'SIN_DESTINO'}` — la estación no tiene impresora utilizable desde esta PC.
- `404 ESTACION_DESCONOCIDA` (LevoPrint nunca vio esa estación: abrirlo una vez con internet) · `400 JOBID_INVALIDO | TIPO_INVALIDO | PAPEL_INVALIDO | JSON_INVALIDO` · `413 MUY_GRANDE` · `415 TIPO_CONTENIDO` · `401 NO_EMPAREJADO` · `423 AGENTE_DESACTIVADO` (la consola desactivó este LevoPrint).

Reglas del contrato:
- `jobId`: 8–80 caracteres `[A-Za-z0-9:_\-.]`, sin prefijo `nube:`. **Un jobId por papel y estación** (KOMO offline: `clienteKey:estacion_id`, igual que `offline_komo`). La dedupe es por `jobId|estacion`.
- `tipo`: `COMANDA | PRECUENTA | TICKET | CPE | CIERRE | TURNO | CARTA_QR` (otro tipo → 400; no se imprime JSON crudo).
- `reimpresion: true` solo **pone el sello**; la dedupe sigue valiendo. Una reimpresión pedida a propósito lleva **jobId nuevo** (como `print_reimprimir`, que quita el jobId del original).
- `app` (opcional, `komo|kipu|kuti`) desambigua si dos apps vinculadas tuvieran el mismo id de estación (son uuid: no debería pasar).
- Ruta de la nube: cuando `print_tomar` trae un trabajo con `payload.jobId` que el diario tiene IMPRESO para esa estación, se llama `print_marcar {ok:true}` **sin imprimir**. Un trabajo sin `payload.jobId` usa la clave `nube:<app>:<id>` (cubre el `print_marcar` perdido: el servidor lo reentrega y no se repite).
- Render: con internet se usa el de la nube (`<app>-print`, 3 s); sin internet, el render local del agente (el mismo que el respaldo de siempre).

### Latido a la nube: `<prefijo>_agente_lan`
En el refresco de config que ya existe (cada 60 s por app), **solo si hay algo que decir**: impresos por la LAN sin reportar, cambio de IP/puerto/interruptor, o 10 min desde el último aviso con el interruptor encendido.
- Pedido: `{device, version:'exe/1.15.0', lan:{ips:[…máx 4 IPv4 privadas], puerto}, impresos:[{clave:<jobId>, estacion, ts ISO}]}`. **Con el interruptor apagado:** `lan:{ips:[], puerto:null}` (se manda una vez al apagar).
- Respuesta esperada: `{ok:true, registrados:[<jobId>…]}` → esos quedan marcados como reportados y no se vuelven a mandar.
- Si la RPC no existe (404 / PGRST202: módulo SQL sin aplicar) se ignora y se reintenta cada 10 min. Lo impreso por la nube no se reporta.

## 3. Seguridad

- **Apagado por defecto.** Solo lo enciende el interruptor de la ventana local (`127.0.0.1:9110`, que ya rechaza Host/Origin ajenos y POST sin JSON: anti CSRF y DNS rebinding de LP-U1) o `LEVO_LAN=1` en `levoprint.txt`.
- **IP de origen**: solo `10/8`, `172.16/12`, `192.168/16` y la misma PC (`127/8`). `100.64/10` (CGNAT, datos móviles), `169.254/16`, IPv6 y públicas → 403 sin cuerpo.
- **Host**: IP literal, `localhost` o `<nombre>.local`. Un dominio (DNS rebinding) → 421.
- **CORS**: solo `https://levodev.app` y `https://*.levodev.app`, con el origen exacto y `Vary: Origin`; **nunca `*`**. `http://` o `levodev.app.evil.com` → 403. `LEVO_ORIGENES` (p. ej. `http://localhost:5173`) solo con `node index.js`: **el `.exe` lo ignora**.
- **Preflight**: `OPTIONS` responde 204 con `Access-Control-Allow-Private-Network: true` (Chrome PNA/LNA) solo a orígenes permitidos.
- **PIN**: 6 dígitos al azar (`crypto.randomInt`), vence a los 10 min, **un solo uso** y rota solo mientras el interruptor está encendido. Freno: 5 fallos por IP → 60 s; tope global 30 fallos/min (frena sin anular: nadie de la red impide emparejar); **50 fallos acumulados anulan el PIN** (se muestra otro). Comparación en tiempo constante.
- **Token**: 32 bytes al azar por equipo, en disco solo su sha256, **vence a los 90 días sin uso** (cada uso lo renueva), se **quita** desde la ventana (efecto inmediato). Máximo 50 equipos.
- **Cuerpo** máx. 64 KB; cabeceras 10 s, pedido 30 s; `Connection: close` (sin keep-alive colgadas; al apagar se cierran todas).
- **Errores sin detalle crudo** (IPs, `ECONNREFUSED`, mensajes de Windows): eso va solo a `levoprint.log`.
- **Desactivado en la consola** (`AGENTE_INVALIDO` en todas las apps): todo menos `/v1/hola` responde 423; si solo una app está desactivada, sus estaciones responden 423.
- LevoPrint no guarda ni recibe certificados, claves SOL ni llaves: el CPE se firma en la nube; aquí solo se imprime papel.

### Riesgo aceptado: HTTP en claro dentro de la red del local
Un equipo conectado a la misma Wi-Fi podría leer un papel o un token en tránsito. Mitigación: solo red privada, token por equipo que vence y se quita, PIN de un uso, y los papeles no llevan secretos (el CPE ya es público en SUNAT). HTTPS local exigiría instalar un certificado a mano en cada navegador de cada equipo. **Recomendación al cliente:** Wi-Fi del local con clave WPA2/WPA3 y red de invitados separada para los clientes.

### Riesgo aceptado: un equipo emparejado es de confianza
Un equipo emparejado puede imprimir en las estaciones de la PC y, si adivina el `jobId` de otro papel (`clienteKey:estación`), hacer que ese papel se dé por impreso (YA_IMPRESO, y se reporta en `agente_lan`). Por eso el PIN solo se ve en la PC del local y cada equipo se puede quitar. **Para el SQL de `agente_lan`:** no usar `registrados` para anular dinero ni CPE; solo para no reencolar papel.

## 4. Firewall de Windows

La primera vez que se enciende el interruptor, Windows pregunta si LevoPrint puede usar la red:
- Marcar **solo «Redes privadas»** (no «Públicas») y **Permitir**.
- La red Wi-Fi/cable del local debe estar como **Privada** (Configuración → Red e Internet → la red → Tipo de perfil de red: Privada). Si está como Pública, el puerto queda bloqueado y la app dirá que no encuentra LevoPrint.
- Regla manual (soporte, PowerShell **como administrador**), solo red privada y solo el puerto 9120–9124:
  ```
  New-NetFirewallRule -DisplayName "LevoPrint sin internet" -Direction Inbound -Protocol TCP -LocalPort 9120-9124 -Profile Private -Action Allow
  ```
- Si alguien pulsó «Cancelar» en el aviso: Panel de control → Firewall de Windows Defender → Permitir una aplicación → LevoPrint → marcar solo **Privada**.

## 5. Pruebas automáticas

`cd agente && npm run prueba` (también en el CI `build-exe.yml`, antes de compilar):
- `prueba_render.cjs` y `prueba_integracion.cjs` de main (siguen verdes; la integración ahora copia `lib/`).
- `prueba_lan.cjs` (103): diario (duplicado, otra estación, DUDOSO→REIMPRESION, FALLO→normal, render fallido, carrera de dos pedidos, corte con ENVIANDO, retención 7 d, archivo corrupto/binario, claves de la nube), emparejar (PIN, fallos por IP, un uso, rotación, anulación a los 50, tope global, vencido a 90 d, quitar, archivo dañado), servidorLan (IP pública/CGNAT, Host, Origin/CORS, preflight PNA, 415, 413, 401, 423, puerto ocupado → siguiente) y el **agente completo** con impresora TCP falsa en 127.0.0.1 (interruptor, PIN, emparejar, imprimir, YA_IMPRESO, OTRO_EQUIPO, impresora apagada, nube que no repite, `agente_lan`, KIPU sin el módulo, **reinicio sin red** con rutas del disco, quitar equipo, apagar) y el **paquete del `.exe`** arrancando solo.

## 6. Guion de prueba física (para Luis)

**Necesitas:** la PC del local con LevoPrint 1.15.0 vinculado a KOMO (y la estación Cocina con impresora elegida: de red o USB en esa PC) · una ticketera · un celular o tablet Android con Chrome (o una segunda PC) en la **misma Wi-Fi**, con KOMO abierto como mozo · acceso al router (o al cable de internet que entra al router). Anota la versión de Chrome del celular.

**A. Encender y emparejar (con internet)**
1. En la PC, abre LevoPrint (la ventana en el navegador). Debe decir *Listo: imprimiendo para KOMO*.
2. En «Imprimir sin internet» pulsa **Encender**. Si Windows pregunta por el firewall: **solo Redes privadas → Permitir** (§4).
3. Debe aparecer un **PIN de 6 dígitos** y la dirección `http://192.168.x.x:9120`. Anótala.
4. En el celular, en KOMO, entra a la opción de emparejar con LevoPrint (la pantalla la hace el equipo del front) y escribe el **PIN**. Si Chrome pide **«Acceso a la red local»**, toca **Permitir**.
5. En la ventana de la PC el equipo aparece en la lista y el PIN cambia (el anterior ya no sirve).
6. Esperado: emparejado. Si falla y dice que no encuentra LevoPrint: revisa §4 (red Privada) y que ambos estén en la misma Wi-Fi.

**B. PIN errado**
1. Desde una segunda pestaña o equipo, intenta emparejar con un PIN **equivocado** 5 veces seguidas.
2. Esperado: «PIN incorrecto» las primeras veces y luego «Demasiados intentos. Espera un minuto.». El PIN de la PC sigue sirviendo para el equipo correcto.

**C. Comanda sin internet**
1. **Desconecta el internet del router** (cable de la calle o el del módem) **dejando la Wi-Fi encendida**. Comprueba en el celular que no abre una web.
2. En KOMO (mozo), toma una comanda para Cocina y envíala.
3. Esperado: sale **un** papel en la ticketera de Cocina en pocos segundos. En la ventana de LevoPrint no aparece error.
4. Repite con una segunda comanda (otra mesa). Debe salir una vez cada una.

**D. Vuelve internet: no se repite**
1. **Reconecta el internet** del router. Espera 2 minutos con KOMO abierto (la bandeja del mozo sube las comandas).
2. Esperado: **no** sale de nuevo ninguna de las comandas del paso C. En `levoprint.log` aparece `[dup] … ese papel ya salio … se marca hecho sin imprimir`.
3. En la app las comandas figuran como impresas (no quedan en cola ni vencidas).

**E. Reinicio del agente sin internet**
1. Desconecta otra vez el internet del router (Wi-Fi encendida).
2. Cierra LevoPrint (la ventana negra) y vuelve a abrirlo.
3. Esperado: la ventana sigue con «Imprimir sin internet» **encendido**, el equipo emparejado en la lista y las estaciones con su impresora (leídas del disco).
4. Manda una comanda desde el celular: **sale**.
5. Reconecta internet y espera 2 min: **no** se repite.

**F. Quitar y apagar**
1. En la ventana, **Quitar** el equipo del celular. Manda una comanda sin internet: la app debe decir que no está emparejado (no sale papel).
2. Pulsa **Apagar** en «Imprimir sin internet». La dirección y el PIN desaparecen.

**Qué anotar si algo falla:** paso y hora, versión de Chrome del celular, si Windows mostró el aviso del firewall y qué se eligió, y manda `levoprint.log` (junto al `.exe` o en `%LOCALAPPDATA%\LevoPrint`).

## 7. Compilar el `.exe`

`cd agente && node build-exe.mjs` (paso 0/3 nuevo: `empaquetar.mjs` → `dist/levoprint.bundle.js`, que es el `main` de `sea-config.json`). El CI `build-exe.yml` (manual) corre las tres pruebas y compila. **No se publica desde esta rama.**

## 8. Qué falta

- **Front** (`core/front/lib/impresora.js` en levodev-modules, otro agente): detección (`/v1/hola`), pantalla de PIN, guardar el token, `jobId` por papel y estación, reintento con el **mismo** jobId ante `DUDOSO`/tiempo agotado, jobId nuevo en reimpresión a propósito, y caer a la nube ante `OTRO_EQUIPO`/`SIN_DESTINO`.
- **SQL** `<prefijo>_agente_lan` (otro agente): guardar IPs/puerto por dispositivo y registrar `impresos` para no reencolar esos papeles (ver la nota de confianza en §3).
- **APK (Android) — no se tocó en esta tanda**; para portarlo: `ServidorLocal.kt` (mismo contrato §2 y mismas reglas §3; NanoHTTPD o `ServerSocket` propio), `Emparejar.kt` (PIN en la pantalla principal, sha256 del token en `EncryptedSharedPreferences`), `Diario.kt` (mismas claves y estados; `Files.move` atómico), interruptor en la pantalla, rutas de estaciones en disco, latido `agente_lan` en el ciclo, `allowBackup=false`; servicio en primer plano para que Android no mate el puerto. La rama `feat/offline-f2` tiene un borrador Kotlin (`ServidorLocal.kt`, `Motor.kt`) **sobre la base vieja**: sirve de guía, no se fusiona.
- iPhone/iPad (Safari) **no** puede imprimir por la LAN desde `https://` (bloquea `http://` a IP privada): solo por la nube. Decirlo en ventas.
- Firma de código del `.exe` (SmartScreen/Defender con el puerto abierto): pendiente de certificado.
