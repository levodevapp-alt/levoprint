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
| `GET /v1/hola` | — | `{ok, app:'levoprint', version, equipo, emparejable}` — exactamente esas claves. `equipo` = nombre de la PC recortado a 15 caracteres; `emparejable` = interruptor encendido, sin bloqueo de PIN **y con un PIN vivo** (solo los 3 min siguientes a tocar «Emparejar equipo» en la PC; QA MEDIO-1: fuera de esa ventana es `false`, y la app no debe leerlo como «LevoPrint no está»). **No** devuelve el nombre del local (no exige token: QA BAJO-2) |
| `POST /v1/emparejar` | `{pin, nombre}` | `200 {ok, token, vence (ISO), equipo:{id,nombre}}` · `401 {error:'PIN_INVALIDO'|'SIN_PIN'|'PIN_VENCIDO'|'PIN_ANULADO', esperaS?}` · `429 {error:'ESPERA', esperaS}` · `423 {error:'PIN_BLOQUEADO', esperaS, acumulado?, mensaje}` (tras 50 errados contra un PIN, o con `acumulado:true` tras muchos errados entre PINs; ver §3). **Nuevo (QA MEDIO-1):** `PIN_VENCIDO` = el PIN pasó sus 3 min sin usarse (el front: «Ese PIN venció; en la PC toca Emparejar equipo»); `SIN_PIN` = nadie tocó «Emparejar equipo» (o el PIN ya se usó / se apagó el interruptor) |
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
- `tipo`: **solo** `COMANDA | PRECUENTA | TICKET | PRUEBA` (QA MEDIO-2). `CPE`, `CIERRE`, `TURNO`, `CARTA_QR` o cualquier otro → `400 TIPO_INVALIDO`. Motivo: un equipo emparejado podría imprimir un comprobante o un cierre de caja con un payload inventado; esos papeles salen **solo por la nube** (los arma el servidor). El front debe mandar por la LAN solo esos cuatro tipos y todo lo demás por la nube.
- `reimpresion: true` solo **pone el sello**; la dedupe sigue valiendo. Una reimpresión pedida a propósito lleva **jobId nuevo** (como `print_reimprimir`, que quita el jobId del original).
- `app` (opcional, `komo|kipu|kuti`) desambigua si dos apps vinculadas tuvieran el mismo id de estación (son uuid: no debería pasar).
- Ruta de la nube: cuando `print_tomar` trae una **COMANDA o PRECUENTA** con `payload.jobId` que el diario tiene IMPRESO para esa estación, se llama `print_marcar {ok:true}` **sin imprimir**. Cualquier otro tipo (`TICKET`, `CPE`, `CIERRE`, `TURNO`…) **se imprime siempre** aunque traiga un `jobId` conocido (QA MEDIO-2: la LAN no puede "tapar" un papel de dinero adelantando su jobId); para esos, y para los trabajos sin `payload.jobId`, la clave es `nube:<app>:<id>` (el id del trabajo en la nube, que la LAN no controla: cubre solo el `print_marcar` perdido, en que el servidor reentrega el **mismo** trabajo).
- Render: con internet se usa el de la nube (`<app>-print`, 3 s); sin internet, el render local del agente (el mismo que el respaldo de siempre).

### Latido a la nube: `<prefijo>_agente_lan`
En el refresco de config que ya existe (cada 60 s por app), **solo si hay algo que decir**: impresos por la LAN sin reportar, cambio de IP/puerto/interruptor, o 10 min desde el último aviso con el interruptor encendido.
- Pedido: `{device, version:'exe/1.15.0', lan:{ips:[…máx 4 IPv4 privadas], puerto}, impresos:[{clave:<jobId>, estacion, ts ISO}]}` (máx. 100, **los más recientes primero**). **Con el interruptor apagado:** `lan:{ips:[], puerto:null}` — se manda una vez al apagar y una vez en cada arranque con el interruptor apagado (limpia una IP vieja que haya quedado en la nube); el SQL lo acepta y borra la IP del dispositivo.
- Respuesta (QA MEDIO-1), se aceptan las dos formas:
  - **Detallada por estación** (preferida): `registrados_det` / `rechazados_det` = `[{clave, estacion, motivo?}]` (o pares `[clave, estacion]`). La marca es **por fila (clave, estación)**: un mismo jobId puede quedar registrado en una estación y rechazado en otra.
  - **Compatible**: `registrados` / `rechazados` = `[<jobId>…]`. Si de un tipo solo viene la lista de claves, se marcan **todas las filas de ese lote** con esa clave (no las que no se mandaron). Si una clave viene en las dos listas, gana registrado.
  - Registrado → `r:true` en el diario; rechazado → `r:'rechazado'`: **ninguno de los dos se vuelve a mandar nunca**.
  - Tope: cada fila cuenta un envío por latido con respuesta (incluida `ok:false`); a los **20 envíos** sin quedar registrada ni rechazada deja de mandarse (sin marcarse registrada). La basura vieja no tapa lo nuevo (orden por más reciente y tope).
- Si la RPC no existe (404 / PGRST202: módulo SQL sin aplicar) se ignora y se reintenta cada 10 min (no cuenta envíos). Lo impreso por la nube no se reporta.

## 3. Seguridad

- **Apagado por defecto.** Solo lo enciende el interruptor de la ventana local (`127.0.0.1:9110`, que ya rechaza Host/Origin ajenos y POST sin JSON: anti CSRF y DNS rebinding de LP-U1) o `LEVO_LAN=1` en `levoprint.txt`.
- **IP de origen**: solo `10/8`, `172.16/12`, `192.168/16` y la misma PC (`127/8`). `100.64/10` (CGNAT, datos móviles), `169.254/16`, IPv6 y públicas → 403 sin cuerpo.
- **Host**: IP literal, `localhost` o `<nombre>.local`. Un dominio (DNS rebinding) → 421.
- **CORS**: solo `https://levodev.app` y `https://*.levodev.app`, con el origen exacto y `Vary: Origin`; **nunca `*`**. `http://` o `levodev.app.evil.com` → 403. `LEVO_ORIGENES` (p. ej. `http://localhost:5173`) solo con `node index.js`: **el `.exe` lo ignora**.
- **Preflight**: `OPTIONS` responde 204 con `Access-Control-Allow-Private-Network: true` (Chrome PNA/LNA) solo a orígenes permitidos.
- **PIN** (QA MEDIO-1): **no existe de forma permanente**. Solo se genera cuando alguien en la PC toca **«Emparejar equipo»** en la ventana local; son 6 dígitos al azar (`crypto.randomInt`), **valen 3 minutos**, sirven **una sola vez** y hay **uno a la vez** (pedir otro reemplaza al anterior). Al usarse o vencer **no se genera otro solo** (tampoco al encender el interruptor ni al arrancar LevoPrint): fuera de esa ventana `/v1/emparejar` responde `SIN_PIN` o `PIN_VENCIDO` y `/v1/hola` dice `emparejable:false`. Así no hay un PIN vivo las 24 h al que gotearle intentos.
- **Freno contra adivinar**: 5 fallos por IP → 60 s; tope global 30 fallos/min (frena sin anular el PIN); **50 fallos contra el mismo PIN lo anulan y bloquean el emparejamiento** (QA MEDIO-3): durante **10 min** no hay PIN (`/v1/emparejar` → `423 PIN_BLOQUEADO`, «Otro PIN» se niega); pasados los 10 min **no se genera otro solo** (ni apagando y encendiendo el interruptor): alguien en la PC tiene que pulsar **«Otro PIN»**.
- **Contador acumulado entre PINs** (QA MEDIO-1, contra el goteo «pocos intentos por PIN, muchos PIN»): cada PIN errado suma a un contador que **no se reinicia al pedir otro PIN**. Al llegar a **100 fallos en 1 h, 200 en 24 h o 500 en 7 días** → **bloqueado** (`423 PIN_BLOQUEADO` con `acumulado:true`) **hasta que alguien pulse «Otro PIN»** en la ventana, que muestra en rojo: «Alguien intentó muchos PIN. Emparejamiento bloqueado: toca «Otro PIN» si eres tú.». «Emparejar equipo» no lo levanta (solo «Otro PIN», a propósito); al levantarlo se limpia el contador. Contador y bloqueo (también el de 10 min) se **guardan en disco** (`levoprint-equipos.json`, junto a los equipos): **reiniciar LevoPrint no los borra**. Solo cuentan los intentos contra un PIN vivo (sin PIN no hay nada que adivinar). Probabilidad máxima de acertar por goteo: < 500 / 1 000 000 por semana, y solo dentro de los 3 min que alguien abrió a propósito. Comparación en tiempo constante.
- **DoS menor aceptado**: el tope global (30/min), el bloqueo por anulación y el acumulado los puede provocar cualquier equipo de la red del local rotando IPs. Solo impiden **emparejar equipos nuevos** un rato; los ya emparejados siguen imprimiendo con su token. Lo preferimos a dejar adivinar el PIN; con Wi-Fi de invitados separada (ver abajo) el riesgo baja.
- **Token**: 32 bytes al azar por equipo, en disco solo su sha256, **vence a los 90 días sin uso** (cada uso lo renueva), se **quita** desde la ventana (efecto inmediato). Máximo 50 equipos.
- **Cuerpo** máx. 64 KB; cabeceras 10 s, pedido 30 s; `Connection: close` (sin keep-alive colgadas; al apagar se cierran todas).
- **Errores sin detalle crudo** (IPs, `ECONNREFUSED`, mensajes de Windows): eso va solo a `levoprint.log`.
- **Desactivado en la consola** (`AGENTE_INVALIDO` en todas las apps): todo menos `/v1/hola` responde 423; si solo una app está desactivada, sus estaciones responden 423.
- LevoPrint no guarda ni recibe certificados, claves SOL ni llaves: el CPE se firma en la nube; aquí solo se imprime papel.

### Riesgo aceptado: HTTP en claro dentro de la red del local
Un equipo conectado a la misma Wi-Fi podría leer un papel o un token en tránsito. Mitigación: solo red privada, token por equipo que vence y se quita, PIN de un uso, y los papeles no llevan secretos (el CPE ya es público en SUNAT). HTTPS local exigiría instalar un certificado a mano en cada navegador de cada equipo. **Recomendación al cliente:** Wi-Fi del local con clave WPA2/WPA3 y red de invitados separada para los clientes.

### Riesgo aceptado: un equipo emparejado es de confianza
Un equipo emparejado puede imprimir comandas, precuentas, tickets y la prueba en las estaciones de la PC y, si adivina el `jobId` de otra **comanda o precuenta** (`clienteKey:estación`), hacer que ese papel se dé por impreso (YA_IMPRESO, y se reporta en `agente_lan`). No puede imprimir CPE ni cierres por la LAN, ni tapar un TICKET/CPE/CIERRE de la nube (QA MEDIO-2). Por eso el PIN solo se ve en la PC del local y cada equipo se puede quitar. **Para el SQL de `agente_lan`:** no usar `registrados` para anular dinero ni CPE; solo para no reencolar papel.

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
- `prueba_lan.cjs` (155; QA MEDIO-1 con reloj simulado: sin «Emparejar equipo» no hay PIN, el PIN vence a los 3 min → `PIN_VENCIDO`, uno a la vez, **goteo de 7 días** de 4 intentos por PIN —un PIN cada 10 min y cada 30 min, con reinicio diario— termina **BLOQUEADO acumulado**, 100 fallos en 1 h → bloqueado, el bloqueo **sobrevive a reiniciar**, «Emparejar equipo» no lo levanta y «Otro PIN» sí, archivo con basura): diario (duplicado, otra estación, DUDOSO→REIMPRESION, FALLO→normal, render fallido, carrera de dos pedidos, corte con ENVIANDO, retención 7 d, archivo corrupto/binario, claves de la nube solo COMANDA/PRECUENTA, **registrado/rechazado por (clave, estación)**, forma compatible por lote, orden más reciente primero, tope de 20 envíos, «rechazado» tras reinicio), emparejar (PIN, fallos por IP, un uso, rotación, anulación a los 50, **bloqueo 10 min y «Otro PIN» a mano**, tope global, vencido a 90 d, quitar, archivo dañado), servidorLan (IP pública/CGNAT, Host, Origin/CORS, preflight PNA, `/v1/hola` sin nombre del local, 415, 413, 401, 423, `423 PIN_BLOQUEADO`, puerto ocupado → siguiente) y el **agente completo** con impresora TCP falsa en 127.0.0.1 (latido apagado al arrancar, interruptor, PIN, emparejar, imprimir, YA_IMPRESO, OTRO_EQUIPO, impresora apagada, **CPE/CIERRE/TURNO/CARTA_QR por la LAN → 400**, PRECUENTA y PRUEBA por la LAN, nube que no repite comandas, **TICKET de la nube con jobId conocido sí sale**, `agente_lan`, **rechazado no se reenvía**, KIPU sin el módulo, **apagar → `lan:{ips:[],puerto:null}`** y volver a encender, **reinicio sin red** con rutas del disco, quitar equipo, apagar) y el **paquete del `.exe`** arrancando solo.

## 6. Guion de prueba física (para Luis)

**Necesitas:** la PC del local con LevoPrint 1.15.0 vinculado a KOMO (y la estación Cocina con impresora elegida: de red o USB en esa PC) · una ticketera · un celular o tablet Android con Chrome (o una segunda PC) en la **misma Wi-Fi**, con KOMO abierto como mozo · acceso al router (o al cable de internet que entra al router). Anota la versión de Chrome del celular.

**A. Encender y emparejar (con internet)**
1. En la PC, abre LevoPrint (la ventana en el navegador). Debe decir *Listo: imprimiendo para KOMO*.
2. En «Imprimir sin internet» pulsa **Encender**. Si Windows pregunta por el firewall: **solo Redes privadas → Permitir** (§4).
3. Debe aparecer la dirección `http://192.168.x.x:9120` (anótala) y **ningún PIN** (`------`): el PIN ya no está siempre a la vista.
4. Toca **«Emparejar equipo»**: aparece un **PIN de 6 dígitos** con «vence en 3:00». **Tienes 3 minutos** para escribirlo en el celular.
5. En el celular, en KOMO, entra a la opción de emparejar con LevoPrint (la pantalla la hace el equipo del front) y escribe el **PIN**. Si Chrome pide **«Acceso a la red local»**, toca **Permitir**.
6. En la ventana de la PC el equipo aparece en la lista y el PIN desaparece (`------`): para otro equipo, vuelve a tocar «Emparejar equipo».
7. Esperado: emparejado. Si falla y dice que no encuentra LevoPrint: revisa §4 (red Privada) y que ambos estén en la misma Wi-Fi.

**B. PIN errado y PIN vencido**
1. Toca «Emparejar equipo». Desde una segunda pestaña o equipo, intenta emparejar con un PIN **equivocado** 5 veces seguidas.
2. Esperado: «PIN incorrecto» las primeras veces y luego «Demasiados intentos. Espera un minuto.». El PIN de la PC sigue sirviendo para el equipo correcto (si no pasaron los 3 min).
3. Toca «Emparejar equipo», **espera más de 3 minutos** sin usarlo y escríbelo en el celular. Esperado: la ventana vuelve a `------` y la app dice que el PIN **venció** (`PIN_VENCIDO`).
4. (No hace falta reproducir a mano los bloqueos —10 min tras 50 errados contra un PIN, o el acumulado de 100/h, 200/24 h, 500/7 días—: los cubren las pruebas automáticas con reloj simulado. Si alguna vez la ventana muestra en rojo «Alguien intentó muchos PIN. Emparejamiento bloqueado: toca «Otro PIN» si eres tú.», es eso: si fuiste tú o ya lo revisaste, toca **Otro PIN**. Ese aviso sigue aunque cierres y abras LevoPrint.)

**B2. Equipo nuevo sin datos del local**
1. Desde el navegador de la PC abre `http://127.0.0.1:9120/v1/hola`.
2. Esperado: solo `ok`, `app`, `version`, `equipo` (nombre corto de la PC) y `emparejable`. **No** aparece el nombre del local.

**C. Comanda sin internet**
1. **Desconecta el internet del router** (cable de la calle o el del módem) **dejando la Wi-Fi encendida**. Comprueba en el celular que no abre una web.
2. En KOMO (mozo), toma una comanda para Cocina y envíala.
3. Esperado: sale **un** papel en la ticketera de Cocina en pocos segundos. En la ventana de LevoPrint no aparece error.
4. Repite con una segunda comanda (otra mesa). Debe salir una vez cada una.
5. Intenta **cobrar y emitir una boleta** sin internet. Esperado: la boleta **no** sale por la red del local (la app la deja para cuando vuelva internet; por la LAN solo salen comanda, precuenta, ticket y prueba).

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
2. Pulsa **Apagar** en «Imprimir sin internet». La dirección y el PIN desaparecen. Con internet, en un minuto la app deja de ofrecer la impresión por la red (la nube borró la IP).

**Qué anotar si algo falla:** paso y hora, versión de Chrome del celular, si Windows mostró el aviso del firewall y qué se eligió, y manda `levoprint.log` (junto al `.exe` o en `%LOCALAPPDATA%\LevoPrint`).

## 7. Compilar el `.exe`

`cd agente && node build-exe.mjs` (paso 0/3 nuevo: `empaquetar.mjs` → `dist/levoprint.bundle.js`, que es el `main` de `sea-config.json`). El CI `build-exe.yml` (manual) corre las tres pruebas y compila. **No se publica desde esta rama.**

## 8. Qué falta

- **Front** (`core/front/lib/impresora.js` en levodev-modules, otro agente): detección (`/v1/hola`; `emparejable:false` es lo normal fuera de los 3 min del PIN), pantalla de PIN (texto para `PIN_VENCIDO`, nuevo, y `SIN_PIN`: «en la PC toca Emparejar equipo»; `PIN_BLOQUEADO` con `acumulado:true`), guardar el token, `jobId` por papel y estación, reintento con el **mismo** jobId ante `DUDOSO`/tiempo agotado, jobId nuevo en reimpresión a propósito, y caer a la nube ante `OTRO_EQUIPO`/`SIN_DESTINO`.
- **SQL** `<prefijo>_agente_lan` (otro agente): guardar IPs/puerto por dispositivo y registrar `impresos` para no reencolar esos papeles (ver la nota de confianza en §3).
- **APK (Android) — no se tocó en esta tanda**; para portarlo: `ServidorLocal.kt` (mismo contrato §2 y mismas reglas §3; NanoHTTPD o `ServerSocket` propio), `Emparejar.kt` (PIN en la pantalla principal, sha256 del token en `EncryptedSharedPreferences`), `Diario.kt` (mismas claves y estados; `Files.move` atómico), interruptor en la pantalla, rutas de estaciones en disco, latido `agente_lan` en el ciclo, `allowBackup=false`; servicio en primer plano para que Android no mate el puerto. La rama `feat/offline-f2` tiene un borrador Kotlin (`ServidorLocal.kt`, `Motor.kt`) **sobre la base vieja**: sirve de guía, no se fusiona.
- **Nota (QA BAJO-5):** el **APK aún no tiene diario anti-duplicado ni servidor `:9120`**. Hoy un celular/tablet Android con el APK como agente **solo imprime por la nube**; la impresión sin internet y la protección contra papeles repetidos de esta tanda existen solo en el `.exe` de Windows. Al portarlo, el `Emparejar.kt` debe traer también lo de QA MEDIO-1 (PIN solo tras «Emparejar equipo», 3 min, contador acumulado en disco).
- iPhone/iPad (Safari) **no** puede imprimir por la LAN desde `https://` (bloquea `http://` a IP privada): solo por la nube. Decirlo en ventas.
- Firma de código del `.exe` (SmartScreen/Defender con el puerto abierto): pendiente de certificado.
