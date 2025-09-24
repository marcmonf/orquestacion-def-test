'use strict';

const Joi = require('joi');

const cmpNumber = Joi.object({
  lte: Joi.number(),
  lt:  Joi.number(),
  eq:  Joi.number(),
  gt:  Joi.number(),
  gte: Joi.number()
}).unknown(false);

const whenSchema = Joi.object({
  // Básicos
  bin: Joi.object({
    inPrefixes: Joi.array().items(Joi.string().pattern(/^\d{1,10}$/)).min(1)
  }).unknown(false),
  scheme: Joi.object({
    in: Joi.array().items(Joi.string().valid('visa','mastercard','amex','diners','discover','jcb','mir','elo','hiper')).min(1)
  }).unknown(false),
  issuerCountry: Joi.object({
    in: Joi.array().items(Joi.string().uppercase().length(2)).min(1)
  }).unknown(false),
  cardType: Joi.object({
    in: Joi.array().items(Joi.string().valid('credit','debit','prepaid','corporate')).min(1)
  }).unknown(false),
  currency: Joi.object({
    in: Joi.array().items(Joi.string().uppercase().length(3)).min(1)
  }).unknown(false),
  amount: cmpNumber,

  // Tiempo
  dayOfWeek: Joi.object({
    in: Joi.array().items(Joi.number().integer().min(0).max(6)).min(1)
  }).unknown(false),
  hour: Joi.object({
    inRange: Joi.array().ordered(
      Joi.number().integer().min(0).max(23),
      Joi.number().integer().min(0).max(23)
    ).length(2)
  }).unknown(false),

  // Avanzados (permitidos siempre; el motor los ignora si el flag no está activo)
  latencyP50: Joi.object({ lte: Joi.number().min(0) }).unknown(false),
  latencyMs:  Joi.object({ lte: Joi.number().min(0) }).unknown(false),
  successRate: Joi.object({ gte: Joi.number().min(0).max(1) }).unknown(false),
  saturation:  Joi.object({ lt:  Joi.number().min(0).max(1) }).unknown(false),
  saturationPct: Joi.object({ lt: Joi.number().min(0).max(1) }).unknown(false),
  costBps: Joi.object({ lte: Joi.number().min(0) }).unknown(false)
}).unknown(false);

const ruleSchema = Joi.object({
  id: Joi.string().required(),
  priority: Joi.number().integer().min(0),
  when: whenSchema.required(),
  action: Joi.object({
    route: Joi.string().required()
  }).required()
}).unknown(false);

const retriesSchema = Joi.object({
  soft_decline: Joi.number().integer().min(0).default(1),
  network_error: Joi.number().integer().min(0).default(2),
  jitterMs: Joi.array().items(Joi.number().integer().min(0)).length(2).default([200,500])
}).unknown(false);

const fallbackSchema = Joi.object({
  order: Joi.array().items(Joi.string()).min(1).required(),
  on: Joi.array().items(Joi.string().valid('network_error','soft_decline','issuer_unavailable')).min(1).required()
}).unknown(false);

const policySchema = Joi.object({
  merchantId: Joi.string().required(),
  version: Joi.string().valid('v1').required(),
  defaultConnector: Joi.string().required(),
  rules: Joi.array().items(ruleSchema).required(),
  fallback: fallbackSchema.default({ order: ['dummyCard'], on: ['network_error','soft_decline'] }),
  retries: retriesSchema.default({ soft_decline:1, network_error:2, jitterMs:[200,500] }),
  explain: Joi.boolean().default(true)
}).unknown(false);

module.exports = { policySchema };
