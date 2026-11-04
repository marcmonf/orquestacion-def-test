package com.monetiser.pos

/** Importes en céntimos (enteros), como en toda la API de Monetiser. */
object Money {
    fun format(cents: Long, currency: String = "EUR"): String {
        val abs = kotlin.math.abs(cents)
        val units = abs / 100
        val dec = (abs % 100).toString().padStart(2, '0')
        val grouped = units.toString().reversed().chunked(3).joinToString(".").reversed()
        return (if (cents < 0) "-" else "") + "$grouped,$dec ${if (currency == "EUR") "€" else currency}"
    }
}
