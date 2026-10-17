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
//
// [qa4] Desactivado desde la consola (AGENTE_INVALIDO): el token NO se
// borra (el dueno puede reactivarlo). El servicio sigue vivo pero en modo
// ahorro: consulta cada 60 s (en vez de cada 2 s) y SUELTA el wake lock, asi
// el CPU duerme entre consultas (con bateria, Doze puede espaciarlas mas;
// enchufado, van a tiempo). Si lo reactivan, la siguiente consulta responde
// bien y retoma solo. Si el dueno vincula un codigo nuevo, MainActivity
// guarda la config y llama otra vez al servicio: onStartCommand toma el
// token nuevo y despierta el bucle al instante, sin reiniciar el servicio.
// Abrir la app tambien despierta el bucle (reintento inmediato).
class PrintService : Service() {
  @Volatile private var corriendo = false
  private var hilo: Thread? = null
  private var wake: PowerManager.WakeLock? = null
  @Volatile private var cfgActual: Cfg? = null
  @Volatile private var forzarConfig = true
  private val dormidero = Object()

  companion object {
    const val CANAL = "levoprint"
    private const val TXT_ACTIVO = "Escuchando trabajos de impresion"
    private const val TXT_DESACTIVADO = "Desactivado desde la consola"
    private const val ESPERA_MS = 2000L
    private const val ESPERA_DESACTIVADO_MS = 60000L
    @Volatile var activo = false
    @Volatile var desactivado = false
    @Volatile var ultimoLog = "Detenido"
  }

  override fun onBind(i: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (corriendo) {
      // Ya corre (startForegroundService exige volver a llamar startForeground).
      try { arrancarForeground(if (desactivado) TXT_DESACTIVADO else TXT_ACTIVO) } catch (_: Exception) {}
      val nueva = Prefs.leer(this)
      if (nueva != null && nueva != cfgActual) {
        // Codigo nuevo canjeado: se usa el token nuevo desde la proxima vuelta.
        cfgActual = nueva
        forzarConfig = true
        if (desactivado) { desactivado = false; tomarWake(); notificar(TXT_ACTIVO) }
      }
      despertar() // reintento inmediato (app abierta o config nueva)
      return START_STICKY
    }
    val cfg = Prefs.leer(this) ?: run { stopSelf(); return START_NOT_STICKY }
    try { arrancarForeground(TXT_ACTIVO) } catch (e: Exception) { ultimoLog = "foreground: " + e.message }
    cfgActual = cfg
    forzarConfig = true
    desactivado = false
    corriendo = true
    activo = true
    tomarWake()
    hilo = Thread { bucle() }.also { it.isDaemon = true; it.start() }
    return START_STICKY
  }

  private fun bucle() {
    var estaciones: Map<String, Estacion> = emptyMap()
    var ciclo = 0
    while (corriendo) {
      // Config de ESTA vuelta: los trabajos tomados se marcan con el mismo token.
      val cfg = cfgActual ?: break
      var espera = ESPERA_MS
      try {
        if (forzarConfig || ciclo++ % 30 == 0) {
          estaciones = Agent.estaciones(cfg)
          forzarConfig = false
          ultimoLog = "Config: " + estaciones.size + " estaciones"
        }
        val jobs = Agent.tomar(cfg)
        if (desactivado && cfg == cfgActual) {
          // Lo reactivaron en la consola: vuelve al ritmo normal.
          desactivado = false
          tomarWake()
          notificar(TXT_ACTIVO)
          ultimoLog = "Reactivado: imprimiendo de nuevo"
        }
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
      } catch (e: RpcError) {
        if (e.agenteInvalido) {
          // [qa4] Desactivado/reemplazado: se conserva el token y se reintenta
          // con baja frecuencia. Si entretanto llego un token nuevo, se ignora.
          if (cfg == cfgActual) {
            if (!desactivado) { desactivado = true; soltarWake(); notificar(TXT_DESACTIVADO) }
            ultimoLog = Emparejamiento.msgDesactivado(cfg.prefijo)
            forzarConfig = true // al volver, lo primero es releer estaciones
            espera = ESPERA_DESACTIVADO_MS
          }
        } else {
          ultimoLog = "ciclo: " + e.message
        }
      } catch (e: Exception) {
        ultimoLog = "ciclo: " + e.message
      }
      if (!dormir(espera)) break
    }
  }

  // Espera interrumpible por despertar(); false si el hilo fue interrumpido (onDestroy).
  private fun dormir(ms: Long): Boolean = synchronized(dormidero) {
    try { dormidero.wait(ms); true } catch (_: InterruptedException) { false }
  }

  private fun despertar() { synchronized(dormidero) { dormidero.notifyAll() } }

  @Synchronized private fun tomarWake() {
    try {
      val w = wake ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "levoprint:loop").also { wake = it }
      if (!w.isHeld) w.acquire()
    } catch (_: Exception) {}
  }

  @Synchronized private fun soltarWake() {
    try { wake?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
  }

  private fun notificacion(texto: String) = NotificationCompat.Builder(this, CANAL)
    .setContentTitle("LevoPrint activo")
    .setContentText(texto)
    .setSmallIcon(R.drawable.ic_launcher_foreground)
    .setOngoing(true)
    .build()

  private fun notificar(texto: String) {
    try { getSystemService(NotificationManager::class.java).notify(1, notificacion(texto)) } catch (_: Exception) {}
  }

  private fun arrancarForeground(texto: String) {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(NotificationChannel(CANAL, "LevoPrint", NotificationManager.IMPORTANCE_LOW))
    }
    val n = notificacion(texto)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(1, n)
    }
  }

  override fun onDestroy() {
    corriendo = false
    activo = false
    desactivado = false
    ultimoLog = "Detenido"
    hilo?.interrupt()
    soltarWake()
    super.onDestroy()
  }
}
