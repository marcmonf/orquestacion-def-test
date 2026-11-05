<?php
/** Crea la sesión de pago en Monetiser para el carrito y lleva al comprador al checkout. */
class MonetiserRedirectModuleFrontController extends ModuleFrontController
{
    public function postProcess()
    {
        $cart = $this->context->cart;
        if (!$cart->id || !$cart->id_customer || !$this->module->active) {
            Tools::redirect('index.php?controller=order&step=1');
        }
        $currency = new Currency((int) $cart->id_currency);
        $total = (float) $cart->getOrderTotal(true, Cart::BOTH);
        $cents = Monetiser_Core_Webhook::toCents($total);
        try {
            $session = $this->module->client()->createCheckoutSession(array(
                'amount' => $cents,
                'currency' => strtoupper($currency->iso_code),
                'reference' => Monetiser::cartReference($cart->id),
                'returnUrl' => $this->context->link->getModuleLink('monetiser', 'return', array('cart' => (int) $cart->id), true),
                'webhookUrl' => $this->context->link->getModuleLink('monetiser', 'webhook', array(), true),
            ), 'ps-cart-' . (int) $cart->id . '-' . $cents);
        } catch (Monetiser_Core_Exception $e) {
            $this->errors[] = 'No se ha podido iniciar el pago. Inténtalo de nuevo.';
            $this->redirectWithNotifications('index.php?controller=order&step=1');
            return;
        }
        $this->context->cookie->__set('monetiser_payment_' . (int) $cart->id, $session['id']);
        Tools::redirect($session['url']);
    }
}
