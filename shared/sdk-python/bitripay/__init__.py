"""BitriPay Gateway API client (standard library only)."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional


class BitriPayError(Exception):
    def __init__(self, status: int, code: str, message: str, bp: Optional[str] = None, details: Any = None):
        super().__init__(message)
        self.status, self.code, self.bp, self.details = status, code, bp, details


class _Resource:
    def __init__(self, client: "BitriPay", path: str):
        self._c, self._p = client, path

    def create(self, body: Dict[str, Any], idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._c.request("POST", self._p, body, idempotency_key)

    def retrieve(self, id: str) -> Dict[str, Any]:
        return self._c.request("GET", f"{self._p}/{urllib.parse.quote(id)}")

    def list(self, **query: Any) -> Dict[str, Any]:
        return self._c.request("GET", self._p, query=query)

    def action(self, id: str, action: str, body: Optional[Dict[str, Any]] = None, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._c.request("POST", f"{self._p}/{urllib.parse.quote(id)}/{action}", body or {}, idempotency_key)


class BitriPay:
    def __init__(self, api_key: str, base_url: str = "https://api.bitripay.com", timeout: float = 30.0):
        if not api_key:
            raise ValueError("api_key is required")
        self.api_key, self.base_url, self.timeout = api_key, base_url.rstrip("/"), timeout
        self.payment_intents = _Resource(self, "/v1/payment_intents")
        self.checkout_sessions = _Resource(self, "/v1/checkout_sessions")
        self.payment_links = _Resource(self, "/v1/payment_links")
        self.refunds = _Resource(self, "/v1/refunds")
        self.verifications = _Resource(self, "/v1/verifications")
        self.payouts = _Resource(self, "/v1/payouts")
        self.qr_codes = _Resource(self, "/v1/qr_codes")
        self.disputes = _Resource(self, "/v1/disputes")
        self.settlement_cycles = _Resource(self, "/v1/settlement_cycles")
        self.webhook_endpoints = _Resource(self, "/v1/webhook_endpoints")
        self.events = _Resource(self, "/v1/events")
        self.payments = _Resource(self, "/v1/payments")
        self.diaspora_quotes = _Resource(self, "/v1/diaspora/quotes")

    def balance(self) -> Dict[str, Any]:
        return self.request("GET", "/v1/balance")

    def request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, idempotency_key: Optional[str] = None, query: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        q = {k: v for k, v in (query or {}).items() if v is not None and v != ""}
        url = f"{self.base_url}{path}" + (f"?{urllib.parse.urlencode(q)}" if q else "")
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json", "User-Agent": "bitripay-sdk-python/1.0.0"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                err = json.loads(raw).get("error", {})
            except ValueError:
                err = {}
            raise BitriPayError(e.code, err.get("code", "error"), err.get("message", f"HTTP {e.code}"), err.get("bp"), err.get("details")) from None


class Webhook:
    @staticmethod
    def verify(raw_body: bytes | str, signature_header: Optional[str], secret: str, tolerance_seconds: int = 300) -> Dict[str, Any]:
        if not signature_header:
            raise BitriPayError(400, "missing_signature", "Missing BitriPay-Signature header")
        parts = dict(p.strip().split("=", 1) for p in signature_header.split(",") if "=" in p)
        t = int(parts.get("t", "0") or 0)
        if not t or not parts.get("v1"):
            raise BitriPayError(400, "malformed_signature", "Malformed signature header")
        if abs(time.time() - t) > tolerance_seconds:
            raise BitriPayError(400, "signature_expired", "Signature timestamp outside tolerance")
        body = raw_body.decode() if isinstance(raw_body, bytes) else raw_body
        expected = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, parts["v1"]):
            raise BitriPayError(400, "invalid_signature", "Signature does not match")
        return json.loads(body)


__all__ = ["BitriPay", "BitriPayError", "Webhook"]
