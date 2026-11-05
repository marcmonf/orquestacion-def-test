<?php
/**
 * Monetiser — núcleo PHP común de los plugins de e-commerce (sin dependencias).
 *
 * FUENTE ÚNICA: plugins/_core/MonetiserClient.php. Cada plugin lleva una COPIA
 * idéntica (plugins/tests/run.php comprueba que no se desvían).
 *
 * - Habla SOLO con la API v1 de Monetiser (Authorization: Bearer ms_...).
 * - La tarjeta NUNCA pasa por la tienda: el comprador paga en el checkout de
 *   Monetiser (PCI DSS SAQ A). Este cliente rechaza cualquier campo de tarjeta.
 * - Verifica la firma de los webhooks: cabecera
 *   "Monetiser-Signature: t=<unix>, v1=<hex>" = HMAC-SHA256(secreto, "<t>.<cuerpo>").
 *
 * Documentación de la API: docs/integracion.md del repositorio de Monetiser.
 */

if (!class_exists('Monetiser_Core_Client')) {

class Monetiser_Core_Exception extends Exception
{
    /** @var int */
    public $httpStatus;
    /** @var string */
    public $errorCode;

    public function __construct($message, $httpStatus = 0, $errorCode = '')
    {
        parent::__construct($message);
        $this->httpStatus = (int) $httpStatus;
        $this->errorCode = (string) $errorCode;
    }
}

class Monetiser_Core_Client
{
    const VERSION = '1.0.0';

    /** @var string */
    private $baseUrl;
    /** @var string */
    private $secret;
    /** @var callable */
    private $transport;

    /**
     * @param string        $baseUrl   https://… del servidor de Monetiser
     * @param string        $secret    clave secreta ms_… (solo en el servidor de la tienda)
     * @param callable|null $transport function(string $method, string $url, array $headers, ?string $body): array{status:int, body:string}
     */
    public function __construct($baseUrl, $secret, $transport = null)
    {
        $baseUrl = rtrim((string) $baseUrl, '/');
        if (strpos($baseUrl, 'https://') !== 0) {
            throw new Monetiser_Core_Exception('La URL de Monetiser tiene que empezar por https://', 0, 'invalid_base_url');
        }
        if (strpos((string) $secret, 'ms_') !== 0) {
            throw new Monetiser_Core_Exception('La clave tiene que ser el SECRETO ms_… (no el identificador mk_…)', 0, 'invalid_secret');
        }
        $this->baseUrl = $baseUrl;
        $this->secret = (string) $secret;
        $this->transport = $transport ?: array(__CLASS__, 'curlTransport');
    }

    /** Crea una sesión de pago → ['id' => …, 'url' => …, …]. Importes en CÉNTIMOS. */
    public function createCheckoutSession(array $params, $idempotencyKey = null)
    {
        foreach (array('card', 'cardNumber', 'pan', 'cvv', 'cvc') as $k) {
            if (array_key_exists($k, $params)) {
                throw new Monetiser_Core_Exception('Nunca se envían datos de tarjeta a Monetiser', 0, 'card_data_not_accepted');
            }
        }
        if (!isset($params['amount']) || !is_int($params['amount']) || $params['amount'] < 1) {
            throw new Monetiser_Core_Exception('amount: entero en céntimos ≥ 1', 0, 'invalid_amount');
        }
        return $this->request('POST', '/v1/checkout-sessions', $params, $idempotencyKey);
    }

    public function getPayment($paymentId)
    {
        return $this->request('GET', '/v1/payments/' . rawurlencode((string) $paymentId), null, null);
    }

    public function capture($paymentId, $amount = null, $idempotencyKey = null)
    {
        $body = $amount === null ? array() : array('amount' => (int) $amount);
        return $this->request('POST', '/v1/payments/' . rawurlencode((string) $paymentId) . '/capture', $body, $idempotencyKey);
    }

    public function refund($paymentId, $amount = null, $reason = null, $idempotencyKey = null)
    {
        $body = array();
        if ($amount !== null) $body['amount'] = (int) $amount;
        if ($reason !== null && $reason !== '') $body['reason'] = mb_substr((string) $reason, 0, 200);
        return $this->request('POST', '/v1/payments/' . rawurlencode((string) $paymentId) . '/refund', $body, $idempotencyKey);
    }

    public function cancel($paymentId, $idempotencyKey = null)
    {
        return $this->request('POST', '/v1/payments/' . rawurlencode((string) $paymentId) . '/cancel', array(), $idempotencyKey);
    }

    private function request($method, $path, $body, $idempotencyKey)
    {
        $headers = array(
            'Authorization' => 'Bearer ' . $this->secret,
            'Accept' => 'application/json',
            'User-Agent' => 'Monetiser-PHP/' . self::VERSION,
        );
        $json = null;
        if ($body !== null) {
            $headers['Content-Type'] = 'application/json';
            $json = json_encode($body === array() ? new stdClass() : $body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        if ($idempotencyKey !== null) {
            if (!preg_match('/^[A-Za-z0-9_.:-]{8,64}$/', $idempotencyKey) || stripos($idempotencyKey, 'live:') === 0) {
                throw new Monetiser_Core_Exception('Idempotency-Key no válida', 0, 'invalid_idempotency_key');
            }
            $headers['Idempotency-Key'] = $idempotencyKey;
        }
        $res = call_user_func($this->transport, $method, $this->baseUrl . $path, $headers, $json);
        $status = (int) (isset($res['status']) ? $res['status'] : 0);
        $data = json_decode(isset($res['body']) ? (string) $res['body'] : '', true);
        if (!is_array($data)) $data = array();
        if ($status < 200 || $status >= 300) {
            $code = isset($data['error']) ? (string) $data['error'] : 'http_' . $status;
            $msg = isset($data['message']) ? (string) $data['message'] : $code;
            throw new Monetiser_Core_Exception($msg, $status, $code);
        }
        return $data;
    }

    /** Transporte por defecto (cURL), con verificación TLS SIEMPRE activa. */
    public static function curlTransport($method, $url, array $headers, $body)
    {
        $ch = curl_init($url);
        $h = array();
        foreach ($headers as $k => $v) $h[] = $k . ': ' . $v;
        curl_setopt_array($ch, array(
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $h,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ));
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $out = curl_exec($ch);
        if ($out === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new Monetiser_Core_Exception('Sin conexión con Monetiser: ' . $err, 0, 'network_error');
        }
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return array('status' => $status, 'body' => $out);
    }
}

class Monetiser_Core_Webhook
{
    /**
     * Verifica la cabecera Monetiser-Signature sobre el CUERPO CRUDO recibido.
     * Tolerancia de 5 min contra reenvíos antiguos. Comparación en tiempo constante.
     *
     * @return array|null el evento decodificado si la firma es válida; null si no.
     */
    public static function verify($rawBody, $signatureHeader, $secret, $tolerance = 300, $now = null)
    {
        if (!is_string($rawBody) || $rawBody === '' || !is_string($signatureHeader) || $secret === '' || $secret === null) return null;
        $t = null;
        $sigs = array();
        foreach (explode(',', $signatureHeader) as $part) {
            $kv = explode('=', trim($part), 2);
            if (count($kv) !== 2) continue;
            if ($kv[0] === 't') $t = $kv[1];
            if ($kv[0] === 'v1') $sigs[] = $kv[1];
        }
        if ($t === null || !ctype_digit($t) || !$sigs) return null;
        $now = $now === null ? time() : (int) $now;
        if (abs($now - (int) $t) > $tolerance) return null;
        $expected = hash_hmac('sha256', $t . '.' . $rawBody, (string) $secret);
        $ok = false;
        foreach ($sigs as $s) {
            if (hash_equals($expected, $s)) $ok = true;
        }
        if (!$ok) return null;
        $event = json_decode($rawBody, true);
        return is_array($event) ? $event : null;
    }

    /** Importe de la tienda (decimal) → céntimos, sin errores de coma flotante. */
    public static function toCents($amount)
    {
        return (int) round(((float) $amount) * 100);
    }
}

}
