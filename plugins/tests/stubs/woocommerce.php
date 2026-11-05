<?php
// STUBS MÍNIMOS de WordPress/WooCommerce para probar la lógica de la pasarela
// sin una instalación real. Solo lo que usa class-wc-gateway-monetiser.php.
define('ABSPATH', __DIR__);
define('MONETISER_WC_GATEWAY_ID', 'monetiser');
class WP_Error { public $code; public $message; function __construct($c = '', $m = '') { $this->code = $c; $this->message = $m; } }
function add_action() {}
function rest_url($p = '') { return 'https://shop.test/wp-json/' . ltrim($p, '/'); }
function wc_add_notice() {}
function wc_price($a) { return number_format((float) $a, 2) . ' €'; }
function esc_url($u) { return $u; }
function wp_json_encode($v) { return json_encode($v); }
function wc_get_order($id) { return isset($GLOBALS['wc_test_orders'][$id]) ? $GLOBALS['wc_test_orders'][$id] : null; }
function wc_get_orders($args) {
    foreach ($GLOBALS['wc_test_orders'] as $o) if (isset($o->meta[$args['meta_key']]) && $o->meta[$args['meta_key']] === $args['meta_value']) return array($o);
    return array();
}
class WC_Payment_Gateway {
    public $id; public $settings = array(); public $form_fields = array(); public $supports = array('products');
    public $title; public $description; public $enabled; public $method_title; public $method_description; public $has_fields;
    function init_settings() {}
    function get_option($k, $d = null) { return isset($this->settings[$k]) ? $this->settings[$k] : $d; }
    function get_return_url($order = null) { return 'https://shop.test/thanks/' . $order->get_id(); }
}
class WC_Order {
    public $meta = array(); public $paid = false; public $status = 'pending'; public $notes = array(); private $id; private $total; private $currency;
    function __construct($id, $total, $currency) { $this->id = $id; $this->total = $total; $this->currency = $currency; }
    function get_id() { return $this->id; }
    function get_total() { return $this->total; }
    function get_currency() { return $this->currency; }
    function get_order_number() { return (string) $this->id; }
    function get_order_key() { return 'wc_order_key_' . $this->id; }
    function update_meta_data($k, $v) { $this->meta[$k] = $v; }
    function get_meta($k) { return isset($this->meta[$k]) ? $this->meta[$k] : ''; }
    function save() {}
    function add_order_note($n) { $this->notes[] = $n; }
    function get_checkout_payment_url($x = false) { return 'https://shop.test/pay/' . $this->id; }
    function get_refunds() { return array(); }
    function is_paid() { return (bool) $this->paid; }
    function payment_complete($tx = '') { $this->paid = $tx; $this->status = 'processing'; }
    function get_status() { return $this->status; }
    function update_status($s, $n = '') { $this->status = $s; $this->notes[] = $n; }
}
