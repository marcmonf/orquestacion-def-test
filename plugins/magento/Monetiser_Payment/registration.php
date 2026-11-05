<?php
/**
 * Monetiser — método de pago para Magento 2 / Adobe Commerce.
 * La documentación web de Adobe no era accesible desde la sesión que escribió
 * esto: la estructura copia la de los métodos de pago del PROPIO Magento
 * (Magento_OfflinePayments, Checkmo):
 * https://github.com/magento/magento2/tree/2.4-develop/app/code/Magento/OfflinePayments
 */
use Magento\Framework\Component\ComponentRegistrar;

ComponentRegistrar::register(ComponentRegistrar::MODULE, 'Monetiser_Payment', __DIR__);
