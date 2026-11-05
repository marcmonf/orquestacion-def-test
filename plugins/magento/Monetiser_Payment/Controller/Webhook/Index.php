<?php
/**
 * Webhook firmado de Monetiser (sin CSRF: la autenticación es la firma
 * Monetiser-Signature). Vuelve a consultar el pago en Monetiser, captura si está
 * solo autorizado y factura el pedido (registerCaptureNotification).
 */
namespace Monetiser\Payment\Controller\Webhook;

use Magento\Framework\App\Action\HttpPostActionInterface;
use Magento\Framework\App\CsrfAwareActionInterface;
use Magento\Framework\App\Request\InvalidRequestException;
use Magento\Framework\App\RequestInterface;

class Index implements HttpPostActionInterface, CsrfAwareActionInterface
{
    private $request;
    private $resultJsonFactory;
    private $orderFactory;
    private $paymentHelper;

    public function __construct(
        RequestInterface $request,
        \Magento\Framework\Controller\Result\JsonFactory $resultJsonFactory,
        \Magento\Sales\Model\OrderFactory $orderFactory,
        \Magento\Payment\Helper\Data $paymentHelper
    ) {
        $this->request = $request;
        $this->resultJsonFactory = $resultJsonFactory;
        $this->orderFactory = $orderFactory;
        $this->paymentHelper = $paymentHelper;
    }

    public function createCsrfValidationException(RequestInterface $request): ?InvalidRequestException
    {
        return null;
    }

    public function validateForCsrf(RequestInterface $request): ?bool
    {
        return true;
    }

    public function execute()
    {
        $json = $this->resultJsonFactory->create();
        $method = $this->paymentHelper->getMethodInstance(\Monetiser\Payment\Model\Monetiser::CODE);
        $raw = (string) $this->request->getContent();
        $sig = (string) $this->request->getHeader('Monetiser-Signature');
        $event = \Monetiser_Core_Webhook::verify($raw, $sig, $method->secretConfig('webhook_secret'));
        if ($event === null) {
            return $json->setHttpResponseCode(401)->setData(array('received' => false, 'error' => 'invalid_signature'));
        }
        $paymentId = isset($event['data']['paymentId']) ? (string) $event['data']['paymentId'] : '';
        $ref = isset($event['data']['merchantReference']) ? (string) $event['data']['merchantReference'] : '';
        if ($paymentId === '' || strpos($ref, 'mg-') !== 0) {
            return $json->setData(array('received' => true, 'ignored' => true));
        }
        $order = $this->orderFactory->create()->loadByIncrementId(substr($ref, 3));
        if (!$order->getId() || (string) $order->getPayment()->getAdditionalInformation('monetiser_payment_id') !== $paymentId) {
            return $json->setData(array('received' => true, 'ignored' => true));
        }
        try {
            $client = $method->client();
            $payment = $client->getPayment($paymentId);
            if ($payment['status'] === 'authorized') {
                $payment = $client->capture($paymentId, null, 'mg-cap-' . preg_replace('/[^A-Za-z0-9]/', '', (string) $order->getIncrementId()));
            }
        } catch (\Monetiser_Core_Exception $e) {
            return $json->setHttpResponseCode(500)->setData(array('received' => false, 'error' => $e->errorCode));
        }
        if (in_array($payment['status'], array('captured', 'partially_captured'), true) && $order->getState() === \Magento\Sales\Model\Order::STATE_PENDING_PAYMENT) {
            $p = $order->getPayment();
            $p->setTransactionId($paymentId)->setIsTransactionClosed(false);
            $p->registerCaptureNotification($payment['amount'] / 100);
            $order->addCommentToStatusHistory('Monetiser: pago cobrado (' . $paymentId . ').');
            $order->save();
        } elseif (in_array($payment['status'], array('declined', 'error', 'expired', 'cancelled'), true) && $order->canCancel()) {
            $order->cancel()->addCommentToStatusHistory('Monetiser: el pago no se completó (' . $payment['status'] . ').');
            $order->save();
        }
        return $json->setData(array('received' => true, 'status' => $payment['status']));
    }
}
