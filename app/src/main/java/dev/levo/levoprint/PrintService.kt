package dev.levo.levoprint

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

// Servicio en primer plano: mantiene vivo el bucle de impresion aunque
// la pantalla se apague (celular dedicado, enchufado en la red del local).
//
// [qa4] Desactivado desde la consola (AGENTE_INVALIDO): el token NO se
// borra (el dueno puede reactivarlo). El servicio sigue vivo pero en modo
// ahorro: SUELTA el wake lock permanente y reintenta con baja frecuencia.
// Si lo reactivan, el siguiente reintento responde bien y retoma solo. Si el
// dueno vincula un codigo nuevo, MainActivity guarda la config y llama otra
// vez al servicio: onStartCommand toma el token nuevo y despierta el bucle
// al instante, sin reiniciar el servicio. Abrir la app tambien lo despierta.
//
// [qa5] Sin wake lock, el CPU se suspende con la pantalla apagada (ESTE
// enchufado o no: cargar evita Doze, pero no la suspension del CPU), y un
// Object.wait(60 s) puede no avanzar en horas. Por eso cada reintento lo
// dispara una alarma AlarmManager.setAndAllowWhileIdle:
//   · No pide permiso (setExactAndAllowWhileIdle exige SCHEDULE_EXACT_ALARM,
//     que en Android 12+ el usuario debe conceder a mano y esta app no tiene).
//   · Despierta el CPU incluso en Doze. Es inexacta: en Doze profundo el
//     sistema la limita a ~1 cada 9 min por app; con el backoff de abajo
//     (60 s la primera hora, luego 5 y 15 min) solo afecta la primera hora.
//   · Mantener el wake lock "solo enchufado" se descarto: con bateria el
//     equipo quedaria igual de dormido y enchufado gastaria CPU sin motivo.
// La alarma llega a un receptor interno que toma un wake lock CORTO (60 s
// maximo) para que el reintento alcance a hacer su consulta.
//
// Backoff "equipo olvidado": 60 s la primera hora, 5 min hasta las 24 h y
// luego cada 15 min.
//
// [F2] Ademas del bucle de la nube, el servicio levanta el ServidorLocal
// (:9120, red del local y loopback): la caja y los mozos imprimen por la
// WiFi aunque se caiga el internet. Nube y LAN pasan por el mismo Motor
// (diario anti-duplicado + una cola por impresora). Latido LAN cada ~60 s
// (cada ~16 s mientras haya impresos por la LAN sin reportar).
class PrintService : Service() {
  @Volatile private var corriendo = false
  private var servidor: ServidorLocal? = null
  private val trabajadores = java.util.concurrent.Executors.newFixedThreadPool(4)
  @Volatile private var lanNoExisteHasta = 0L
  private var hilo: Thread? = null
  private var wake: PowerManager.WakeLock? = null
  private var wakeCorto: PowerManager.WakeLock? = null
  @Volatile private var cfgActual: Cfg? = null
  @Volatile private var forzarConfig = true
  private val dormidero = Object()
  private var receptorRegistrado = false
  private var ultimoDespertarApp = 0L // [qa6] tope del reintento al abrir la app

  companion object {
    const val CANAL = "levoprint"
    private const val ACCION_REINTENTO = "dev.levo.levoprint.REINTENTO_DESACTIVADO"
    private const val TXT_ACTIVO = "Escuchando trabajos de impresion"
    private const val TXT_DESACTIVADO = "Desactivado desde la consola"
    private const val ESPERA_MS = 2000L
    private const val HORA_MS = 3600000L
    @Volatile var activo = false
    @Volatile var desactivado = false
    @Volatile var desactivadoDesde = 0L // System.currentTimeMillis() del primer AGENTE_INVALIDO
    @Volatile var ultimoLog = "Detenido"
    @Volatile var nubeOkTs = 0L                 // [F2] ultima respuesta buena de la nube
    @Volatile var lanEscuchando = false
    @Volatile var lanError: String? = null
    const val PUERTO_LAN = 9120

    fun esperaDesactivado(desde: Long): Long {
      val t = System.currentTimeMillis() - desde
      return when {
        t < HORA_MS -> 60000L
        t < 24 * HORA_MS -> 5 * 60000L
        else -> 15 * 60000L
      }
    }
  }

  // Alarma de reintento: wake lock corto y despierta el bucle.
  private val receptor = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, i: Intent?) {
      tomarWakeCorto()
      despertar()
    }
  }

  override fun onBind(i: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    try {
      ContextCompat.registerReceiver(this, receptor, IntentFilter(ACCION_REINTENTO), ContextCompat.RECEIVER_NOT_EXPORTED)
      receptorRegistrado = true
    } catch (_: Exception) {}
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (corriendo) {
      // Ya corre (startForegroundService exige volver a llamar startForeground).
      try { arrancarForeground(if (desactivado) TXT_DESACTIVADO else TXT_ACTIVO) } catch (_: Exception) {}
      val nueva = Prefs.leer(this)
      if (nueva != null && nueva != cfgActual) {
        // Codigo nuevo canjeado: se usa el token nuevo desde la proxima vuelta
        // (siempre al instante, sin tope).
        cfgActual = nueva
        forzarConfig = true
        if (desactivado) salirDeDesactivado()
        despertar()
      } else if (desactivado && SystemClock.elapsedRealtime() - ultimoDespertarApp > 10000L) {
        // [qa6] App abierta con el equipo desactivado: reintento ya, con CPU
        // despierto, pero a lo sumo uno cada 10 s (mismo tope que el exe).
        ultimoDespertarApp = SystemClock.elapsedRealtime()
        tomarWakeCorto()
        despertar()
      }
      return START_STICKY
    }
    val cfg = Prefs.leer(this) ?: run { stopSelf(); return START_NOT_STICKY }
    try { arrancarForeground(TXT_ACTIVO) } catch (e: Exception) { ultimoLog = "foreground: " + e.message }
    Motor.iniciar(this)
    // [QA F2 MEDIO-3] Se crea pero NO se abre: revisarLan() lo abre solo con
    // "Activar impresion sin internet" (PIN vigente) o equipos emparejados.
    servidor = ServidorLocal(this, PUERTO_LAN) { forzarConfig = true; despertar() }
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
    var ciclo = 0
    var ultimoLatido = 0L
    while (corriendo) {
      // Config de ESTA vuelta: los trabajos tomados se marcan con el mismo token.
      val cfg = cfgActual ?: break
      var espera = ESPERA_MS
      revisarLan()
      try {
        // [qa5] El contador avanza SIEMPRE (antes "forzar || ciclo++" lo
        // saltaba por cortocircuito cuando forzarConfig era true).
        val tocaConfig = ciclo++ % 30 == 0
        lanEscuchando = servidor?.escuchando == true
        lanError = servidor?.error
        if (forzarConfig || tocaConfig) {
          Motor.ponerEstaciones(Agent.estaciones(cfg))
          forzarConfig = false
          ultimoLog = "Config: " + Motor.estaciones.size + " estaciones"
        }
        val jobs = Agent.tomar(cfg)
        nubeOkTs = System.currentTimeMillis()
        if (desactivado && cfg == cfgActual) {
          // Lo reactivaron en la consola: vuelve al ritmo normal.
          salirDeDesactivado()
          ultimoLog = "Reactivado: imprimiendo de nuevo"
        }
        // [F2] Cada trabajo por el Motor (diario + cola de SU impresora), en
        // paralelo entre impresoras. Un jobId que ya salio por la LAN se marca
        // impreso sin otro papel.
        val tareas = (0 until jobs.length()).map { i ->
          val job = jobs.getJSONObject(i)
          trabajadores.submit {
            val id = job.optString("id")
            val r = Motor.procesar(Diario.jobIdDeNube(job), "NUBE", job.optString("estacion").ifBlank { null },
              job.optString("tipo"), job.optJSONObject("payload") ?: org.json.JSONObject(), cfg.ancho)
            ultimoLog = (if (r.ok) "OK " else "ERR ") + job.optString("tipo") + " -> " + (r.via ?: "-") +
              (if (r.duplicado) " (ya habia salido)" else "") + (if (r.ok) "" else ": " + r.error)
            try { Agent.marcar(cfg, id, r.ok, if (r.ok) null else r.error) } catch (_: Exception) {}
          }
        }
        for (t in tareas) try { t.get() } catch (_: Exception) {}
        // Latido LAN: cada ~60 s, o ~16 s si hay impresos por la LAN sin reportar
        // o asignaciones de este equipo sin avisar a la nube (ALTO-1).
        val pendAsig = Motor.pendientesNube()
        val hayPorReportar = Motor.diario.sinReportar(1).isNotEmpty() || pendAsig.isNotEmpty()
        val ahora = System.currentTimeMillis()
        if (ahora - ultimoLatido > (if (hayPorReportar) 16000L else 60000L)) {
          ultimoLatido = ahora
          for ((id, ruta) in pendAsig) Agent.avisarAsignacion(cfg, id, ruta)
        }
        if (ahora > lanNoExisteHasta && ultimoLatido == ahora) {
          try {
            val imp = Motor.diario.sinReportar(200)
            val r = Agent.latidoLan(cfg, if (servidor?.escuchando == true) Red.ipsLocales() else emptyList(), PUERTO_LAN, imp)
            Motor.ponerTransportes(r.optJSONArray("estaciones"))
            if (imp.isNotEmpty()) Motor.diario.marcarReportados(imp.map { it.k })
          } catch (e: RpcError) {
            if (e.http == 404) lanNoExisteHasta = ahora + 10 * 60000L   // la base aun no tiene impresion_local
          } catch (_: Exception) {}
        }
      } catch (e: RpcError) {
        if (e.agenteInvalido) {
          // [qa4] Desactivado/reemplazado: se conserva el token y se reintenta
          // con baja frecuencia. Si entretanto llego un token nuevo, se ignora.
          if (cfg == cfgActual) {
            if (!desactivado) {
              desactivado = true
              desactivadoDesde = System.currentTimeMillis()
              soltarWake()
              notificar(TXT_DESACTIVADO)
            }
            ultimoLog = Emparejamiento.textoDesactivado(cfg.prefijo, desactivadoDesde)
            forzarConfig = true // al volver, lo primero es releer estaciones
            espera = esperaDesactivado(desactivadoDesde)
          }
        } else {
          ultimoLog = "ciclo: " + e.message
        }
      } catch (e: Exception) {
        ultimoLog = "ciclo: " + e.message
      }
      if (desactivado) {
        // [qa5] La alarma despierta el CPU para el proximo intento; el wake
        // lock corto de este intento se suelta y el CPU puede dormir. Se usa
        // el backoff aunque el fallo de esta vuelta haya sido de red.
        val ms = esperaDesactivado(desactivadoDesde)
        programarReintento(ms)
        soltarWakeCorto()
        // Respaldo: si el CPU sigue despierto, el wait vence solo (la alarma
        // ya avisara; un despertar de mas solo adelanta un intento).
        if (!dormir(ms + 5000)) break
      } else {
        if (!dormir(espera)) break
      }
    }
  }

  // [QA F2 MEDIO-3] El 9120 solo abierto si hace falta: PIN vigente
  // ("Activar impresion sin internet") o equipos emparejados.
  private fun revisarLan() {
    val s = servidor ?: return
    val falta = Emparejador.pinVigente() != null || Emparejador.equipos(this).isNotEmpty()
    if (falta && !s.abierto) s.iniciar()
    else if (!falta && s.abierto) s.detener()
    lanEscuchando = s.escuchando
    lanError = s.error
  }

  private fun salirDeDesactivado() {
    desactivado = false
    desactivadoDesde = 0L
    cancelarReintento()
    tomarWake()
    soltarWakeCorto()
    notificar(TXT_ACTIVO)
  }

  private fun pendienteReintento(): PendingIntent =
    PendingIntent.getBroadcast(this, 7, Intent(ACCION_REINTENTO).setPackage(packageName),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

  private fun programarReintento(ms: Long) {
    try {
      val am = getSystemService(AlarmManager::class.java)
      am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + ms, pendienteReintento())
    } catch (_: Exception) {}
  }

  private fun cancelarReintento() {
    try { getSystemService(AlarmManager::class.java).cancel(pendienteReintento()) } catch (_: Exception) {}
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

  // Wake lock del reintento: no acumulativo y con tope de 60 s por si algo falla.
  @Synchronized private fun tomarWakeCorto() {
    try {
      val w = wakeCorto ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "levoprint:reintento")
        .also { it.setReferenceCounted(false); wakeCorto = it }
      w.acquire(60000L)
    } catch (_: Exception) {}
  }

  @Synchronized private fun soltarWakeCorto() {
    try { wakeCorto?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
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
    desactivadoDesde = 0L
    ultimoLog = "Detenido"
    hilo?.interrupt()
    servidor?.detener()
    servidor = null
    lanEscuchando = false
    cancelarReintento()
    if (receptorRegistrado) { try { unregisterReceiver(receptor) } catch (_: Exception) {} }
    soltarWake()
    soltarWakeCorto()
    super.onDestroy()
  }
}
