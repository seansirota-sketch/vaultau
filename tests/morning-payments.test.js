'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const { test } = require('node:test');

const {
  createMorningCustomMetadata,
  createMorningPaymentForm,
  normalizeCoursePayment,
  parseMorningCustomMetadata,
  paymentTotalsMatch,
  rawEventBody,
  verifyWebhookSignature,
} = require('../netlify/functions/_morning.js');

test('Morning custom metadata round-trips purchase identifiers', () => {
  const metadata = {
    purchaseId: 'purchase-1',
    userId: 'user-1',
    courseId: 'course-1',
  };
  const encoded = createMorningCustomMetadata(metadata);
  assert.equal(typeof encoded, 'string');
  assert.deepEqual(parseMorningCustomMetadata(encoded), metadata);
  assert.deepEqual(parseMorningCustomMetadata(metadata), metadata);
  assert.equal(parseMorningCustomMetadata('course-1'), null);
});

test('webhook signatures use HMAC-SHA256 over the raw body', () => {
  const secret = 'test-webhook-secret';
  const body = Buffer.from('{"id":"payment-1","total":99}');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(body, signature.toUpperCase(), secret), true);
  assert.equal(verifyWebhookSignature(body, '0'.repeat(64), secret), false);
  assert.equal(verifyWebhookSignature(Buffer.from('changed'), signature, secret), false);
  assert.equal(verifyWebhookSignature(body, signature, ''), false);
});

test('raw webhook body preserves base64 payloads', () => {
  const body = Buffer.from('{"ok":true}');
  assert.deepEqual(rawEventBody({ body: body.toString('base64'), isBase64Encoded: true }), body);
  assert.deepEqual(rawEventBody({ body: body.toString('utf8'), isBase64Encoded: false }), body);
});

test('course payment settings are normalized from server-owned course data', () => {
  assert.deepEqual(normalizeCoursePayment({
    accessSettings: {
      payment: { enabled: true, price: 199.995, currency: 'ils', durationDays: 180 },
    },
  }), { amount: 200, currency: 'ILS', durationDays: 180 });
  assert.equal(normalizeCoursePayment({
    accessSettings: { payment: { enabled: false, price: 100 } },
  }), null);
  assert.equal(normalizeCoursePayment({
    accessSettings: { payment: { enabled: true, price: 0 } },
  }), null);
});

test('webhook totals must exactly match the trusted checkout amount', () => {
  assert.equal(paymentTotalsMatch(99.99, 99.99), true);
  assert.equal(paymentTotalsMatch('99.99', 99.99), true);
  assert.equal(paymentTotalsMatch(99.98, 99.99), false);
  assert.equal(paymentTotalsMatch('not-a-number', 99.99), false);
});

test('Morning checkout errors expose inactive-terminal codes', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ errorCode: 2600 }),
  });

  await assert.rejects(
    () => createMorningPaymentForm(
      { apiBaseUrl: 'https://sandbox.example.test/api/v1' },
      'token',
      {},
      fetchImpl
    ),
    /No active Morning clearing terminal.*error 2600/
  );
});
