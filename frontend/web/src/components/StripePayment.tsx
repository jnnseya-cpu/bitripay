import { useEffect, useRef, useState } from 'react';
import { Alert, Button } from './ui';

declare global {
  interface Window { Stripe?: (key: string) => any }
}

function loadStripeJs(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Stripe.js'));
    document.head.appendChild(s);
  });
}

/** Confirms a Stripe PaymentIntent with the Payment Element. Stripe.js is only loaded when a Stripe gateway is used. */
export function StripePayment({ clientSecret, publishableKey, onComplete }: { clientSecret: string; publishableKey: string; onComplete: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<any>(null);
  const elementsRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadStripeJs()
      .then(() => {
        if (cancelled || !window.Stripe) return;
        const stripe = window.Stripe(publishableKey);
        const elements = stripe.elements({ clientSecret, appearance: { theme: document.documentElement.dataset.theme === 'dark' ? 'night' : 'stripe' } });
        const el = elements.create('payment');
        el.mount(mount.current!);
        el.on('ready', () => setReady(true));
        stripeRef.current = stripe;
        elementsRef.current = elements;
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [clientSecret, publishableKey]);
  const confirm = async () => {
    setLoading(true);
    setError(null);
    const { error: err } = await stripeRef.current.confirmPayment({ elements: elementsRef.current, confirmParams: { return_url: window.location.href }, redirect: 'if_required' });
    setLoading(false);
    if (err) setError(err.message);
    else onComplete();
  };
  return (
    <div>
      {error && <Alert kind="error">{error}</Alert>}
      <div ref={mount} className="mb" />
      <Button block loading={loading} disabled={!ready} onClick={confirm}>Pay securely</Button>
    </div>
  );
}
