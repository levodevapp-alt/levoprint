package dev.levo.levoprint

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// [LP-F3] Busqueda de impresoras de red: las /24 de la Wi-Fi o el cable de este equipo (LinkProperties),
// connect + close al :9100 SIN mandar bytes (no imprime nada), 400 ms por equipo, 48 a la vez (~3 s).
// Mismo criterio que el .exe 1.13 (BusquedaLogica.hostsDeSubredes).
object Red {
  private const val SONDEO_MS = 400
  private const val PARALELO = 48

  // (ip, prefijo) de las redes Wi-Fi / Ethernet activas.
  @Suppress("DEPRECATION")
  fun interfaces(ctx: Context): List<Pair<String, Int>> {
    val out = ArrayList<Pair<String, Int>>()
    try {
      val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return out
      for (n in cm.allNetworks) {
        val caps = cm.getNetworkCapabilities(n) ?: continue
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) continue
        val lp = cm.getLinkProperties(n) ?: continue
        for (la in lp.linkAddresses) {
          val a = la.address
          if (a is Inet4Address) out.add((a.hostAddress ?: continue) to la.prefixLength)
        }
      }
    } catch (_: Exception) {}
    return out
  }

  private fun sondear(ip: String, puerto: Int): Boolean = try {
    Socket().use { s -> s.connect(InetSocketAddress(ip, puerto), SONDEO_MS); true }
  } catch (_: Exception) { false }

  fun buscar(ctx: Context): List<Encontrada> {
    val hosts = BusquedaLogica.hostsDeSubredes(interfaces(ctx))
    if (hosts.isEmpty()) return emptyList()
    val pool = Executors.newFixedThreadPool(PARALELO)
    try {
      val tareas = hosts.map { h -> Callable { if (sondear(h, BusquedaLogica.PUERTO_IMPRESORA)) h else null } }
      val hallados = pool.invokeAll(tareas, 30, TimeUnit.SECONDS).mapNotNull { f -> try { f.get() } catch (_: Exception) { null } }
      return hallados.sortedBy { BusquedaLogica.ipANum(it) }.map { ip ->
        Encontrada("red", ip + ":" + BusquedaLogica.PUERTO_IMPRESORA, "Impresora en " + ip,
          org.json.JSONObject().put("puerto", BusquedaLogica.PUERTO_IMPRESORA))
      }
    } finally {
      pool.shutdownNow()
    }
  }
}
