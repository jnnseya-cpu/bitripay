<?php
declare(strict_types=1);

namespace BitriPay;

/** BitriPay API client. Every money-moving call accepts an idempotency key; errors carry the API code and BP family. */
final class Client
{
    public Resource $paymentIntents;
    public Resource $checkoutSessions;
    public Resource $paymentLinks;
    public Resource $refunds;
    public Resource $verifications;
    public Resource $payouts;
    public Resource $qrCodes;
    public Resource $disputes;
    public Resource $settlementCycles;
    public Resource $webhookEndpoints;
    public Resource $events;
    public Resource $payments;

    public function __construct(private string $apiKey, private string $baseUrl = 'https://api.bitripay.com', private int $timeout = 30)
    {
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->paymentIntents = new Resource($this, '/v1/payment_intents');
        $this->checkoutSessions = new Resource($this, '/v1/checkout_sessions');
        $this->paymentLinks = new Resource($this, '/v1/payment_links');
        $this->refunds = new Resource($this, '/v1/refunds');
        $this->verifications = new Resource($this, '/v1/verifications');
        $this->payouts = new Resource($this, '/v1/payouts');
        $this->qrCodes = new Resource($this, '/v1/qr_codes');
        $this->disputes = new Resource($this, '/v1/disputes');
        $this->settlementCycles = new Resource($this, '/v1/settlement_cycles');
        $this->webhookEndpoints = new Resource($this, '/v1/webhook_endpoints');
        $this->events = new Resource($this, '/v1/events');
        $this->payments = new Resource($this, '/v1/payments');
    }

    public function balance(): array
    {
        return $this->request('GET', '/v1/balance');
    }

    /** @param array<string,mixed>|null $body */
    public function request(string $method, string $path, ?array $body = null, ?string $idempotencyKey = null, array $query = []): array
    {
        $url = $this->baseUrl . $path . ($query ? '?' . http_build_query($query) : '');
        $headers = ['Authorization: Bearer ' . $this->apiKey, 'Accept: application/json', 'User-Agent: bitripay-sdk-php/1.0.0'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        if ($idempotencyKey !== null) {
            $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => $this->timeout]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR));
        }
        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new ApiException(0, 'network_error', $err);
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $json = $raw === '' ? [] : json_decode((string) $raw, true, 512, JSON_THROW_ON_ERROR);
        if ($status >= 400) {
            $e = $json['error'] ?? [];
            throw new ApiException($status, $e['code'] ?? 'error', $e['message'] ?? "HTTP $status", $e['bp'] ?? null, $e['details'] ?? null);
        }
        return $json;
    }
}

final class Resource
{
    public function __construct(private Client $client, private string $path) {}

    public function create(array $body, ?string $idempotencyKey = null): array
    {
        return $this->client->request('POST', $this->path, $body, $idempotencyKey);
    }

    public function retrieve(string $id): array
    {
        return $this->client->request('GET', $this->path . '/' . rawurlencode($id));
    }

    public function all(array $query = []): array
    {
        return $this->client->request('GET', $this->path, null, null, $query);
    }

    /** POST /{id}/{action} (cancel, expire, deactivate, respond, pay, replay, rotate, ping…) */
    public function action(string $id, string $action, array $body = [], ?string $idempotencyKey = null): array
    {
        return $this->client->request('POST', $this->path . '/' . rawurlencode($id) . '/' . $action, $body, $idempotencyKey);
    }
}

final class ApiException extends \RuntimeException
{
    public function __construct(public int $status, public string $errorCode, string $message, public ?string $bp = null, public mixed $details = null)
    {
        parent::__construct($message, $status);
    }
}

final class Webhook
{
    /** Verify BitriPay-Signature (t=…,v1=…) over the raw body. Returns the decoded event or throws. */
    public static function verify(string $rawBody, ?string $signatureHeader, string $secret, int $toleranceSeconds = 300): array
    {
        if (!$signatureHeader) {
            throw new ApiException(400, 'missing_signature', 'Missing BitriPay-Signature header');
        }
        $parts = [];
        foreach (explode(',', $signatureHeader) as $kv) {
            [$k, $v] = array_pad(explode('=', trim($kv), 2), 2, '');
            $parts[$k] = $v;
        }
        $t = (int) ($parts['t'] ?? 0);
        if ($t === 0 || empty($parts['v1'])) {
            throw new ApiException(400, 'malformed_signature', 'Malformed signature header');
        }
        if (abs(time() - $t) > $toleranceSeconds) {
            throw new ApiException(400, 'signature_expired', 'Signature timestamp outside tolerance');
        }
        $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
        if (!hash_equals($expected, $parts['v1'])) {
            throw new ApiException(400, 'invalid_signature', 'Signature does not match');
        }
        return json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
    }
}
