<?php
/**
 * Monetiser — módulo de pago para PrestaShop 8.
 *
 * El comprador paga en el checkout seguro de Monetiser: la tienda nunca ve la
 * tarjeta (PCI DSS SAQ A). Sobre la API v1 de Monetiser.
 *
 * Referencias (la documentación web de PrestaShop no era accesible desde la
 * sesión que escribió esto; se usó el CÓDIGO FUENTE OFICIAL):
 *  - PaymentModule::validateOrder():
 *    https://github.com/PrestaShop/PrestaShop/blob/develop/classes/PaymentModule.php
 *  - PaymentOption (setCallToActionText/setAction/setModuleName):
 *    https://github.com/PrestaShop/PrestaShop/blob/develop/src/Core/Payment/PaymentOption.php
 *  - Hook actionOrderSlipAdd (devolución parcial desde el admin):
 *    https://github.com/PrestaShop/PrestaShop/blob/develop/src/Adapter/Order/Refund/OrderSlipCreator.php
 *  - Order::getIdByCartId():
 *    https://github.com/PrestaShop/PrestaShop/blob/develop/classes/order/Order.php
 */

if (!defined('_PS_VERSION_')) {
    exit;
}

require_once __DIR__ . '/lib/monetiser-core.php';

use PrestaShop\PrestaShop\Core\Payment\PaymentOption;

class Monetiser extends PaymentModule
{
    const CFG = array('MONETISER_SERVER', 'MONETISER_SECRET', 'MONETISER_WEBHOOK_SECRET');

    public function __construct()
    {
        $this->name = 'monetiser';
        $this->tab = 'payments_gateways';
        $this->version = '1.0.0';
        $this->author = 'Monetiser';
        $this->need_instance = 0;
        $this->bootstrap = true;
        $this->ps_versions_compliancy = array('min' => '8.0.0', 'max' => _PS_VERSION_);
        parent::__construct();
        $this->displayName = 'Monetiser';
        $this->description = 'Pago con tarjeta en el checkout seguro de Monetiser (la tienda nunca ve la tarjeta).';
    }

    public function install()
    {
        return parent::install()
            && $this->registerHook('paymentOptions')
            && $this->registerHook('actionOrderSlipAdd')
            && Configuration::updateValue('MONETISER_SERVER', 'https://orquestacion-def-test.onrender.com');
    }

    public function uninstall()
    {
        foreach (self::CFG as $k) {
            Configuration::deleteByName($k);
        }
        return parent::uninstall();
    }

    public function client()
    {
        return new Monetiser_Core_Client(Configuration::get('MONETISER_SERVER'), Configuration::get('MONETISER_SECRET'));
    }

    /** Configuración en el back office. */
    public function getContent()
    {
        $out = '';
        if (Tools::isSubmit('submitMonetiser')) {
            $server = trim((string) Tools::getValue('MONETISER_SERVER'));
            if (strpos($server, 'https://') !== 0) {
                $out .= $this->displayError('El servidor tiene que empezar por https://');
            } else {
                Configuration::updateValue('MONETISER_SERVER', $server);
                foreach (array('MONETISER_SECRET', 'MONETISER_WEBHOOK_SECRET') as $k) {
                    $v = trim((string) Tools::getValue($k));
                    if ($v !== '') {
                        Configuration::updateValue($k, $v); // vacío = no cambiar (no se re-enseña el secreto)
                    }
                }
                $out .= $this->displayConfirmation('Guardado.');
            }
        }
        $webhook = $this->context->link->getModuleLink($this->name, 'webhook', array(), true);
        $helper = new HelperForm();
        $helper->module = $this;
        $helper->name_controller = $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');
        $helper->currentIndex = AdminController::$currentIndex . '&configure=' . $this->name;
        $helper->submit_action = 'submitMonetiser';
        $helper->fields_value = array('MONETISER_SERVER' => Configuration::get('MONETISER_SERVER'), 'MONETISER_SECRET' => '', 'MONETISER_WEBHOOK_SECRET' => '');
        return $out . $helper->generateForm(array(array('form' => array(
            'legend' => array('title' => 'Monetiser'),
            'description' => 'URL de webhook para Monetiser: ' . $webhook,
            'input' => array(
                array('type' => 'text', 'label' => 'Servidor de Monetiser', 'name' => 'MONETISER_SERVER', 'required' => true),
                array('type' => 'password', 'label' => 'Clave secreta (ms_…)', 'name' => 'MONETISER_SECRET', 'desc' => 'Déjalo vacío para no cambiarla.'),
                array('type' => 'password', 'label' => 'Secreto de webhooks (whsec_…)', 'name' => 'MONETISER_WEBHOOK_SECRET', 'desc' => 'Déjalo vacío para no cambiarlo.'),
            ),
            'submit' => array('title' => 'Guardar'),
        ))));
    }

    public function hookPaymentOptions($params)
    {
        if (!$this->active || !Configuration::get('MONETISER_SECRET')) {
            return array();
        }
        $option = new PaymentOption();
        $option->setModuleName($this->name)
            ->setCallToActionText('Tarjeta (pago seguro con Monetiser)')
            ->setAction($this->context->link->getModuleLink($this->name, 'redirect', array(), true));
        return array($option);
    }

    /** Referencia que viaja a Monetiser: liga el pago al carrito. */
    public static function cartReference($cartId)
    {
        return 'ps-cart-' . (int) $cartId;
    }

    /**
     * Crea el pedido de PrestaShop cuando Monetiser confirma el pago. Idempotente
     * (webhook y vuelta del comprador pueden llegar los dos). Nunca se fía de la
     * URL: consulta el pago en Monetiser y CAPTURA si está solo autorizado.
     *
     * @return int|null id del pedido
     */
    public function confirmCart($cartId, $paymentId)
    {
        $existing = (int) Order::getIdByCartId((int) $cartId);
        if ($existing) {
            return $existing;
        }
        $cart = new Cart((int) $cartId);
        if (!Validate::isLoadedObject($cart)) {
            return null;
        }
        $client = $this->client();
        $payment = $client->getPayment($paymentId);
        if (!isset($payment['reference']) || $payment['reference'] !== self::cartReference($cartId)) {
            return null; // el pago no es de este carrito
        }
        if ($payment['status'] === 'authorized') {
            $payment = $client->capture($paymentId, null, 'ps-cap-' . (int) $cartId . '-' . substr(sha1($paymentId), 0, 12));
        }
        if (!in_array($payment['status'], array('captured', 'partially_captured'), true)) {
            return null;
        }
        $customer = new Customer((int) $cart->id_customer);
        $this->validateOrder(
            (int) $cart->id,
            (int) Configuration::get('PS_OS_PAYMENT'),
            $payment['amount'] / 100,
            $this->displayName,
            'Monetiser ' . $paymentId,
            array('transaction_id' => $paymentId),
            (int) $cart->id_currency,
            false,
            $customer->secure_key
        );
        return (int) $this->currentOrder;
    }

    /** Devolución desde el admin (vale de devolución / reembolso parcial). */
    public function hookActionOrderSlipAdd($params)
    {
        $order = isset($params['order']) ? $params['order'] : null;
        if (!$order || $order->module !== $this->name) {
            return;
        }
        $paymentId = '';
        foreach ($order->getOrderPaymentCollection() as $p) {
            if ($p->transaction_id) {
                $paymentId = $p->transaction_id;
            }
        }
        $slipId = (int) Db::getInstance()->getValue('SELECT id_order_slip FROM `' . _DB_PREFIX_ . 'order_slip` WHERE id_order = ' . (int) $order->id . ' ORDER BY id_order_slip DESC');
        if (!$paymentId || !$slipId) {
            return;
        }
        $slip = new OrderSlip($slipId);
        $cents = Monetiser_Core_Webhook::toCents((float) $slip->total_products_tax_incl + (float) $slip->total_shipping_tax_incl);
        try {
            $this->client()->refund($paymentId, $cents, 'Vale de devolución ' . $slipId, 'ps-slip-' . $slipId . '-' . $cents);
        } catch (Monetiser_Core_Exception $e) {
            PrestaShopLogger::addLog('Monetiser: la devolución falló (' . $e->errorCode . ') pedido ' . (int) $order->id, 3, null, 'Order', (int) $order->id, true);
        }
    }
}
