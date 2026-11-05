define([
    'Magento_Checkout/js/view/payment/default',
    'mage/url'
], function (Component, url) {
    'use strict';

    return Component.extend({
        defaults: {
            template: 'Monetiser_Payment/payment/monetiser',
            // El pago se hace en el checkout de Monetiser: tras crear el pedido,
            // a nuestro controlador, que crea la sesión y redirige.
            redirectAfterPlaceOrder: false
        },

        afterPlaceOrder: function () {
            window.location.replace(url.build('monetiser/checkout/redirect'));
        }
    });
});
