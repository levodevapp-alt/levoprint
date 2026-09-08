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

⚡ by LevoDev · levodev.app
