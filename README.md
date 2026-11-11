# ⚡ LevoPrint

Gestor de impresoras **genérico** de LevoDev — el mismo cerebro que el agente `.exe`, en Android.
Un celular o PC en la misma red que las impresoras recibe los trabajos desde la nube y los
imprime por **TCP a la impresora ESC/POS (:9100)**. Sirve para **todas las apps de LevoDev**
(KOMO y las que vengan) cambiando el *prefijo* de la config.

## Instalación en 3 pasos
Todas las apps de LevoDev (KOMO, KIPU, KUTI y las que vengan) imprimen **solo con LevoPrint**, en PC, celular o tablet.

**En PC (Windows · `.exe` 1.13)**
1. **Descarga** LevoPrint desde tu app (KOMO › Estaciones, KIPU › Impresoras o KUTI › Impresoras).
2. **Ábrelo** (doble clic). Si Windows avisa «Windows protegió tu PC»: *Más información → Ejecutar de todas formas*.
3. **Escribe el código** de 9 caracteres que ves en tu app (empieza con K, P o T) y pulsa **Vincular**. Sale un papel de prueba: listo.
   - Si el archivo descargado ya trae el código en el nombre (p. ej. `LevoPrint-K7ABCD234.exe`), se vincula solo al abrirlo.
   - Al vincular, LevoPrint queda en el **arranque de Windows** (acceso directo en la carpeta Inicio del usuario, sin permisos de administrador). Se quita desde la ventana: *Ajustes › Abrir solo al encender la PC › Quitar*. Ya no hacen falta `instalar-inicio.bat` ni `quitar-inicio.bat`.
   - **Varias apps en la misma PC:** escribe el código de cada app en la misma ventana. Un solo LevoPrint atiende a todas. Si abres otra copia del programa con otro código, se lo pasa al LevoPrint que ya está abierto y se cierra.
   - No hay que editar ningún archivo: el programa ya trae la dirección del servidor. `levoprint.txt` (junto al `.exe`, o en `%LOCALAPPDATA%\LevoPrint` si esa carpeta es de solo lectura) lo escribe el propio programa y sigue sirviendo para ajustes manuales (`LEVO_URL`, `LEVO_ANON`, `LEVO_MODO=consola`, `LEVO_IMAGEN=0`). La config vieja de un solo vínculo (`LEVO_DEVICE` + `LEVO_PREFIJO`) se migra sola a `LEVO_VINCULOS`.

**En celular o tablet (Android · APK 1.7.0)**
1. **Descarga** el APK desde tu app e instálalo (permite «orígenes desconocidos»).
2. **Ábrelo** y pulsa **Permitir** en el aviso de ahorro de batería.
3. **Escribe el código** (o **Escanear QR**, o el botón «Abrir en LevoPrint» de tu app) y pulsa **Vincular**. Para otra app, repite con su código: el equipo imprime para todas.

### ¿Dónde está la impresora? (LP-F3/F4 · `.exe` 1.13 · APK 1.7.0)
Cada estación (Cocina, Caja…) tiene **su** impresora, que puede ser de **red**, **Bluetooth** o **USB**:
- LevoPrint **busca solo** las impresoras: al abrirse, al vincular, cada 15 min, cuando la app lo pide («Buscar impresoras» en la consola) y con **Buscar de nuevo**.
  - Red: las impresoras con el puerto 9100 abierto en la red del equipo (sin mandarles nada).
  - PC: además, las impresoras **instaladas en Windows** (USB o Bluetooth instalada como impresora). Se les manda el ticket en RAW por la cola de Windows. Las de PDF, XPS, Fax y OneNote no salen.
  - Android: además, las **Bluetooth** emparejadas (y, con «Buscar de nuevo», las cercanas: al tocarla se empareja; PIN 0000 o 1234) y las **USB** por cable OTG.
- Tras vincular, la ventana (PC) o la pantalla (Android) pregunta **«¿Dónde está la impresora de <estación>?»**: tocas una → sale un papel de prueba → **¿Salió?** → **Sí** y queda guardada en la app. **No la veo** muestra consejos y deja escribir la IP a mano.
- La lista de lo encontrado se manda a la app cuando cambia y, aunque no cambie, **al menos cada 20 min** (la app solo deja que un equipo tome los trabajos de una impresora Bluetooth/USB sin dueño activo si la informó en los últimos 30 min).
- Una impresora Bluetooth o USB es **de un equipo**: los trabajos de esa estación solo los imprime ese equipo (si otro los recibe, se marcan `IMPRESORA_EN_OTRO_EQUIPO`).
- **App sin actualizar** (sin `<app>_agente_impresoras`): LevoPrint sigue como antes (solo IP; en Android también la impresora Bluetooth general) por 30 min y, al elegir, dice «Escribe esta IP en tu consola de … ».
- **USB en Windows bloqueado** (PowerShell restringido por la empresa o el antivirus): la ventana lo avisa y quedan las de red.
- **KOMO Agente (programa antiguo):** si `komo-agente.txt` está en la misma carpeta, LevoPrint toma su vínculo solo. Si KOMO Agente sigue abierto o se abre al encender la PC, la ventana ofrece **Cerrar y quitar KOMO Agente** (solo con KOMO ya vinculado en LevoPrint).

### Pruebas (sin Supabase ni impresoras)
- `node agente/prueba_render.cjs` — render local del `.exe`.
- `node agente/prueba_integracion.cjs` — el agente contra `agente/mock_rpc.cjs` (PostgREST falso), dos impresoras falsas en 127.0.0.1/127.0.0.2 y `agente/doble_powershell.cjs` en vez de PowerShell: búsqueda, elegir, impresión por transporte, modo 1.12, guardas 403, USB colgado/restringido, `komo-agente.txt`. Los ajustes de prueba (`LEVO_BUSCAR_SUBRED`, `LEVO_BUSCAR_PUERTO`, `LEVO_PRUEBA_PS`, `LEVO_PRUEBA_PS_TIEMPO`, `LEVO_PRUEBA_CONFIG_MS`) solo valen con `node index.js`; el `.exe` los ignora.
- APK: `gradle testReleaseUnitTest` (render y `BusquedaLogicaTest`). El CI los corre antes de compilar.

### Pendientes (LP-U1)
- **Quitar vínculo** desde la interfaz (ventana del `.exe` y APK): hoy un vínculo solo se reemplaza con un código nuevo de la misma app; para quitar una app hay que editar `LEVO_VINCULOS` en `levoprint.txt` (PC) o borrar los datos de la app (Android).
- Las apps aún deben entregar el `.exe` con el código en el nombre (`LevoPrint-<código>.exe`) para el vínculo automático.

## Cómo funciona
- Config de emparejamiento: una lista de vínculos `{prefijo (app), device}` (más `URL backend · anon key`, que ya vienen dentro del programa) y un `ancho`.
- Bucle (para cada vínculo): `<prefijo>_agente_config` (estaciones) → `<prefijo>_agente_impresoras` (destino de cada estación, cada minuto) → `<prefijo>_print_tomar` (trabajos) →
  imprime ESC/POS en el destino de la estación (red `ip:9100`, Bluetooth o USB) → `<prefijo>_print_marcar`.
- Servicio en primer plano (sigue imprimiendo con la pantalla apagada).
- Impresora Bluetooth general (APK, de la 1.6): sigue como respaldo para estaciones de red sin IP; lo nuevo es elegir la Bluetooth **por estación**.

## Publicar (QA LP-F3 · ALTO 1 · RT-1)
Un merge o un push a `main` **no publica**. Este repo es **público**: el CI **no tiene ni usa** llaves de Supabase (RT-1, 11-nov). **Nunca** cargues `SUPABASE_SERVICE_KEY` (ni otra llave de servicio) como secret de este repo.
1. GitHub → *Actions* → *build-apk* (escribe las **notas** de la versión) y *build-exe* → **Run workflow** en `main` → verifica que salgan en **verde**.
   - *build-apk* arma y **valida** `LevoPrint.json` (`{versionCode, versionName, url, notas}`, versión leída de `app/build.gradle.kts`); el artifact `LevoPrint-apk` trae el APK y ese JSON.
   - *build-exe* deja el artifact `LevoPrint-exe` con el `.exe` y `LevoPrint-Windows.zip`.
2. Publica **desde tu PC** (la llave se lee de un `.env` local, fuera de cualquier repo, y nunca se imprime):
   ```
   gh run download <run_build-apk> -n LevoPrint-apk -D out/apk
   gh run download <run_build-exe> -n LevoPrint-exe -D out/exe
   node tools/publicar_bucket.mjs out/apk out/exe --seco
   node --env-file=<.env fuera del repo> tools/publicar_bucket.mjs out/apk out/exe
   ```
   El script valida `LevoPrint.json` contra `app/build.gradle.kts` (si no coincide no sube nada) y sube el APK, luego el JSON y luego el ZIP.

### Aviso de actualización (APK 1.7.0)
El APK lee `descargas/levoprint/LevoPrint.json` (URL pública del bucket) al abrir la pantalla (como mucho cada 5 min) y cada 12 h desde el servicio. Si `versionCode` es mayor que el suyo (`Agent.VERSION_CODE`, igual al de `app/build.gradle.kts`; una prueba lo comprueba), muestra la tarjeta **«Hay una versión nueva de LevoPrint (X)» → Actualizar** y una notificación (una vez por versión). «Actualizar» abre la URL del APK en el navegador: se descarga y se instala encima, sin perder la vinculación. Solo acepta URLs de las descargas de LevoDev (bucket `descargas/levoprint/` o `archivos.levodev.app/descargas/levoprint/`). Sin internet o con un JSON inválido no avisa nada y nunca frena la impresión; no pide permisos nuevos.

## El APK
Se compila solo en **GitHub Actions** (pestaña *Actions* → último run → *Artifacts* →
`LevoPrint-debug-apk`). Se instala por *sideload* (activar "orígenes desconocidos").

> **Ahorro de batería y Play Store (MM4-07).** El APK declara `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` para
> pedir quedar fuera del ahorro de batería (si no, Xiaomi/Samsung/Huawei/Motorola duermen el servicio y
> la cocina no recibe comandas). Se instala desde el bucket, no desde Play, así que la política de Play
> no aplica. **Si algún día va a Play Store:** quitar ese permiso o moverlo a un *flavor* «bucket»
> (Play solo lo acepta para casos puntuales y puede rechazar la app); la tarjeta de MainActivity cae sola
> a la lista general de Ajustes si el diálogo directo no está.

⚡ by LevoDev · levodev.app

## Dos formas, un mismo cerebro
- **APK (Android)** — carpeta `app/`. CI: workflow *build-apk* → artifact `LevoPrint-debug-apk`.
- **.exe (Windows/PC)** — carpeta `agente/` (Node SEA). CI: workflow *build-exe* → artifact `LevoPrint-exe`.
Ambos son **genéricos**: el mismo binario sirve para cualquier app de LevoDev cambiando el *prefijo* (`komo`, etc.).

## Pie de marca y comanda (MM3-01 · MM3-P1)
- El pie de los tickets lleva el isotipo de LevoDev en 1 bit (`GS v 0`, 64x64) + «Hecho con KOMO|KIPU|KUTI - levodev.app» + el lema «Tu negocio, inteligente y bajo control.». El ticket sigue siendo del negocio del cliente; la comanda no lleva marca (MESA enorme, ítems en doble alto).
- Impresora sin soporte de imagen: **APK 1.7.0** → Opciones avanzadas › «Pie con logo» (apagado = solo texto); **.exe 1.13** → ajuste «Pie con logo» de la ventana o `LEVO_IMAGEN=0` en `levoprint.txt`. El papel de prueba lleva el pie para verlo.
- El mapa de bits es el mismo en los 6 render (`levodev-modules/tools/marca/isotipo_termico.mjs --check`).

### Probar la impresora: ¿sale basura donde va el logo?
El papel **PRUEBA** (botón «Imprimir prueba» del .exe, y el papel que sale al vincular el APK) trae el pie con el logo. Si sale basura o signos raros, tu impresora no imprime imágenes: apágalo con **`LEVO_IMAGEN=0`** en `levoprint.txt` (o el botón «Pie con logo» de la ventana del .exe) o con el interruptor **«Pie con logo»** de Opciones avanzadas del APK. En modo consola el logo se muestra como «[logo]».
