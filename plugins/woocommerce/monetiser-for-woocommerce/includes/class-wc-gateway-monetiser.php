<?php
/**
 * Pasarela "Monetiser" para WooCommerce.
 *
 * Flujo:
 *  1. process_payment(): crea una sesión en la API v1 de Monetiser (importe en
 *     céntimos, referencia = nº de pedido, returnUrl = página de "gracias" del
 *     pedido, webhookUrl = /wp-json/monetiser/v1/webhook) con Idempotency-Key
 *     del pedido, y lleva al comprador al checkout de Monetiser:
 *       - "redirect" (por defecto): a pantalla completa;
 *       - "embedded": embebido en la página de pago del pedido con monetiser.js.
 *  2. Webhook firmado → se vuelve a CONSULTAR el pago en Monetiser (no se fía
 *     solo del cuerpo) → autorizado: se captura (si "captura automática") →
 *     capturado: payment_complete(). Fallido: pedido "failed".
 *  3. process_refund(): devolución total o parcial desde el admin de WooCommerce.
 *
 * La tarjeta NUNCA pasa por WooCommerce ni por este plugin (PCI DSS SAQ A).
 */

if (!defined('ABSPATH')) {
    exit;
}

class WC_Gateway_Monetiser extends WC_Payment_Gateway
{
    const META_PAYMENT_ID = '_monetiser_payment_id';

    /** @var callable|null transporte HTTP inyectable (tests) */
    public $transport = null;

    public function __construct()
    {
        $this->id = MONETISER_WC_GATEWAY_ID;
        $this->method_title = 'Monetiser';
        $this->method_description = 'Pago con tarjeta en el checkout seguro de Monetiser (la tienda nunca ve la tarjeta).';
        $this->has_fields = false;
        $this->supports = array('products', 'refunds');

        $this->init_form_fields();
        $this->init_settings();
        $this->title = $this->get_option('title', 'Tarjeta (pago seguro)');
        $this->description = $this->get_option('description', '');
        $this->enabled = $this->get_option('enabled', 'no');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, array($this, 'process_admin_options'));
        add_action('woocommerce_receipt_' . $this->id, array($this, 'receipt_page'));
    }

    public function init_form_fields()
    {
        $this->form_fields = array(
            'enabled' => array('title' => 'Activar', 'type' => 'checkbox', 'label' => 'Activar Monetiser', 'default' => 'no'),
            'title' => array('title' => 'Título', 'type' => 'text', 'default' => 'Tarjeta (pago seguro)'),
            'description' => array('title' => 'Descripción', 'type' => 'textarea', 'default' => 'Pagarás en la página segura de Monetiser.'),
            'server' => array('title' => 'Servidor de Monetiser', 'type' => 'text', 'default' => 'https://orquestacion-def-test.onrender.com', 'description' => 'https://… (pruebas o producción)'),
            'secret' => array('title' => 'Clave secreta (ms_…)', 'type' => 'password', 'description' => 'En /admin de Monetiser → Merchants → API Keys. Solo se guarda en el servidor de la tienda.'),
            'webhook_secret' => array('title' => 'Secreto de webhooks (whsec_…)', 'type' => 'password', 'description' => 'Para verificar la firma de los avisos de Monetiser. URL de webhook: ' . (function_exists('rest_url') ? rest_url('monetiser/v1/webhook') : '/wp-json/monetiser/v1/webhook')),
            'mode' => array('title' => 'Cómo se muestra el checkout', 'type' => 'select', 'options' => array('redirect' => 'A pantalla completa (redirección)', 'embedded' => 'Embebido en la tienda (monetiser.js)'), 'default' => 'redirect'),
            'auto_capture' => array('title' => 'Captura automática', 'type' => 'checkbox', 'label' => 'Cobrar al autorizarse (recomendado)', 'default' => 'yes'),
        );
    }

    protected function client()
    {
        return new Monetiser_Core_Client($this->get_option('server'), $this->get_option('secret'), $this->transport);
    }

    /** Idempotency-Key estable por pedido (+ importe): un doble clic no crea dos pagos;
     *  si el cliente cambia el carrito, el nuevo importe es otra clave. */
    protected function idempotency_key($order, $suffix = '')
    {
        return substr('wc-' . $order->get_id() . '-' . substr(hash('sha256', $order->get_order_key()), 0, 16) . $suffix, 0, 64);
    }

    public function process_payment($order_id)
    {
        $order = wc_get_order($order_id);
        if (!$order) {
            return array('result' => 'failure');
        }
        try {
            $session = $this->client()->createCheckoutSession(array(
                'amount' => Monetiser_Core_Webhook::toCents($order->get_total()),
                'currency' => strtoupper($order->get_currency()),
                'reference' => (string) $order->get_order_number(),
                'returnUrl' => $this->get_return_url($order),
                'webhookUrl' => rest_url('monetiser/v1/webhook'),
            ), $this->idempotency_key($order, '-' . Monetiser_Core_Webhook::toCents($order->get_total())));
        } catch (Monetiser_Core_Exception $e) {
            wc_add_notice('No se ha podido iniciar el pago. Inténtalo de nuevo.', 'error');
            $order->add_order_note('Monetiser: no se pudo crear la sesión (' . $e->errorCode . ').');
            return array('result' => 'failure');
        }
        $order->update_meta_data(self::META_PAYMENT_ID, $session['id']);
        $order->update_meta_data('_monetiser_checkout_url', $session['url']);
        $order->save();
        $order->add_order_note('Monetiser: sesión de pago creada (' . $session['id'] . ').');

        $redirect = $this->get_option('mode') === 'embedded' ? $order->get_checkout_payment_url(true) : $session['url'];
        return array('result' => 'success', 'redirect' => $redirect);
    }

    /** Modo embebido: el checkout de Monetiser dentro de la página de pago del pedido. */
    public function receipt_page($order_id)
    {
        $order = wc_get_order($order_id);
        $url = $order ? (string) $order->get_meta('_monetiser_checkout_url') : '';
        if (!$url) {
            return;
        }
        $server = rtrim($this->get_option('server'), '/');
        echo '<div id="monetiser-checkout"></div>';
        echo '<script src="' . esc_url($server . '/v1/monetiser.js') . '"></script>';
        echo '<script>Monetiser.mount("#monetiser-checkout", { url: ' . wp_json_encode($url) . ', onResult: function () { window.location.href = ' . wp_json_encode($this->get_return_url($order)) . '; } });</script>';
    }

    public function process_refund($order_id, $amount = null, $reason = '')
    {
        $order = wc_get_order($order_id);
        $paymentId = $order ? (string) $order->get_meta(self::META_PAYMENT_ID) : '';
        if (!$paymentId) {
            return new WP_Error('monetiser_refund', 'Este pedido no tiene pago de Monetiser.');
        }
        $cents = $amount === null ? null : Monetiser_Core_Webhook::toCents($amount);
        $n = count($order->get_refunds());
        try {
            $this->client()->refund($paymentId, $cents, $reason, $this->idempotency_key($order, '-r' . $n . '-' . ($cents === null ? 'all' : $cents)));
        } catch (Monetiser_Core_Exception $e) {
            return new WP_Error('monetiser_refund', 'Monetiser no ha podido devolver el importe (' . $e->errorCode . ').');
        }
        $order->add_order_note('Monetiser: devolución de ' . ($amount === null ? 'todo' : wc_price($amount)) . ' hecha.');
        return true;
    }

    /**
     * Webhook firmado de Monetiser. Devuelve [statusHttp, cuerpo].
     * Nunca confía solo en el cuerpo: vuelve a consultar el pago con la API.
     */
    public function handle_webhook($rawBody, $signature)
    {
        $event = Monetiser_Core_Webhook::verify($rawBody, $signature, (string) $this->get_option('webhook_secret'));
        if ($event === null) {
            return array(401, array('received' => false, 'error' => 'invalid_signature'));
        }
        $paymentId = isset($event['data']['paymentId']) ? (string) $event['data']['paymentId'] : '';
        if ($paymentId === '') {
            return array(200, array('received' => true, 'ignored' => true));
        }
        $orders = wc_get_orders(array('limit' => 1, 'meta_key' => self::META_PAYMENT_ID, 'meta_value' => $paymentId));
        $order = $orders ? $orders[0] : null;
        if (!$order) {
            return array(200, array('received' => true, 'ignored' => true));
        }
        try {
            $client = $this->client();
            $payment = $client->getPayment($paymentId);
            $status = isset($payment['status']) ? $payment['status'] : '';
            if ($status === 'authorized' && $this->get_option('auto_capture', 'yes') === 'yes') {
                $payment = $client->capture($paymentId, null, $this->idempotency_key($order, '-cap'));
                $status = isset($payment['status']) ? $payment['status'] : $status;
            }
        } catch (Monetiser_Core_Exception $e) {
            // 500 → Monetiser reintentará el aviso más tarde.
            return array(500, array('received' => false, 'error' => $e->errorCode));
        }

        if (in_array($status, array('captured', 'partially_captured'), true)) {
            if (!$order->is_paid()) {
                $order->payment_complete($paymentId);
                $order->add_order_note('Monetiser: pago cobrado (' . $paymentId . ').');
            }
        } elseif ($status === 'authorized') {
            if ($order->get_status() !== 'on-hold') {
                $order->update_status('on-hold', 'Monetiser: pago AUTORIZADO, pendiente de captura (captura automática desactivada).');
            }
        } elseif (in_array($status, array('declined', 'error', 'expired', 'cancelled'), true)) {
            if (!$order->is_paid()) {
                $order->update_status('failed', 'Monetiser: el pago no se completó (' . $status . ').');
            }
        }
        return array(200, array('received' => true, 'status' => $status));
    }
}
