<?php
/** Vuelta del comprador desde Monetiser: confirma (consultando a Monetiser) y muestra el pedido. */
class MonetiserReturnModuleFrontController extends ModuleFrontController
{
    public function postProcess()
    {
        $cartId = (int) Tools::getValue('cart');
        $paymentId = (string) Tools::getValue('paymentId');
        $cart = new Cart($cartId);
        if (!Validate::isLoadedObject($cart) || (int) $cart->id_customer !== (int) $this->context->customer->id) {
            Tools::redirect('index.php');
        }
        if ($paymentId === '') {
            $paymentId = (string) $this->context->cookie->__get('monetiser_payment_' . $cartId);
        }
        $orderId = null;
        try {
            $orderId = $paymentId !== '' ? $this->module->confirmCart($cartId, $paymentId) : null;
        } catch (Monetiser_Core_Exception $e) {
            $orderId = null;
        }
        if ($orderId) {
            $customer = new Customer((int) $cart->id_customer);
            Tools::redirect('index.php?controller=order-confirmation&id_cart=' . $cartId . '&id_module=' . (int) $this->module->id . '&id_order=' . $orderId . '&key=' . $customer->secure_key);
        }
        // Pago no completado (o aún sin confirmar): vuelta al carrito con aviso.
        $this->errors[] = 'El pago no se ha completado. Si lo has pagado, recibirás la confirmación en unos minutos.';
        $this->redirectWithNotifications('index.php?controller=order&step=1');
    }
}
