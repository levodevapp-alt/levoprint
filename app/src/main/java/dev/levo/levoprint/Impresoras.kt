package dev.levo.levoprint

import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

// [LP-F3 · LP-F4] Impresora por estacion (backend levoprint_transporte; contrato en levodev-modules
// docs/LEVOPRINT.md §8). Estado compartido por PrintService (imprime) y MainActivity (pregunta
// «¿Donde esta la impresora de <estacion>?»): viven en el mismo proceso.
//   · Busqueda: red (:9100 de la /24 propia), Bluetooth (emparejadas; el descubrimiento de 12 s solo
//     desde la pantalla) y USB (cable OTG). Al arrancar, tras vincular, cada 15 min, cuando la consola
//     pide buscar (buscar:true) y con «Buscar de nuevo».
//   · <prefijo>_agente_impresoras en cada ciclo de config: manda la lista solo si cambio (md5) o cada
//     30 min y recibe el destino de cada estacion. Sin la RPC (backend viejo, PGRST202/404): 30 min
//     como la 1.6 (solo IP y la impresora Bluetooth general).
//   · <prefijo>_agente_estacion_elegir tras la prueba («¿Salio?» -> Si).
object Impresoras {
  private const val INFORMAR_CADA_MS = 30 * 60000L
  private const val SIN_TRANSPORTE_MS = 30 * 60000L
  const val BUSCAR_CADA_MS = 15 * 60000L

  // Estado por vinculo (prefijo|device).
  class EstadoApp {
    @Volatile var transporte: Boolean? = null       // null = aun no se sabe; false = backend viejo (modo 1.6)
    @Volatile var sinTransporteHasta = 0L
    @Volatile var destinos: Map<String, Destino> = emptyMap()
    @Volatile var estaciones: Map<String, Estacion> = emptyMap()
    @Volatile var estacionVinculo: String? = null
    @Volatile var md5Informado = ""
    @Volatile var informadoTs = 0L
    @Volatile var buscadoPendiente = false
    @Volatile var preguntar = false                 // tras vincular sin impresora: la pantalla pregunta
  }

  data class Resultado(val ok: Boolean, val mensaje: String, val modo16: Boolean = false)

  private val apps = ConcurrentHashMap<String, EstadoApp>()
  private val candados = ConcurrentHashMap<String, Any>()
  private val candadoBusqueda = Object()

  @Volatile var red: List<Encontrada> = emptyList()
    private set
  @Volatile var bt: List<Encontrada> = emptyList()
    private set
  @Volatile var usb: List<Encontrada> = emptyList()
    private set
  @Volatile var ts = 0L
    private set
  @Volatile var md5 = ""
    private set
  @Volatile var buscando = false
    private set
  @Volatile private var pedidaTs = 0L

  fun clave(c: Cfg) = c.prefijo + "|" + c.device
  fun app(c: Cfg): EstadoApp = apps.getOrPut(clave(c)) { EstadoApp() }

  fun encontradas(): List<Encontrada> = (red + bt + usb).take(BusquedaLogica.MAX_ENCONTRADAS)

  fun equipo(): String = (Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() } + " " + Build.MODEL.orEmpty()).trim().take(60).ifBlank { "Android" }

  fun capacidades(ctx: Context): JSONArray {
    val a = JSONArray().put("red")
    if (try { BluetoothAdapter.getDefaultAdapter() != null } catch (_: Exception) { false }) a.put("bluetooth")
    if (ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST)) a.put("usb")
    return a
  }

  // Destino de una estacion (destinos de agente_impresoras o, si no hay, la IP de agente_config).
  fun destino(c: Cfg, estacion: String): Destino? {
    val st = app(c)
    return BusquedaLogica.destinoDe(st.estaciones[estacion], st.destinos[estacion])
  }

  // Busqueda completa (bloquea: llamar desde un hilo de fondo). descubrirBt = 12 s de descubrimiento
  // Bluetooth (solo desde la pantalla). Al terminar se informa a cada app al instante con «buscado».
  // [QA LP-F3 · BAJO 4] forzarInforme = false (busqueda periodica del servicio): la lista va solo si cambio
  // el md5; si no, solo «buscado:true». Las pedidas (pantalla, consola, vinculo) la mandan siempre.
  fun buscar(ctx: Context, descubrirBt: Boolean, forzarInforme: Boolean = true) {
    synchronized(candadoBusqueda) {
      buscando = true
      try {
        val r = try { Red.buscar(ctx) } catch (_: Exception) { red }
        val general = Prefs.getBtMac(ctx)
        val emp = Bt.emparejadas().map {
          Encontrada("bluetooth", it.mac, it.nombre, JSONObject().put("emparejada", true).put("probableTermica", it.probableImpresora)
            .put("general", it.mac.equals(general, ignoreCase = true)))
        }
        // Lo descubierto sin emparejar se conserva entre busquedas del servicio (que no descubre).
        val nuevas = if (descubrirBt) Bt.descubrir(ctx).map {
          Encontrada("bluetooth", it.mac, it.nombre, JSONObject().put("emparejada", false).put("probableTermica", it.probableImpresora))
        } else bt.filter { !it.detalle.optBoolean("emparejada", true) }
        val u = try { Usb.buscar(ctx) } catch (_: Exception) { emptyList() }
        red = r
        bt = emp + nuevas.filter { n -> emp.none { it.ref == n.ref } }
        usb = u
        ts = System.currentTimeMillis()
        md5 = BusquedaLogica.md5Lista(encontradas())
      } finally {
        buscando = false
      }
    }
    for (c in Prefs.leerVinculos(ctx)) {
      app(c).buscadoPendiente = true
      try { informar(ctx, c, forzarInforme) } catch (_: Exception) {}
    }
  }

  // <prefijo>_agente_impresoras. Devuelve false si el backend no la tiene (modo 1.6).
  // AGENTE_INVALIDO y errores de red se lanzan (el servicio ya los maneja).
  fun informar(ctx: Context, c: Cfg, forzar: Boolean): Boolean {
    val st = app(c)
    val ahora = System.currentTimeMillis()
    if (st.sinTransporteHasta > ahora) return false
    val p = JSONObject().put("device", c.device).put("version", "apk/" + Agent.VERSION)
      .put("equipo", equipo()).put("capacidades", capacidades(ctx))
    val lista = encontradas()
    val md5Lista = md5
    val mandaLista = ts > 0 && (forzar || md5Lista != st.md5Informado || ahora - st.informadoTs >= INFORMAR_CADA_MS)
    if (mandaLista) p.put("encontradas", BusquedaLogica.listaJson(lista))
    val buscado = st.buscadoPendiente && ts > 0
    if (buscado) p.put("buscado", true)
    val r = try {
      Agent.rpc(c, c.prefijo + "_agente_impresoras", p)
    } catch (e: RpcError) {
      if (e.ausente) {
        st.transporte = false
        st.sinTransporteHasta = ahora + SIN_TRANSPORTE_MS
        st.destinos = emptyMap()
        return false
      }
      throw e
    }
    st.transporte = true
    st.sinTransporteHasta = 0L
    // {ok:false, error:"PARAMETRO_INVALIDO"}: no se borra lo que ya se sabia de cada estacion.
    if (!r.optBoolean("ok", true)) return true
    if (mandaLista) { st.md5Informado = md5Lista; st.informadoTs = ahora }
    if (buscado) st.buscadoPendiente = false
    st.estacionVinculo = if (r.isNull("estacionVinculo")) null else r.optString("estacionVinculo").ifBlank { null }
    st.destinos = BusquedaLogica.parseDestinos(r.optJSONArray("destinos"))
    // La consola pidio buscar: sin bucle (no si esta llamada ya llevaba «buscado») y como mucho 1 por minuto.
    if (r.optBoolean("buscar") && !buscado && !buscando && ahora - pedidaTs > 60000L) {
      pedidaTs = ahora
      val app = ctx.applicationContext
      Thread { try { buscar(app, false) } catch (_: Exception) {} }.start()
    }
    return true
  }

  // Imprime en el destino de la estacion; un candado por impresora (el servicio y una prueba de la
  // pantalla no se mezclan). Errores con codigo corto al inicio (van a print_marcar).
  fun imprimir(ctx: Context, d: Destino, texto: String) {
    val lock = candados.getOrPut(d.clave) { Any() }
    synchronized(lock) {
      when (d.transporte) {
        "red" -> Agent.imprimirTcp(d.ip ?: throw RuntimeException("SIN_IP: estacion sin IP"), d.puerto, texto)
        "bluetooth" -> {
          if (!d.propio) throw RuntimeException("IMPRESORA_EN_OTRO_EQUIPO: la impresora Bluetooth de " + d.nombre + " esta en otro equipo")
          Bt.imprimir(d.btMac ?: throw RuntimeException("SIN_BLUETOOTH: estacion Bluetooth sin impresora"), texto)
        }
        "usb" -> {
          if (!d.propio) throw RuntimeException("IMPRESORA_EN_OTRO_EQUIPO: la impresora USB de " + d.nombre + " esta en otro equipo")
          Usb.imprimir(ctx, d.usbId ?: throw RuntimeException("SIN_USB: estacion USB sin impresora"), texto)
        }
        else -> throw RuntimeException("TRANSPORTE_NO_SOPORTADO: " + d.transporte)
      }
    }
  }

  private fun destinoDe(e: Encontrada): Destino? = when (e.transporte) {
    "red" -> BusquedaLogica.refRed(e.ref)?.let { Destino("", e.nombre, "red", it.first, it.second, null, null, e.nombre, true) }
    "bluetooth" -> if (BusquedaLogica.macValida(e.ref.uppercase())) Destino("", e.nombre, "bluetooth", null, 9100, e.ref.uppercase(), null, e.nombre, true) else null
    "usb" -> Destino("", e.nombre, "usb", null, 9100, null, e.ref, e.nombre, true)
    else -> null
  }

  // Papel de prueba en una impresora encontrada (antes de elegirla). null = salio; si no, el aviso.
  // Bluetooth sin emparejar: primero se empareja (Android pide el PIN). USB sin permiso: se pide.
  fun probar(ctx: Context, c: Cfg, e: Encontrada): String? {
    val d = destinoDe(e) ?: return "Esa impresora no es válida. Busca de nuevo."
    if (d.transporte == "bluetooth" && !Bt.estaEmparejada(d.btMac!!)) {
      if (!Bt.emparejar(d.btMac!!)) return "No se pudo emparejar. Si te pide un PIN, prueba 0000 o 1234, y vuelve a tocar «Probar»."
    }
    if (d.transporte == "usb" && !Usb.pedirPermiso(ctx, d.usbId!!)) {
      return "Acepta el permiso de Android para la impresora USB y vuelve a tocar «Probar»."
    }
    val texto = Agent.render(JSONObject().put("tipo", "PRUEBA").put("payload", JSONObject()), c.ancho, c.prefijo, Prefs.getImagen(ctx))
    return try { imprimir(ctx, d, texto); null } catch (x: Exception) {
      "No respondió: revisa que esté encendida y conectada, o prueba con otra."
    }
  }

  private fun mensajeElegir(err: String, prefijo: String): String = when (err) {
    "ESTACION_NO_EXISTE" -> "Esa estación ya no existe en tu app. Revisa " + Emparejamiento.consolaDe(prefijo) + "."
    "PARAMETRO_INVALIDO" -> "Los datos de la impresora no son válidos. Busca de nuevo y vuelve a intentar."
    "DESTINO_NO_VISTO" -> "Tu app aún no ve esa impresora. Toca «Buscar de nuevo» y vuelve a elegirla."
    "EQUIPO_OTRO_LOCAL" -> "Este equipo es de otro local que esa estación: elige su impresora desde un equipo de ese local."
    "AGENTE_INVALIDO" -> Emparejamiento.msgDesactivado(prefijo)
    else -> "No se pudo guardar (" + err.ifBlank { "error" } + ")."
  }

  // Tras «¿Salio?» -> Si: <prefijo>_agente_estacion_elegir. Backend viejo: modo 1.6 («Escribe esta IP en...»).
  fun elegir(ctx: Context, c: Cfg, estacion: String, estNombre: String, e: Encontrada): Resultado {
    val st = app(c)
    val d = destinoDe(e) ?: return Resultado(false, "Esa impresora no es válida. Busca de nuevo.")
    val modo16 = {
      Resultado(false, if (d.transporte == "red")
        "Escribe esta IP en " + Emparejamiento.consolaDe(c.prefijo) + " (estación " + estNombre + "): " + d.ip + (if (d.puerto != 9100) " puerto " + d.puerto else "") + "."
      else if (d.transporte == "bluetooth")
        "Tu app todavía no guarda la impresora Bluetooth por estación. Úsala como impresora Bluetooth general: más abajo, «Habilitar impresora Bluetooth»."
      else "Tu app todavía no admite impresoras USB. Por ahora usa una de red.", true)
    }
    if (st.transporte == false && st.sinTransporteHasta > System.currentTimeMillis()) return modo16()
    val p = JSONObject().put("device", c.device).put("estacion", estacion).put("transporte", d.transporte).put("nombre", e.nombre.take(80))
    when (d.transporte) {
      "red" -> p.put("ip", d.ip).put("puerto", d.puerto)
      "bluetooth" -> p.put("btMac", d.btMac)
      "usb" -> p.put("usbId", d.usbId)
    }
    // BT/USB: que el servidor la tenga en lo visto por este equipo (si no, DESTINO_NO_VISTO).
    if (d.transporte != "red") try { informar(ctx, c, true) } catch (_: Exception) {}
    val r = try {
      Agent.rpc(c, c.prefijo + "_agente_estacion_elegir", p)
    } catch (x: RpcError) {
      if (x.ausente) {
        st.transporte = false
        st.sinTransporteHasta = System.currentTimeMillis() + SIN_TRANSPORTE_MS
        return modo16()
      }
      return Resultado(false, mensajeElegir(x.pgMensaje, c.prefijo))
    } catch (x: Exception) {
      return Resultado(false, "No se pudo guardar. Revisa tu internet e intenta de nuevo.")
    }
    if (!r.optBoolean("ok")) return Resultado(false, mensajeElegir(r.optString("error"), c.prefijo))
    st.preguntar = false
    try { st.estaciones = Agent.estaciones(c); informar(ctx, c, false) } catch (_: Exception) {}
    return Resultado(true, "Listo: " + estNombre + " imprime en " + e.nombre + ".")
  }
}
