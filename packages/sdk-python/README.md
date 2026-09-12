# bitripay (Python)

```python
from bitripay import BitriPay, Webhook
bp = BitriPay(api_key="sk_test_...")
intent = bp.payment_intents.create({"amount_minor": 2500, "currency": "USD", "reference": "ORDER-1001"}, idempotency_key="order-1001")
print(intent["checkout_url"], intent["qr_payload"])
event = Webhook.verify(raw_body, headers["BitriPay-Signature"], "whsec_...")
```
Standard library only (urllib, hmac). Every error raises `BitriPayError` with `.status`, `.code`, `.bp`.
