package com.monetiser.pos.hardware

/**
 * Lector de tarjeta del terminal — HUECO RESERVADO.
 *
 * No tenemos el SDK de PAX: hoy NO se lee ninguna tarjeta en el terminal (el
 * cobro es con QR en el móvil del cliente). Cuando llegue el SDK y un
 * adquirente con capacidad card present (capabilities.cardPresent, F5), aquí
 * va la implementación. PCI: la lectura de la tarjeta tendrá que hacerla el
 * kernel certificado del terminal (P2PE); la app nunca debe ver el PAN.
 */
interface CardReader {
    val available: Boolean

    companion object {
        fun current(): CardReader = Unavailable
    }

    object Unavailable : CardReader {
        override val available = false
    }
}
