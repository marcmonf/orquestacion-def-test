package com.monetiser.pos

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Cliente fino de la API de Monetiser para el terminal:
 *   POST /portal/auth/login  → JWT del portal (usuario ligado a su tienda)
 *   /pos/*                   → cobros con QR (ver src/routes/pos.js)
 *
 * NUNCA lleva la clave ms_ del comercio: solo el token de sesión del usuario,
 * que caduca y se revoca desde el portal.
 */
class Api(private val baseUrl: String, private val token: String?) {

    class Response(val status: Int, val body: JSONObject) {
        val ok: Boolean get() = status in 200..299
        val error: String get() = body.optString("error", "http_$status")
    }

    class SessionExpired : Exception("session_expired")

    fun request(method: String, path: String, body: JSONObject? = null): Response {
        val conn = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "MonetiserPOS/${BuildConfig.VERSION_NAME}")
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        try {
            if (body != null) conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (status == 401 && token != null) throw SessionExpired()
            return Response(status, json)
        } finally {
            conn.disconnect()
        }
    }

    /** Descarga una imagen (el QR en PNG). Solo HTTPS del mismo servidor. */
    fun bitmap(url: String): Bitmap? {
        if (!url.startsWith("https://")) return null
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
        }
        try {
            if (conn.responseCode != 200) return null
            val bytes = ByteArrayOutputStream().also { out -> conn.inputStream.use { it.copyTo(out) } }.toByteArray()
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } finally {
            conn.disconnect()
        }
    }
}
