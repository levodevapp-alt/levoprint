# ⚡ LevoPrint

Gestor de impresoras **genérico** de LevoDev — el mismo cerebro que el agente `.exe`, en Android.
Un celular o PC en la misma red que las impresoras recibe los trabajos desde la nube y los
imprime por **TCP a la impresora ESC/POS (:9100)**. Sirve para **todas las apps de LevoDev**
(KOMO y las que vengan) cambiando el *prefijo* de la config.

## Cómo funciona
- Config de emparejamiento: `URL backend · anon key · device · prefijo (app) · ancho`.
- Bucle: `<prefijo>_agente_config` (estaciones) → `<prefijo>_print_tomar` (trabajos) →
  imprime ESC/POS por socket a `ip:9100` → `<prefijo>_print_marcar`.
- Servicio en primer plano (sigue imprimiendo con la pantalla apagada).
- Impresora Bluetooth: opción en la config (en desarrollo; el transporte base es LAN).

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
- Impresora sin soporte de imagen: **APK 1.5.0** → Opciones avanzadas › «Pie con logo» (apagado = solo texto); **.exe 1.11** → botón «Pie con logo» de la ventana o `LEVO_IMAGEN=0` en `levoprint.txt`. El papel de prueba lleva el pie para verlo.
- El mapa de bits es el mismo en los 6 render (`levodev-modules/tools/marca/isotipo_termico.mjs --check`).

### Probar la impresora: ¿sale basura donde va el logo?
El papel **PRUEBA** (botón «Imprimir prueba» del .exe, y el papel que sale al vincular el APK) trae el pie con el logo. Si sale basura o signos raros, tu impresora no imprime imágenes: apágalo con **`LEVO_IMAGEN=0`** en `levoprint.txt` (o el botón «Pie con logo» de la ventana del .exe) o con el interruptor **«Pie con logo»** de Opciones avanzadas del APK. En modo consola el logo se muestra como «[logo]».
