<?php
/**
 * Método de pago Monetiser (patrón de Magento\OfflinePayments\Model\Checkmo, sobre
 * Magento\Payment\Model\Method\AbstractMethod — marcado @deprecated por Adobe en
 * favor del "payment gateway framework", pero es el que siguen usando los métodos
 * de pago del propio Magento; migrarlo es una DECISIÓN PENDIENTE).
 *
 * El pedido se crea en "pending_payment"; tras "Realizar pedido" el comprador va a
 * monetiser/checkout/redirect → checkout de Monetiser. La tarjeta nunca pasa por
 * Magento (PCI DSS SAQ A). Devoluciones desde la nota de crédito (online).
 */
namespace Monetiser\Payment\Model;

require_once __DIR__ . '/../lib/monetiser-core.php';

class Monetiser extends \Magento\Payment\Model\Method\AbstractMethod
{
    const CODE = 'monetiser';

    protected $_code = self::CODE;
    protected $_isGateway = true;
    protected $_isInitializeNeeded = true;   // el pedido NO se factura al crearse
    protected $_canUseCheckout = true;
    protected $_canRefund = true;
    protected $_canRefundInvoicePartial = true;

    /** El pedido queda pendiente de pago hasta que Monetiser lo confirme. */
    public function initialize($paymentAction, $stateObject)
    {
        $stateObject->setState(\Magento\Sales\Model\Order::STATE_PENDING_PAYMENT);
        $stateObject->setStatus('pending_payment');
        $stateObject->setIsNotified(false);
        return $this;
    }

    /** Campos guardados con backend "Encrypted" (system.xml): se descifran al leerlos. */
    public function secretConfig($field)
    {
        $stored = (string) $this->getConfigData($field);
        if ($stored === '') {
            return '';
        }
        $encryptor = \Magento\Framework\App\ObjectManager::getInstance()->get(\Magento\Framework\Encryption\EncryptorInterface::class);
        return (string) $encryptor->decrypt($stored);
    }

    public function client()
    {
        return new \Monetiser_Core_Client((string) $this->getConfigData('server'), $this->secretConfig('secret'));
    }

    public function refund(\Magento\Payment\Model\InfoInterface $payment, $amount)
    {
        $paymentId = (string) $payment->getAdditionalInformation('monetiser_payment_id');
        if ($paymentId === '') {
            throw new \Magento\Framework\Exception\LocalizedException(__('Este pedido no tiene pago de Monetiser.'));
        }
        $cents = \Monetiser_Core_Webhook::toCents($amount);
        $creditmemo = $payment->getCreditmemo();
        $key = 'mg-refund-' . $payment->getParentId() . '-' . ($creditmemo && $creditmemo->getIncrementId() ? $creditmemo->getIncrementId() : $cents);
        try {
            $this->client()->refund($paymentId, $cents, 'Nota de crédito', substr(preg_replace('/[^A-Za-z0-9_.:-]/', '-', $key), 0, 64));
        } catch (\Monetiser_Core_Exception $e) {
            throw new \Magento\Framework\Exception\LocalizedException(__('Monetiser no ha podido devolver el importe (%1).', $e->errorCode));
        }
        return $this;
    }
}
