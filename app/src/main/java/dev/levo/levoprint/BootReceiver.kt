package dev.levo.levoprint

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

// Tras reinicio o actualizacion: si hay configuracion guardada, el servicio de
// impresion vuelve solo. Un gestor de impresoras que no sobrevive un corte de
// luz no es un gestor de impresoras.
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent?) {
    try {
      if (Prefs.leer(ctx) == null) return
      val i = Intent(ctx, PrintService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
    } catch (_: Throwable) {}
  }
}
