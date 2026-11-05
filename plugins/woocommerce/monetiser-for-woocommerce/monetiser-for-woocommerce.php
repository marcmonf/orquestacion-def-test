<?php
/**
 * Plugin Name: Monetiser for WooCommerce
 * Description: Cobra con Monetiser (orquestador de pagos). El comprador paga en el checkout seguro de Monetiser: la tienda nunca ve la tarjeta (PCI DSS SAQ A).
 * Version: 1.0.0
 * Author: Monetiser
 * Requires PHP: 7.4
 * Text Domain: monetiser-for-woocommerce
 * License: Propietaria
 *
 * Referencias usadas (la documentación web de WooCommerce no era accesible desde
 * la sesión que escribió esto; se usó el CÓDIGO FUENTE OFICIAL):
 *  - WC_Payment_Gateway (process_payment, process_refund, $supports 'refunds'):
 *    https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/abstracts/abstract-wc-payment-gateway.php
 *  - Filtro 'woocommerce_payment_gateways':
 *    https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-payment-gateways.php
 *  - Acción 'woocommerce_receipt_{gateway}':
 *    https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/templates/checkout/order-receipt.php
 *  - register_rest_route (núcleo de WordPress):
 *    https://github.com/WordPress/wordpress-develop/blob/trunk/src/wp-includes/rest-api.php
 */

if (!defined('ABSPATH')) {
    exit;
}

define('MONETISER_WC_VERSION', '1.0.0');
define('MONETISER_WC_GATEWAY_ID', 'monetiser');

require_once __DIR__ . '/includes/class-monetiser-core.php';

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        return; // WooCommerce no está activo.
    }
    require_once __DIR__ . '/includes/class-wc-gateway-monetiser.php';

    add_filter('woocommerce_payment_gateways', function ($gateways) {
        $gateways[] = 'WC_Gateway_Monetiser';
        return $gateways;
    });
});

// Webhook de Monetiser → /wp-json/monetiser/v1/webhook (firma verificada).
add_action('rest_api_init', function () {
    register_rest_route('monetiser/v1', '/webhook', array(
        'methods' => 'POST',
        'permission_callback' => '__return_true', // la autenticación es la FIRMA (Monetiser-Signature)
        'callback' => function ($request) {
            if (!class_exists('WC_Gateway_Monetiser')) {
                return new WP_REST_Response(array('received' => false), 503);
            }
            $gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : array();
            $gw = isset($gateways[MONETISER_WC_GATEWAY_ID]) ? $gateways[MONETISER_WC_GATEWAY_ID] : new WC_Gateway_Monetiser();
            list($status, $body) = $gw->handle_webhook($request->get_body(), (string) $request->get_header('monetiser_signature'));
            return new WP_REST_Response($body, $status);
        },
    ));
});
