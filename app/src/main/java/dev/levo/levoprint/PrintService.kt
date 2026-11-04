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
// [LP-U1] Con varias apps vinculadas (KOMO, KIPU, KUTI), todo lo anterior vale POR
// vinculo; el modo ahorro entra solo si TODOS estan desactivados (ver bucle()).
class PrintService : Service() {
  @Volatile private var corriendo = false
  private var hilo: Thread? = null
  private var wake: PowerManager.WakeLock? = null
  private var wakeCorto: PowerManager.WakeLock? = null
  // [LP-U1] Varias apps en un mismo LevoPrint: un Cfg por vinculo (Prefs.leerVinculos).
  // El bucle atiende a todos en cada vuelta; cada uno lleva sus estaciones y su estado
  // de desactivado (EstadoV). El modo ahorro (sin wake lock, reintentos por alarma) se
  // usa solo cuando TODOS los vinculos estan desactivados: si una app sigue viva, el
  // servicio sigue al ritmo normal y la desactivada se reintenta con su propio backoff.
  @Volatile private var cfgs: List<Cfg> = emptyList()
  @Volatile private var forzarReintento = false
  private val dormidero = Object()
  private var receptorRegistrado = false
  private var ultimoDespertarApp = 0L // [qa6] tope del reintento al abrir la app

  private class EstadoV(val cfg: Cfg) {
    var estaciones: Map<String, Estacion> = emptyMap()
    var forzarConfig = true
    var ciclo = 0
    var desactivadoDesde = 0L // System.currentTimeMillis() del primer AGENTE_INVALIDO (0 = activo)
    var proximo = 0L          // proximo reintento mientras este desactivado
  }

  companion object {
    const val CANAL = "levoprint"
    private const val ACCION_REINTENTO = "dev.levo.levoprint.REINTENTO_DESACTIVADO"
    private const val TXT_ACTIVO = "Escuchando trabajos de impresion"
    private const val TXT_DESACTIVADO = "Desactivado desde la consola"
    private const val ESPERA_MS = 2000L
    private const val HORA_MS = 3600000L
    @Volatile var activo = false
    @Volatile var desactivado = false        // TODOS los vinculos desactivados
    @Volatile var desactivadoDesde = 0L      // System.currentTimeMillis() del primer AGENTE_INVALIDO
    @Volatile var desactivadoPrefijo = ""    // [LP-U1] app del aviso (el primer vinculo desactivado)
    @Volatile var ultimoLog = "Detenido"

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
      val nuevas = Prefs.leerVinculos(this)
      if (nuevas.isNotEmpty() && nuevas != cfgs) {
        // Codigo nuevo canjeado (otra app o la misma con token nuevo): se usa desde la
        // proxima vuelta, siempre al instante y sin tope.
        cfgs = nuevas
        if (desactivado) salirDeDesactivado()
        despertar()
      } else if (desactivado && SystemClock.elapsedRealtime() - ultimoDespertarApp > 10000L) {
        // [qa6] App abierta con el equipo desactivado: reintento ya, con CPU
        // despierto, pero a lo sumo uno cada 10 s (mismo tope que el exe).
        ultimoDespertarApp = SystemClock.elapsedRealtime()
        forzarReintento = true
        tomarWakeCorto()
        despertar()
      }
      return START_STICKY
    }
    val lista = Prefs.leerVinculos(this)
    if (lista.isEmpty()) { stopSelf(); return START_NOT_STICKY }
    try { arrancarForeground(TXT_ACTIVO) } catch (e: Exception) { ultimoLog = "foreground: " + e.message }
    cfgs = lista
    desactivado = false
    corriendo = true
    activo = true
    tomarWake()
    hilo = Thread { bucle() }.also { it.isDaemon = true; it.start() }
    return START_STICKY
  }

  private fun clave(c: Cfg) = c.prefijo + "|" + c.device

  private fun bucle() {
    val estados = HashMap<String, EstadoV>()
    var ultimaBusqueda = 0L
    while (corriendo) {
      val lista = cfgs
      if (lista.isEmpty()) break
      // [LP-F3] Busqueda de impresoras al arrancar y cada 15 min, en otro hilo (no frena la impresion).
      if (System.currentTimeMillis() - ultimaBusqueda >= Impresoras.BUSCAR_CADA_MS && !Impresoras.buscando) {
        val primera = ultimaBusqueda == 0L
        ultimaBusqueda = System.currentTimeMillis()
        val ctx = applicationContext
        Thread { try { Impresoras.buscar(ctx, false, forzarInforme = primera) } catch (_: Exception) {} }.start()
      }
      // Vinculos quitados o reemplazados (token nuevo) dejan su estado: el nuevo arranca limpio.
      val claves = lista.map { clave(it) }.toSet()
      estados.keys.retainAll(claves)
      for (c in lista) { val e = estados[clave(c)]; if (e == null || e.cfg != c) estados[clave(c)] = EstadoV(c) }
      val reintentar = forzarReintento
      forzarReintento = false
      for (c in lista) {
        val st = estados[clave(c)] ?: continue
        if (!corriendo) break
        if (st.desactivadoDesde > 0 && !reintentar && System.currentTimeMillis() < st.proximo) continue
        vuelta(st)
      }
      val desact = lista.mapNotNull { estados[clave(it)] }.filter { it.desactivadoDesde > 0 }
      desactivadoPrefijo = desact.firstOrNull()?.cfg?.prefijo ?: ""
      if (desact.size == lista.size) {
        // TODOS desactivados: modo ahorro.
        if (!desactivado) {
          desactivado = true
          desactivadoDesde = desact.minOf { it.desactivadoDesde }
          soltarWake()
          notificar(TXT_DESACTIVADO)
        }
        // [qa5] La alarma despierta el CPU para el proximo intento; el wake
        // lock corto de este intento se suelta y el CPU puede dormir. Se usa
        // el backoff aunque el fallo de esta vuelta haya sido de red.
        val ms = maxOf(ESPERA_MS, desact.minOf { it.proximo } - System.currentTimeMillis())
        programarReintento(ms)
        soltarWakeCorto()
        // Respaldo: si el CPU sigue despierto, el wait vence solo (la alarma
        // ya avisara; un despertar de mas solo adelanta un intento).
        if (!dormir(ms + 5000)) break
      } else {
        // Lo reactivaron en la consola (o hay al menos una app viva): ritmo normal.
        if (desactivado) salirDeDesactivado()
        if (!dormir(ESPERA_MS)) break
      }
    }
  }

  // Una vuelta de UN vinculo: config cada 30 vueltas (~60 s), tomar, imprimir y marcar.
  // Los trabajos tomados se marcan con el MISMO token (st.cfg) que los tomo.
  private fun vuelta(st: EstadoV) {
    val cfg = st.cfg
    try {
      // [qa5] El contador avanza SIEMPRE (antes "forzar || ciclo++" lo
      // saltaba por cortocircuito cuando forzarConfig era true).
      val tocaConfig = st.ciclo++ % 30 == 0
      if (st.forzarConfig || tocaConfig) {
        st.estaciones = Agent.estaciones(cfg)
        st.forzarConfig = false
        Impresoras.app(cfg).estaciones = st.estaciones
        // [LP-F3] Luego el destino de cada estacion (red / Bluetooth / USB). agente_config va primero (KUTI
        // guarda ahi la version); si esto falla (red), se sigue imprimiendo con lo que ya se sabia.
        try { Impresoras.informar(this, cfg, false) } catch (e: RpcError) { if (e.agenteInvalido) throw e } catch (_: Exception) {}
        ultimoLog = "Config " + cfg.prefijo.uppercase() + ": " + st.estaciones.size + " estaciones"
      }
      val jobs = Agent.tomar(cfg)
      if (st.desactivadoDesde > 0) {
        st.desactivadoDesde = 0L
        st.proximo = 0L
        ultimoLog = "Reactivado " + cfg.prefijo.uppercase() + ": imprimiendo de nuevo"
      }
      for (i in 0 until jobs.length()) {
        val job = jobs.getJSONObject(i)
        val id = job.optString("id")
        try {
          // [LP-F3] Destino segun el transporte de la estacion (red, Bluetooth o USB de este equipo).
          val d = Impresoras.destino(cfg, job.optString("estacion"))
          val texto = Agent.render(job, cfg.ancho, cfg.prefijo, Prefs.getImagen(this))
          val btMac = Prefs.getBtMac(this)
          val ok = "OK " + cfg.prefijo.uppercase() + " " + job.optString("tipo") + " -> "
          when {
            d != null && d.imprimible -> { Impresoras.imprimir(this, d, texto); ultimoLog = ok + d.nombre + " (" + d.texto() + ")" }
            // Respaldo de la 1.6: estacion de red sin IP + impresora Bluetooth general encendida.
            (d == null || (d.transporte == "red" && d.ip == null)) && Prefs.getBluetooth(this) && btMac.isNotBlank() -> {
              Impresoras.imprimir(this, Destino("", "Bluetooth general", "bluetooth", null, 9100, btMac, null, "", true), texto)
              ultimoLog = ok + "Bluetooth"
            }
            d != null -> Impresoras.imprimir(this, d, texto) // no imprimible aqui: lanza el error que corresponde
            else -> throw RuntimeException("SIN_ESTACION: estacion sin IP y sin Bluetooth")
          }
          Agent.marcar(cfg, id, true)
        } catch (e: Exception) {
          try { Agent.marcar(cfg, id, false, e.message) } catch (_: Exception) {}
          ultimoLog = "ERR " + cfg.prefijo.uppercase() + " " + id + ": " + e.message
        }
      }
    } catch (e: RpcError) {
      if (e.agenteInvalido) {
        // [qa4] Desactivado/reemplazado: se conserva el token y se reintenta
        // con baja frecuencia (solo ESTE vinculo).
        val ahora = System.currentTimeMillis()
        if (st.desactivadoDesde == 0L) st.desactivadoDesde = ahora
        st.proximo = ahora + esperaDesactivado(st.desactivadoDesde)
        st.forzarConfig = true // al volver, lo primero es releer estaciones
        ultimoLog = Emparejamiento.textoDesactivado(cfg.prefijo, st.desactivadoDesde)
      } else {
        ultimoLog = "ciclo " + cfg.prefijo.uppercase() + ": " + e.message
      }
    } catch (e: Exception) {
      ultimoLog = "ciclo " + cfg.prefijo.uppercase() + ": " + e.message
    }
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
    desactivadoPrefijo = ""
    ultimoLog = "Detenido"
    hilo?.interrupt()
    cancelarReintento()
    if (receptorRegistrado) { try { unregisterReceiver(receptor) } catch (_: Exception) {} }
    soltarWake()
    soltarWakeCorto()
    super.onDestroy()
  }
}
