<?php
/**
 * Tests de los plugins de Monetiser (sin frameworks: `php plugins/tests/run.php`).
 *
 * 1. Núcleo común (plugins/_core/MonetiserClient.php): firma de webhooks,
 *    peticiones a la API v1, errores, rechazo de datos de tarjeta.
 * 2. Las copias del núcleo en cada plugin son IDÉNTICAS a la fuente única.
 * 3. Pasarela de WooCommerce con STUBS MÍNIMOS de WordPress/WooCommerce (no es
 *    una instalación real: ver plugins/README.md).
 */

$failures = 0; $passes = 0;
function check($cond, $name) {
    global $failures, $passes;
    if ($cond) { $passes++; echo "  ✓ $name\n"; } else { $failures++; echo "  ✗ $name\n"; }
}

require __DIR__ . '/../_core/MonetiserClient.php';

echo "Núcleo — firma de webhooks\n";
$secret = 'whsec_test';
$body = json_encode(array('id' => 'evt_1', 'event' => 'payment.updated', 'data' => array('paymentId' => 'p1', 'status' => 'authorized')));
$t = 1793000000;
$sig = 't=' . $t . ', v1=' . hash_hmac('sha256', $t . '.' . $body, $secret);
check(Monetiser_Core_Webhook::verify($body, $sig, $secret, 300, $t + 10)['data']['paymentId'] === 'p1', 'firma válida → evento');
check(Monetiser_Core_Webhook::verify($body . ' ', $sig, $secret, 300, $t) === null, 'cuerpo alterado → null');
check(Monetiser_Core_Webhook::verify($body, $sig, 'otro', 300, $t) === null, 'otro secreto → null');
check(Monetiser_Core_Webhook::verify($body, $sig, $secret, 300, $t + 301) === null, 'fuera de tolerancia (5 min) → null');
check(Monetiser_Core_Webhook::verify($body, 'v1=' . hash_hmac('sha256', $t . '.' . $body, $secret), $secret, 300, $t) === null, 'sin t= → null');
check(Monetiser_Core_Webhook::verify($body, '', $secret) === null, 'sin cabecera → null');
check(Monetiser_Core_Webhook::verify($body, $sig, '', 300, $t) === null, 'sin secreto configurado → null (fail-closed)');
$sigTwo = 't=' . $t . ', v1=deadbeef, v1=' . hash_hmac('sha256', $t . '.' . $body, $secret);
check(Monetiser_Core_Webhook::verify($body, $sigTwo, $secret, 300, $t) !== null, 'varias firmas v1 (rotación) → acepta la buena');
check(Monetiser_Core_Webhook::toCents('19.99') === 1999 && Monetiser_Core_Webhook::toCents(0.1 + 0.2) === 30, 'toCents sin errores de coma flotante');

echo "Núcleo — API v1\n";
$calls = array();
$fake = function ($method, $url, $headers, $body) use (&$calls) {
    $calls[] = compact('method', 'url', 'headers', 'body');
    if (strpos($url, '/v1/checkout-sessions') !== false) return array('status' => 201, 'body' => json_encode(array('id' => 'pay_1', 'url' => 'https://m.test/hpp/x')));
    if (strpos($url, '/refund') !== false) return array('status' => 409, 'body' => json_encode(array('success' => false, 'error' => 'capture_required', 'message' => 'no capturado')));
    return array('status' => 200, 'body' => json_encode(array('id' => 'pay_1', 'status' => 'authorized')));
};
$c = new Monetiser_Core_Client('https://m.test/', 'ms_test_abc', $fake);
$s = $c->createCheckoutSession(array('amount' => 1999, 'currency' => 'EUR', 'reference' => '1001'), 'wc-1001-abcdef12');
check($s['id'] === 'pay_1', 'crea la sesión');
check($calls[0]['method'] === 'POST' && $calls[0]['url'] === 'https://m.test/v1/checkout-sessions', 'POST a /v1/checkout-sessions');
check($calls[0]['headers']['Authorization'] === 'Bearer ms_test_abc' && $calls[0]['headers']['Idempotency-Key'] === 'wc-1001-abcdef12', 'Bearer ms_ e Idempotency-Key');
check(json_decode($calls[0]['body'], true) === array('amount' => 1999, 'currency' => 'EUR', 'reference' => '1001'), 'cuerpo JSON exacto');
$err = null; try { $c->refund('pay_1', 500, 'x', 'wc-1001-r0-500'); } catch (Monetiser_Core_Exception $e) { $err = $e; }
check($err && $err->httpStatus === 409 && $err->errorCode === 'capture_required', 'errores de la API → excepción con código estable');
$err = null; try { $c->createCheckoutSession(array('amount' => 100, 'currency' => 'EUR', 'cardNumber' => '4111111111111111')); } catch (Monetiser_Core_Exception $e) { $err = $e; }
check($err && $err->errorCode === 'card_data_not_accepted' && count($calls) === 2, 'nunca envía datos de tarjeta (ni llama a la API)');
$err = null; try { new Monetiser_Core_Client('http://m.test', 'ms_x'); } catch (Monetiser_Core_Exception $e) { $err = $e; }
check($err && $err->errorCode === 'invalid_base_url', 'solo https');
$err = null; try { new Monetiser_Core_Client('https://m.test', 'mk_x'); } catch (Monetiser_Core_Exception $e) { $err = $e; }
check($err && $err->errorCode === 'invalid_secret', 'rechaza el identificador público mk_');
$err = null; try { $c->capture('pay_1', null, 'live:abcdefgh'); } catch (Monetiser_Core_Exception $e) { $err = $e; }
check($err && $err->errorCode === 'invalid_idempotency_key', 'Idempotency-Key con prefijo reservado live: → rechazada');

echo "Copias del núcleo\n";
$core = file_get_contents(__DIR__ . '/../_core/MonetiserClient.php');
foreach (glob(__DIR__ . '/../*/*/{includes,lib,Model/Core}/*core*.php', GLOB_BRACE) ?: array() as $copy) {
    check(file_get_contents($copy) === $core, 'idéntica: ' . str_replace(realpath(__DIR__ . '/..') . '/', '', realpath($copy)));
}

echo "WooCommerce — pasarela (stubs)\n";
require __DIR__ . '/stubs/woocommerce.php';
require __DIR__ . '/../woocommerce/monetiser-for-woocommerce/includes/class-wc-gateway-monetiser.php';
$GLOBALS['wc_test_orders'] = array();
$order = new WC_Order(1001, 25.5, 'EUR');
$GLOBALS['wc_test_orders'][1001] = $order;
$gw = new WC_Gateway_Monetiser();
$gw->settings = array('server' => 'https://m.test', 'secret' => 'ms_test_abc', 'webhook_secret' => 'whsec_test', 'mode' => 'redirect', 'auto_capture' => 'yes');
$calls = array();
$state = 'authorized';
$gw->transport = function ($method, $url, $headers, $body) use (&$calls, &$state) {
    $calls[] = compact('method', 'url', 'headers', 'body');
    if (substr($url, -21) === '/v1/checkout-sessions') return array('status' => 201, 'body' => json_encode(array('id' => 'pay_9', 'url' => 'https://m.test/hpp/abc')));
    if (substr($url, -8) === '/capture') { $state = 'captured'; return array('status' => 200, 'body' => json_encode(array('id' => 'pay_9', 'status' => 'captured'))); }
    if (substr($url, -7) === '/refund') return array('status' => 200, 'body' => json_encode(array('id' => 'pay_9', 'status' => 'partially_refunded')));
    return array('status' => 200, 'body' => json_encode(array('id' => 'pay_9', 'status' => $state)));
};
$r = $gw->process_payment(1001);
check($r === array('result' => 'success', 'redirect' => 'https://m.test/hpp/abc'), 'process_payment → redirección al checkout de Monetiser');
$sent = json_decode($calls[0]['body'], true);
check($sent['amount'] === 2550 && $sent['currency'] === 'EUR' && $sent['reference'] === '1001', 'importe en céntimos y referencia = nº de pedido');
check(strpos($sent['webhookUrl'], '/wp-json/monetiser/v1/webhook') !== false && $sent['returnUrl'] === 'https://shop.test/thanks/1001', 'webhookUrl y returnUrl');
check($order->meta['_monetiser_payment_id'] === 'pay_9', 'guarda el paymentId en el pedido');
$gw->process_payment(1001);
check($calls[1]['headers']['Idempotency-Key'] === $calls[0]['headers']['Idempotency-Key'], 'misma Idempotency-Key en un reintento (sin doble pago)');

$evt = json_encode(array('id' => 'evt_9', 'event' => 'payment.updated', 'data' => array('paymentId' => 'pay_9', 'status' => 'authorized')));
list($st) = $gw->handle_webhook($evt, 't=' . time() . ', v1=00');
check($st === 401 && !$order->paid, 'webhook con firma mala → 401 y el pedido NO se marca pagado');
$ts = time();
list($st, $out) = $gw->handle_webhook($evt, 't=' . $ts . ', v1=' . hash_hmac('sha256', $ts . '.' . $evt, 'whsec_test'));
check($st === 200 && $out['status'] === 'captured' && $order->paid === 'pay_9', 'webhook válido → consulta, captura y payment_complete');
$caps = array_filter($calls, function ($x) { return substr($x['url'], -8) === '/capture'; });
check(count($caps) === 1, 'captura UNA vez');

$res = $gw->process_refund(1001, 10.00, 'Devolución parcial');
$last = end($calls);
check($res === true && substr($last['url'], -7) === '/refund' && json_decode($last['body'], true) === array('amount' => 1000, 'reason' => 'Devolución parcial'), 'process_refund → POST /refund con 1000 céntimos');

$o2 = new WC_Order(1002, 5, 'EUR'); $GLOBALS['wc_test_orders'][1002] = $o2;
$res = $gw->process_refund(1002, 5, '');
check($res instanceof WP_Error, 'refund de un pedido sin pago de Monetiser → error claro');

echo "\n" . $passes . ' OK, ' . $failures . " fallos\n";
exit($failures ? 1 : 0);
