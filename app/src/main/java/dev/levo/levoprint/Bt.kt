package dev.levo.levoprint

import android.bluetooth.BluetoothAdapter
import java.util.UUID

// Impresora Bluetooth (opcional). El transporte base es LAN; esto cubre
// el caso "el local tiene una impresora BT emparejada". SPP clásico.
object Bt {
  private val SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

  data class Disp(val nombre: String, val mac: String)

  fun emparejadas(): List<Disp> {
    val a = BluetoothAdapter.getDefaultAdapter() ?: return emptyList()
    return try {
      a.bondedDevices?.map { Disp(it.name ?: it.address, it.address) } ?: emptyList()
    } catch (e: SecurityException) {
      emptyList()
    }
  }

  fun imprimir(mac: String, texto: String) {
    val a = BluetoothAdapter.getDefaultAdapter() ?: throw RuntimeException("sin Bluetooth")
    val dev = a.getRemoteDevice(mac)
    val sock = dev.createRfcommSocketToServiceRecord(SPP)
    try {
      try { a.cancelDiscovery() } catch (_: SecurityException) {}
      sock.connect()
      sock.outputStream.use { it.write(Agent.bytes(texto)); it.flush() }
    } finally {
      try { sock.close() } catch (_: Exception) {}
    }
  }
}
