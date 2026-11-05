<?php
/** Tras "Realizar pedido": crea la sesión de pago en Monetiser y lleva al comprador al checkout. */
namespace Monetiser\Payment\Controller\Checkout;

use Magento\Framework\App\Action\HttpGetActionInterface;

class Redirect implements HttpGetActionInterface
{
    private $checkoutSession;
    private $resultRedirectFactory;
    private $url;
    private $paymentHelper;

    public function __construct(
        \Magento\Checkout\Model\Session $checkoutSession,
        \Magento\Framework\Controller\Result\RedirectFactory $resultRedirectFactory,
        \Magento\Framework\UrlInterface $url,
        \Magento\Payment\Helper\Data $paymentHelper
    ) {
        $this->checkoutSession = $checkoutSession;
        $this->resultRedirectFactory = $resultRedirectFactory;
        $this->url = $url;
        $this->paymentHelper = $paymentHelper;
    }

    public function execute()
    {
        $redirect = $this->resultRedirectFactory->create();
        $order = $this->checkoutSession->getLastRealOrder();
        if (!$order || !$order->getId() || $order->getPayment()->getMethod() !== \Monetiser\Payment\Model\Monetiser::CODE) {
            return $redirect->setPath('checkout/cart');
        }
        $method = $this->paymentHelper->getMethodInstance(\Monetiser\Payment\Model\Monetiser::CODE);
        $cents = \Monetiser_Core_Webhook::toCents($order->getGrandTotal());
        try {
            $session = $method->client()->createCheckoutSession(array(
                'amount' => $cents,
                'currency' => strtoupper((string) $order->getOrderCurrencyCode()),
                'reference' => 'mg-' . $order->getIncrementId(),
                'returnUrl' => $this->url->getUrl('checkout/onepage/success'),
                'webhookUrl' => $this->url->getUrl('monetiser/webhook/index'),
            ), 'mg-' . preg_replace('/[^A-Za-z0-9]/', '', (string) $order->getIncrementId()) . '-' . $cents);
        } catch (\Monetiser_Core_Exception $e) {
            $this->checkoutSession->restoreQuote();
            return $redirect->setPath('checkout/cart');
        }
        $order->getPayment()->setAdditionalInformation('monetiser_payment_id', $session['id']);
        $order->addCommentToStatusHistory('Monetiser: sesión de pago creada (' . $session['id'] . ').');
        $order->save();
        return $redirect->setUrl($session['url']);
    }
}
