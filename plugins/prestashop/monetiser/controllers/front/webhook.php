<?php
/** Webhook firmado de Monetiser → confirma el pedido (idempotente). */
class MonetiserWebhookModuleFrontController extends ModuleFrontController
{
    public $ajax = true;
    public $ssl = true;

    public function postProcess()
    {
        $raw = (string) file_get_contents('php://input');
        $sig = isset($_SERVER['HTTP_MONETISER_SIGNATURE']) ? (string) $_SERVER['HTTP_MONETISER_SIGNATURE'] : '';
        $event = Monetiser_Core_Webhook::verify($raw, $sig, (string) Configuration::get('MONETISER_WEBHOOK_SECRET'));
        if ($event === null) {
            $this->reply(401, array('received' => false, 'error' => 'invalid_signature'));
        }
        $paymentId = isset($event['data']['paymentId']) ? (string) $event['data']['paymentId'] : '';
        $ref = isset($event['data']['merchantReference']) ? (string) $event['data']['merchantReference'] : '';
        if ($paymentId === '' || !preg_match('/^ps-cart-(\d+)$/', $ref, $m)) {
            $this->reply(200, array('received' => true, 'ignored' => true));
        }
        try {
            $orderId = $this->module->confirmCart((int) $m[1], $paymentId);
        } catch (Monetiser_Core_Exception $e) {
            $this->reply(500, array('received' => false, 'error' => $e->errorCode)); // Monetiser reintentará
        }
        $this->reply(200, array('received' => true, 'orderId' => $orderId));
    }

    private function reply($status, array $body)
    {
        http_response_code($status);
        header('Content-Type: application/json');
        echo json_encode($body);
        exit;
    }
}
