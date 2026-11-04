package com.monetiser.pos.hardware

import org.json.JSONObject

/**
 * Impresora del terminal — HUECO RESERVADO (pendiente del SDK de PAX).
 * Hoy el botón "Imprimir ticket" sale desactivado.
 */
interface ReceiptPrinter {
    val available: Boolean
    fun print(payment: JSONObject)

    companion object {
        fun current(): ReceiptPrinter = Unavailable
    }

    object Unavailable : ReceiptPrinter {
        override val available = false
        override fun print(payment: JSONObject) { /* pendiente del SDK de PAX */ }
    }
}
