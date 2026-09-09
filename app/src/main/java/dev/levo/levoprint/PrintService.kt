package dev.levo.levoprint

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

// Servicio en primer plano: mantiene vivo el bucle de impresion aunque
// la pantalla se apague (celular dedicado, enchufado en la red del local).
class PrintService : Service() {
  @Volatile private var corriendo = false
  private var hilo: Thread? = null
  private var wake: PowerManager.WakeLock? = null

  companion object {
    const val CANAL = "levoprint"
    @Volatile var activo = false
    @Volatile var ultimoLog = "Detenido"
  }

  override fun onBind(i: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (corriendo) return START_STICKY
    val cfg = Prefs.leer(this) ?: run { stopSelf(); return START_NOT_STICKY }
    arrancarForeground()
    corriendo = true
    activo = true
    wake = (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "levoprint:loop").also { it.acquire() }
    hilo = Thread { bucle(cfg) }.also { it.isDaemon = true; it.start() }
    return START_STICKY
  }

  private fun bucle(cfg: Cfg) {
    var estaciones: Map<String, Estacion> = emptyMap()
    var ciclo = 0
    while (corriendo) {
      try {
        if (ciclo++ % 30 == 0) {
          estaciones = Agent.estaciones(cfg)
          ultimoLog = "Config: " + estaciones.size + " estaciones"
        }
        val jobs = Agent.tomar(cfg)
        for (i in 0 until jobs.length()) {
          val job = jobs.getJSONObject(i)
          val id = job.optString("id")
          try {
            val est = estaciones[job.optString("estacion")]
            val texto = Agent.render(job, cfg.ancho)
            val btMac = Prefs.getBtMac(this)
            when {
              est?.ip != null -> { Agent.imprimirTcp(est.ip, est.puerto, texto); ultimoLog = "OK " + job.optString("tipo") + " -> " + est.nombre }
              Prefs.getBluetooth(this) && btMac.isNotBlank() -> { Bt.imprimir(btMac, texto); ultimoLog = "OK " + job.optString("tipo") + " -> Bluetooth" }
              else -> throw RuntimeException("estacion sin IP y sin Bluetooth")
            }
            Agent.marcar(cfg, id, true)
          } catch (e: Exception) {
            try { Agent.marcar(cfg, id, false, e.message) } catch (_: Exception) {}
            ultimoLog = "ERR " + id + ": " + e.message
          }
        }
      } catch (e: Exception) {
        ultimoLog = "ciclo: " + e.message
      }
      try { Thread.sleep(2000) } catch (_: InterruptedException) { break }
    }
  }

  private fun arrancarForeground() {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(NotificationChannel(CANAL, "LevoPrint", NotificationManager.IMPORTANCE_LOW))
    }
    val n = NotificationCompat.Builder(this, CANAL)
      .setContentTitle("LevoPrint activo")
      .setContentText("Escuchando trabajos de impresion")
      .setSmallIcon(R.drawable.ic_launcher_foreground)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(1, n)
    }
  }

  override fun onDestroy() {
    corriendo = false
    activo = false
    ultimoLog = "Detenido"
    hilo?.interrupt()
    try { wake?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
    super.onDestroy()
  }
}
