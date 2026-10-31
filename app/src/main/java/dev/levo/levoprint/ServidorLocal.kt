package dev.levo.levoprint

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

// [F2] Servidor de la red del local en :9120 (mismo contrato que el .exe,
// agente/lib/servidorLan.js). Escucha en 0.0.0.0: sirve a la tablet de la
// caja por loopback (127.0.0.1, "impresora en el mismo equipo") y a los
// celulares de los mozos por la WiFi del local, sin internet.
//   GET /v1/hola · POST /v1/emparejar · GET /v1/estado · POST /v1/imprimir
//   GET /v1/impresoras · POST /v1/prueba · POST /v1/refrescar · GET /v1/diario
// HTTP/1.1 minimo hecho a mano (sin dependencias): una peticion por conexion
// (Connection: close), cuerpo maximo 256 KB, 8 hilos.
// Seguridad: IP privada, Host permitido, Origin *.levodev.app, token por
// equipo (Emparejador, vence a los 90 dias sin uso). Aqui no hay
// certificados ni llaves del cliente.
// [QA F2] Solo escucha si hace falta (PrintService.revisarLan: PIN vigente o
// equipos emparejados); 423 si la consola desactivo este LevoPrint; tope
// TOTAL de 20 s por conexion (corta a quien manda las cabeceras de a gotas).
// Riesgo aceptado y documentado: HTTP en claro dentro de la red del local.
class ServidorLocal(private val ctx: Context, private val puerto: Int = 9120, private val alPedirRefresco: () -> Unit) {
  @Volatile private var server: ServerSocket? = null
  @Volatile var escuchando = false
  @Volatile var error: String? = null
  private val pool = Executors.newFixedThreadPool(8)
  private val reloj = Executors.newSingleThreadScheduledExecutor()

  @Volatile private var arrancado = false

  @Synchronized fun iniciar() {
    if (arrancado) return
    arrancado = true
    Thread {
      try {
        val s = ServerSocket(puerto, 32, InetAddress.getByName("0.0.0.0"))
        s.reuseAddress = true
        server = s; escuchando = true; error = null
        while (!s.isClosed) {
          val c = try { s.accept() } catch (_: Exception) { break }
          pool.submit { atender(c) }
        }
      } catch (e: Exception) {
        error = if (e is java.net.BindException) "el puerto $puerto esta ocupado" else e.message
      } finally { escuchando = false; server = null; arrancado = false }
    }.also { it.isDaemon = true; it.start() }
  }

  @Synchronized fun detener() { try { server?.close() } catch (_: Exception) {}; server = null; escuchando = false }

  val abierto: Boolean get() = arrancado

  private class Pedido(val metodo: String, val ruta: String, val cab: Map<String, String>, val cuerpo: String)

  private fun leerLinea(inp: InputStream): String? {
    val sb = StringBuilder()
    while (true) {
      val b = inp.read()
      if (b < 0) return if (sb.isEmpty()) null else sb.toString()
      if (b == '\n'.code) return sb.toString().trimEnd('\r')
      sb.append(b.toChar())
      if (sb.length > 8192) throw RuntimeException("cabecera muy larga")
    }
  }

  private fun leer(sock: Socket): Pedido? {
    val inp = BufferedInputStream(sock.getInputStream())
    val primera = leerLinea(inp) ?: return null
    val partes = primera.split(' ')
    if (partes.size < 2) return null
    val cab = HashMap<String, String>()
    while (true) {
      val l = leerLinea(inp) ?: break
      if (l.isEmpty()) break
      val i = l.indexOf(':'); if (i > 0) cab[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
      if (cab.size > 60) throw RuntimeException("demasiadas cabeceras")
    }
    val largo = cab["content-length"]?.toIntOrNull() ?: 0
    if (largo > 256 * 1024) throw RuntimeException("MUY_GRANDE")
    val buf = ByteArray(largo)
    var off = 0
    while (off < largo) { val n = inp.read(buf, off, largo - off); if (n < 0) break; off += n }
    return Pedido(partes[0].uppercase(), partes[1].substringBefore('?'), cab, String(buf, 0, off, Charsets.UTF_8))
  }

  private fun cors(p: Pedido?): String {
    val o = p?.cab?.get("origin") ?: return ""
    if (!Red.origenPermitido(o)) return ""
    return "Access-Control-Allow-Origin: $o\r\nVary: Origin\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
      "Access-Control-Allow-Headers: Authorization, Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n"
  }

  private fun responder(sock: Socket, p: Pedido?, codigo: Int, cuerpo: JSONObject?) {
    val txt = cuerpo?.toString()?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
    val estado = when (codigo) { 200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"; 413 -> "Payload Too Large"; 421 -> "Misdirected Request"; 429 -> "Too Many Requests"; else -> "Error" }
    val h = "HTTP/1.1 $codigo $estado\r\nConnection: close\r\nCache-Control: no-store\r\n" + cors(p) +
      (if (cuerpo != null) "Content-Type: application/json; charset=utf-8\r\n" else "") + "Content-Length: ${txt.size}\r\n\r\n"
    sock.getOutputStream().apply { write(h.toByteArray(Charsets.ISO_8859_1)); write(txt); flush() }
  }

  private fun err(e: String, m: String? = null) = JSONObject().put("ok", false).put("error", e).also { if (m != null) it.put("mensaje", m) }

  private fun atender(sock: Socket) {
    // Plazo total de la conexion (no solo por lectura): pasado, se cierra.
    val corte = reloj.schedule({ try { sock.close() } catch (_: Exception) {} }, 20, java.util.concurrent.TimeUnit.SECONDS)
    sock.use { s ->
      try {
        s.soTimeout = 15000
        val ip = Red.limpiar(s.inetAddress?.hostAddress)
        if (!Red.esIpPrivada(ip)) return
        val p = try { leer(s) } catch (e: Exception) { responder(s, null, if (e.message == "MUY_GRANDE") 413 else 400, err("PEDIDO_INVALIDO")); return } ?: return
        if (!Red.hostPermitido(p.cab["host"])) return responder(s, p, 421, err("HOST_NO_PERMITIDO"))
        val origin = p.cab["origin"]
        if (origin != null && !Red.origenPermitido(origin)) return responder(s, p, 403, err("ORIGEN_NO_PERMITIDO"))
        if (p.metodo == "OPTIONS") return responder(s, p, 204, null)
        val b = try { if (p.cuerpo.isBlank()) JSONObject() else JSONObject(p.cuerpo) } catch (_: Exception) { return responder(s, p, 400, err("JSON_INVALIDO")) }

        if (p.metodo == "GET" && p.ruta == "/v1/hola")
          return responder(s, p, 200, JSONObject().put("ok", true).put("levoprint", true).put("version", BuildConfig.VERSION_NAME).put("android", true))
        if (PrintService.desactivado)
          return responder(s, p, 423, err("AGENTE_DESACTIVADO", "Este LevoPrint esta desactivado en la consola. Activalo o vincula otro."))
        if (p.metodo == "POST" && p.ruta == "/v1/emparejar") {
          val r = Emparejador.intentar(ctx, b.optString("pin"), b.optString("nombre"), ip)
          return responder(s, p, if (r.optBoolean("ok")) 200 else if (r.optString("error") == "ESPERA") 429 else 401, r)
        }
        val auth = p.cab["authorization"] ?: ""
        val equipo = Emparejador.validar(ctx, if (auth.startsWith("Bearer ")) auth.substring(7).trim() else null)
          ?: return responder(s, p, 401, err("NO_EMPAREJADO", "Este equipo no esta emparejado con LevoPrint."))
        val ancho = Prefs.leer(ctx)?.ancho ?: 48

        when {
          p.metodo == "GET" && p.ruta == "/v1/estado" -> {
            val arr = JSONArray()
            for (e in Motor.estaciones.values) {
              val r = Motor.ruta(e.id)
              arr.put(JSONObject().put("id", e.id).put("nombre", e.nombre).put("via", Motor.describir(r)).put("transporte", r?.transporte)
                .put("fuente", Motor.fuente(e.id)).put("pendienteNube", Motor.asignacion(e.id)?.pendienteNube == true).put("cola", Motor.enCola(r)))
            }
            responder(s, p, 200, JSONObject().put("ok", true).put("version", BuildConfig.VERSION_NAME).put("prefijo", Prefs.leer(ctx)?.prefijo).put("ancho", ancho)
              .put("equipo", equipo.nombre).put("nube", JSONObject().put("enLinea", System.currentTimeMillis() - PrintService.nubeOkTs < 30000).put("okTs", PrintService.nubeOkTs)).put("estaciones", arr))
          }
          p.metodo == "GET" && p.ruta == "/v1/diario" -> {
            val arr = JSONArray()
            for (e in Motor.diario.recientes(50)) arr.put(JSONObject().put("jobId", e.k).put("estado", e.e).put("origen", e.o).put("estacion", e.est).put("tipo", e.t).put("ts", e.ts))
            responder(s, p, 200, JSONObject().put("ok", true).put("recientes", arr))
          }
          p.metodo == "GET" && p.ruta == "/v1/impresoras" -> responder(s, p, 200, Buscar.todo(ctx))
          p.metodo == "POST" && p.ruta == "/v1/refrescar" -> { alPedirRefresco(); responder(s, p, 200, JSONObject().put("ok", true)) }
          p.metodo == "POST" && p.ruta == "/v1/prueba" -> {
            val r = if (b.has("estacion")) Motor.ruta(b.optString("estacion")) else Motor.Ruta(b.optString("transporte"), b.optString("destino"))
            if (r == null) return responder(s, p, 502, err("SIN_IMPRESORA", "La estacion no tiene impresora asignada."))
            Motor.validar(r)?.let { return responder(s, p, 400, err("DESTINO_INVALIDO", it)) }
            try {
              Motor.enviar(r, Agent.render(JSONObject().put("tipo", "PRUEBA").put("payload", JSONObject()), ancho))
              responder(s, p, 200, JSONObject().put("ok", true).put("aviso", "Prueba enviada a " + Motor.describir(r) + "."))
            } catch (e: Exception) { PrintService.ultimoLog = "ERR prueba: " + e.message; responder(s, p, 502, err("IMPRESION", Motor.mensajePublico(e))) }
          }
          p.metodo == "POST" && p.ruta == "/v1/imprimir" -> {
            val jobId = b.optString("jobId")
            val tipo = b.optString("tipo")
            val est = b.optString("estacion")
            if (!Diario.jobIdValido(jobId)) return responder(s, p, 400, err("JOBID_INVALIDO", "Falta jobId (uuid del equipo)."))
            if (!Regex("^[A-Z_]{3,20}$").matches(tipo)) return responder(s, p, 400, err("TIPO_INVALIDO"))
            if (!Motor.estaciones.containsKey(est)) return responder(s, p, 404, err("ESTACION_DESCONOCIDA", "LevoPrint no conoce esa estacion (abrelo con internet una vez)."))
            val r = Motor.procesar(jobId, "LAN", est, tipo, b.optJSONObject("payload") ?: JSONObject(), ancho)
            PrintService.ultimoLog = (if (r.ok) "OK LAN " else "ERR LAN ") + tipo + " -> " + (r.via ?: "-") + (if (r.duplicado) " (repetido)" else "")
            if (r.ok) responder(s, p, 200, JSONObject().put("ok", true).put("jobId", jobId).put("via", r.via).put("duplicado", r.duplicado).put("equipo", equipo.nombre))
            else responder(s, p, 502, err("IMPRESION", r.error).put("via", r.via).put("dudoso", r.dudoso))
          }
          else -> responder(s, p, 404, err("NO_ENCONTRADO"))
        }
      } catch (_: Exception) {
      } finally { corte.cancel(false) }
    }
  }
}
