/**
 * Point of sale with line items: the API builds the sale from the lines (quantity × unit price), adds VAT at the
 * merchant's rate (or the rate given for the sale), charges exactly the total, prints the sale on the request and
 * on the payment, and refuses malformed lines.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, registerUser, fund } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('point of sale: items and VAT', () => {
  it('computes subtotal, VAT and total from the lines and charges the total', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Pharmacie Test' });
    const customer = await registerUser(app);
    await fund(app, customer.user.id, '100.00', 'USD');
    // the merchant's default rate is the DRC 16 %; a tax id prints on the receipt
    const settings = await request(app).put('/api/merchant/gateway').set(merchant.auth).send({ vatRate: 16, taxId: 'A1234567X' });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect(settings.body.settings.vatRate).toBe(16);

    const created = await request(app)
      .post('/api/payment-requests')
      .set(merchant.auth)
      .send({
        kind: 'qr',
        currency: 'USD',
        description: 'Table 4',
        items: [
          { description: 'Paracetamol 500 mg', quantity: 2, unitPrice: '1.50' },
          { description: 'Vitamin C', quantity: 1, unitPrice: '4.25' },
        ],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pr = created.body.paymentRequest;
    expect(pr.sale.items).toHaveLength(2);
    expect(pr.sale.items[0].total).toBe(300);
    expect(pr.sale.subtotal).toBe(725);
    expect(pr.sale.vatRate).toBe(16);
    expect(pr.sale.vat).toBe(116); // 725 × 16 % = 116
    expect(pr.sale.total).toBe(841);
    expect(pr.sale.taxId).toBe('A1234567X');
    expect(pr.amount).toBe(841);

    // the public pay page carries the same sale
    const info = await request(app).get(`/api/checkout/${pr.code}`);
    expect(info.status).toBe(200);
    expect(info.body.paymentRequest.sale.total).toBe(841);

    // paying charges exactly the total, and the payment keeps the sale for the receipt
    const paid = await request(app).post(`/api/payment-requests/${pr.code}/pay`).set(customer.auth).send({ pin: '1234' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.transaction.amount).toBe(841);
    expect(paid.body.transaction.metadata.sale.vat).toBe(116);
    expect(paid.body.paymentRequest.status).toBe('paid');

    // a per-sale rate overrides the default (0 % for an exempt sale)
    const exempt = await request(app)
      .post('/api/payment-requests')
      .set(merchant.auth)
      .send({ kind: 'qr', currency: 'USD', items: [{ description: 'Bread', quantity: 3, unitPrice: '0.40' }], vatRate: 0 });
    expect(exempt.status).toBe(201);
    expect(exempt.body.paymentRequest.sale.vat).toBe(0);
    expect(exempt.body.paymentRequest.amount).toBe(120);
  });

  it('refuses empty descriptions, zero quantities, negative prices and a zero total', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Boutique Test' });
    const post = (items: unknown, vatRate?: number) => request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'qr', currency: 'USD', items, vatRate });
    expect((await post([{ description: '  ', quantity: 1, unitPrice: '1.00' }])).status).toBe(400);
    expect((await post([{ description: 'A', quantity: 0, unitPrice: '1.00' }])).status).toBe(400);
    expect((await post([{ description: 'A', quantity: 1, unitPrice: '-1.00' }])).status).toBe(400);
    expect((await post([{ description: 'A', quantity: 1, unitPrice: '0.00' }])).body.error.code).toBe('sale_total_zero');
    expect((await post([{ description: 'A', quantity: 1, unitPrice: '1.00' }], 150)).status).toBe(400);
  });
});
