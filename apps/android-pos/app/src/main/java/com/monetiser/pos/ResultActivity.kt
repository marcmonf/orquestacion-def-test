package com.monetiser.pos

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import com.monetiser.pos.hardware.ReceiptPrinter
import org.json.JSONObject

/** Pantallas finales: Pagado / Fallido / Caducado / Anulado. */
class ResultActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val state = intent.getStringExtra("state") ?: "failed"
        val payment = JSONObject(intent.getStringExtra("payment") ?: "{}")
        val (title, color, hint) = when (state) {
            "paid" -> Triple("Pagado", Ui.OK, "El cobro se ha completado.")
            "expired" -> Triple("Caducado", Ui.WARN, "El cliente no pagó a tiempo. Crea un cobro nuevo.")
            "cancelled" -> Triple("Anulado", Ui.WARN, "El cobro se ha anulado.")
            else -> Triple("Fallido", Ui.BAD, "El pago no se completó. El cliente puede reintentarlo con el mismo QR mientras no caduque, o crea uno nuevo.")
        }
        val col = Ui.column(this).apply { setBackgroundColor(color) }
        col.addView(Ui.text(this, title, 48f, bold = true, color = Color.WHITE, center = true))
        col.addView(Ui.text(this, Money.format(payment.optLong("amount"), payment.optString("currency", "EUR")), 30f, color = Color.WHITE, center = true))
        col.addView(Ui.text(this, payment.optString("concept"), 16f, color = Color.WHITE, center = true))
        col.addView(Ui.text(this, hint, 15f, color = Color.WHITE, center = true))
        // Impresora del terminal: pendiente del SDK de PAX (no lo tenemos).
        val printer = ReceiptPrinter.current()
        if (state == "paid") {
            col.addView(Ui.ghostButton(this, if (printer.available) "Imprimir ticket" else "Imprimir ticket (pendiente del SDK de PAX)") {
                if (printer.available) printer.print(payment)
            }.apply { isEnabled = printer.available })
        }
        col.addView(Ui.button(this, "Nuevo cobro", Color.BLACK) { finish() })
        setContentView(col)
    }
}
