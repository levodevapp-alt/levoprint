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

## Dos formas, un mismo cerebro
- **APK (Android)** — carpeta `app/`. CI: workflow *build-apk* → artifact `LevoPrint-debug-apk`.
- **.exe (Windows/PC)** — carpeta `agente/` (Node SEA). CI: workflow *build-exe* → artifact `LevoPrint-exe`.
Ambos son **genéricos**: el mismo binario sirve para cualquier app de LevoDev cambiando el *prefijo* (`komo`, etc.).

## F2 · Impresión sin internet (red del local) y USB
Desde la 1.8 (.exe) y el APK con F2, LevoPrint también escucha en la **red del local**
(`http://<ip>:9120`): la caja y los mozos imprimen aunque se caiga el internet, sin que
ningún papel salga dos veces al volver (diario por `jobId`). Suma **USB** (cola de Windows
en PC, OTG en Android) y el asistente **Buscar impresoras** (USB, red, Bluetooth).
Diseño, seguridad, compilación y la **prueba obligatoria con hardware real**:
[`docs/F2_IMPRESION_LOCAL.md`](docs/F2_IMPRESION_LOCAL.md).
