'use strict';
const Joi = require('joi');

/* Esquema de política de reglas v1 */
const amountCond = Joi.object({
  lt: Joi.number().positive().optional(),
  gt: Joi.number().positive().optional()
}).min(1);

const listStr = Joi.array().items(Joi.string().min(1)).min(1);

const whenSchema = Joi.object({
  currency: Joi.object({ in: listStr }).optional(),
  amount: amountCond.optional(),
  bin: Joi.object({ inPrefixes: listStr }).optional(),
  issuerCountry: Joi.object({ in: listStr }).optional(),
  scheme: Joi.object({ in: listStr }).optional(),
  cardType: Joi.object({ in: listStr }).optional(),
  region: Joi.object({ in: listStr }).optional()
}).min(1);

const ruleSchema = Joi.object({
  id: Joi.string().min(1).required(),
  priority: Joi.number().integer().min(0).default(0),
  when: whenSchema.required(),
  action: Joi.object({
    route: Joi.string().min(1).required()
  }).required()
});

const policySchema = Joi.object({
  merchantId: Joi.string().required(),
  version: Joi.string().valid('v1').default('v1'),
  defaultConnector: Joi.string().required(),
  rules: Joi.array().items(ruleSchema).default([]),
  fallback: Joi.object({
    order: listStr.default(['dummyCard']),
    on: listStr.default(['network_error','soft_decline'])
  }).default(),
  retries: Joi.object({
    soft_decline: Joi.number().integer().min(0).default(1),
    network_error: Joi.number().integer().min(0).default(2),
    jitterMs: Joi.array().items(Joi.number().integer().min(0)).default([200,500])
  }).default(),
  explain: Joi.boolean().default(true)
})
.required();

module.exports = { policySchema };
