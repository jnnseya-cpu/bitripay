import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { useMeta } from '../lib/seo';
import { SiteFooter } from '../components/SiteFooter';
import '../landing.css';

/**
 * Cinematic hero background: slow diagonal light bands (headlights on a wet road), soft bokeh and film grain, drawn on a
 * canvas so it costs nothing to ship and respects reduced-motion.
 */
function CinematicCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let t = 0;
    const dots = Array.from({ length: 26 }, (_, i) => ({ x: Math.random(), y: Math.random(), r: 40 + Math.random() * 120, c: i % 3 === 0 ? [245, 179, 28] : i % 3 === 1 ? [31, 79, 216] : [11, 110, 79], s: 0.15 + Math.random() * 0.35, a: 0.05 + Math.random() * 0.08 }));
    const grain = document.createElement('canvas');
    grain.width = 160;
    grain.height = 160;
    const g = grain.getContext('2d')!;
    const img = g.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 70;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 22;
    }
    g.putImageData(img, 0, 0);
    const resize = () => {
      canvas.width = canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1);
      canvas.height = canvas.clientHeight * Math.min(2, window.devicePixelRatio || 1);
    };
    resize();
    window.addEventListener('resize', resize);
    const draw = () => {
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0a0d12';
      ctx.fillRect(0, 0, w, h);
      // light bands
      for (let i = 0; i < 5; i++) {
        const p = ((t * 0.00012 * (1 + i * 0.35)) + i * 0.21) % 1.4 - 0.2;
        const grad = ctx.createLinearGradient(w * (p - 0.25), 0, w * (p + 0.25), h);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, i % 2 ? 'rgba(31,79,216,0.16)' : 'rgba(245,179,28,0.10)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(w * (p - 0.35), 0);
        ctx.lineTo(w * (p + 0.05), 0);
        ctx.lineTo(w * (p + 0.55), h);
        ctx.lineTo(w * (p + 0.15), h);
        ctx.closePath();
        ctx.fill();
      }
      // bokeh
      for (const d of dots) {
        const y = (d.y + (reduce ? 0 : (t * 0.00002 * d.s))) % 1.2 - 0.1;
        const rg = ctx.createRadialGradient(d.x * w, y * h, 0, d.x * w, y * h, d.r * (w / 1400));
        rg.addColorStop(0, `rgba(${d.c.join(',')},${d.a})`);
        rg.addColorStop(1, `rgba(${d.c.join(',')},0)`);
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(d.x * w, y * h, d.r * (w / 1400), 0, Math.PI * 2);
        ctx.fill();
      }
      // grain
      const pat = ctx.createPattern(grain, 'repeat');
      if (pat) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }
      t += 16;
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return <canvas ref={ref} aria-hidden="true" />;
}

const STORIES = [
  { who: 'Market trader · Kinshasa', title: 'Mama Nzuzi sells fish. She does not read small print.', body: 'A printed QR code on the wall of her stall never changes. When a customer pays, her phone rings loudly and vibrates for five seconds and the amount fills the screen with a green tick. No card machine, nothing to charge, nothing to read.', how: ['Print the receive code once', 'Hear every payment, even in the noise', 'Cash out at an agent on the way home'] },
  { who: 'Moto-taxi rider · the wewa', title: 'Papy takes thirty fares a day and rides home with none of them in his pocket.', body: 'A sticker on the tank, an @tag passengers can say out loud, and a phone number for those without the app. Every fare arrives with the same sound. Once a day he turns balance into cash at an agent on his route.', how: ['Fares by QR, @tag or phone number', 'Nothing moves out without his fingerprint', 'One cash-out a day, fee shown first'] },
  { who: 'Family · London to Goma', title: 'Grace sends money home on Friday night and knows exactly what arrives.', body: 'The quote shows the rate, its source, the margin and every fee before her face unlocks the payment. The money is paid out from a local account in Congo and marked delivered only when the operator’s own confirmation matches.', how: ['Guaranteed recipient amount when the rate is locked', 'Recipient can confirm the currency', 'Follow every stage in the app'] },
];

const STEPS = [
  ['Quoted', 'Amount, fees, rate and margin, guaranteed recipient amount, expiry.'],
  ['Approved', 'Fingerprint, face or passkey on your own phone. We never store biometrics.'],
  ['Funded', 'Card processor or bank confirms into safeguarded funds.'],
  ['Routed', 'Instruction goes to a prefunded local account near the recipient.'],
  ['Sent', 'A secured payout device or approved agent executes the local transfer.'],
  ['Verified', 'The operator’s own confirmation is signed and matched: amount, reference, recipient, time.'],
  ['Settled', 'The ledger posts. Not a second earlier, and never from a screenshot.'],
];

const FAQ = [
  ['Do I need a bank account?', 'No. A phone number is enough to open an account, receive payments and cash in or out with an agent. Verifying your identity raises your limits and lets you withdraw to a bank or mobile money.'],
  ['Can someone pay me without the app?', 'Yes. Your QR code opens a checkout page in any phone camera where they can pay by card, mobile money or bank transfer. You still receive balance and the alert still rings.'],
  ['What is my balance, legally?', 'Electronic money: a claim backed one-to-one by funds held apart from the company in safeguarding accounts, where BitriPay is authorised. It is not a bank deposit and earns no interest. In markets where we are not yet authorised the app shows sandbox balances with no real-world value.'],
  ['How do you send to mobile money without the operator’s API?', 'Payouts are executed from prefunded local accounts by secured Android payout devices or approved agents. The operator’s confirmation SMS is signed on the device and matched against the instruction before anything is marked delivered.'],
  ['What does it cost?', 'Every fee, the exchange rate and its margin are on the screen before you confirm, and on the Fees page. Receiving into your wallet is free.'],
  ['Which languages?', 'English, French, Lingala, Swahili and more, with short sentences and large buttons. Sound and vibration tell you money arrived even if you cannot read the screen.'],
];

export function Landing() {
  const { config, user, theme, toggleTheme } = useStore();
  const site = config?.site;
  const [cookie, setCookie] = useState(false);
  const [posts, setPosts] = useState<any[]>([]);
  useEffect(() => {
    setCookie(!!site?.gdpr?.enabled && !localStorage.getItem('bitripay.cookies'));
  }, [site]);
  useEffect(() => {
    api.get<{ items: any[] }>('/api/blog?pageSize=3', { token: null }).then((r) => setPosts(r.items)).catch(() => {});
  }, []);
  useMeta({
    title: 'BitriPay – Payments, cards, mobile money and remittance for everyone',
    description: 'Get paid by QR code, send money to a phone number, hold a virtual card and send money home. Built for market traders, moto-taxi riders, small shops, agents and families, with every fee shown first.',
    path: '/',
    image: '/screens/web-dashboard-classes.png',
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }],
  });
  const currencies = config?.currencies?.length ?? 0;
  const languages = config?.languages?.length ?? 0;
  const countries = (config as any)?.countries?.length ?? 0;

  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap">
          <Link to="/" className="lp-brand" style={{ color: '#fff' }} aria-label={site?.siteName || 'BitriPay'}><img src="/brand/logo-white.svg" alt={site?.siteName || 'BitriPay'} width={124} height={30} /></Link>
          <nav>
            <a href="/blog" className="hide-sm">Blog</a>
            <a href="/about" className="hide-sm">About</a>
            <a href="/legal/fees" className="hide-sm">Fees</a>
            <button type="button" className="lp-btn ghost" onClick={toggleTheme} aria-label="Toggle dark mode" style={{ padding: '8px 10px' }}>{theme === 'dark' ? 'Light' : 'Dark'}</button>
            {user ? <Link to="/app" className="lp-btn light">Open app</Link> : <><Link to="/login" className="hide-sm" style={{ textDecoration: 'none' }}>Sign in</Link><Link to="/register" className="lp-btn light">Open an account</Link></>}
          </nav>
        </div>
      </header>

      <section className="lp-hero">
        <CinematicCanvas />
        <div className="lp-wrap">
          <div>
            <div className="lp-eyebrow">Payments for everyone with a phone</div>
            <h1>Get paid at the market. Send money home. <em>Hear it arrive.</em></h1>
            <p className="lead">BitriPay is a wallet built for the people usually left out: a printed QR code instead of a card machine, a sound you cannot miss when money lands, agents who turn cash into balance and back, and every fee on the screen before your fingerprint touches it.</p>
            <div className="actions">
              <Link to="/register" className="lp-btn light">Open a free account</Link>
              <Link to="/register?role=merchant" className="lp-btn ghost">Accept payments</Link>
              <Link to="/register?role=agent" className="lp-btn ghost">Become an agent</Link>
            </div>
            <div className="lp-facts">
              <div><b>{currencies || '—'}</b>currencies</div>
              <div><b>{countries || '—'}</b>countries in the directory</div>
              <div><b>{languages || '—'}</b>languages</div>
              <div><b>1:1</b>safeguarded e-money</div>
            </div>
          </div>
          <div className="lp-phone-wrap">
            <div className="lp-phone"><div className="notch" /><div className="screen"><img src="/screens/mobile-web-dashboard.png" alt="BitriPay dashboard on a phone: balance, receive QR code and quick actions" width={300} height={640} /></div></div>
            <div className="lp-toast" role="status"><div className="ring">✓</div><div><b>Money arrived · 3,500 CDF</b><span>From @mamaNzuzi customer · just now</span></div></div>
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-wrap">
          <div className="lp-kicker">Who we build for</div>
          <h2>Designed around a market day, a rider’s route and a Friday night transfer.</h2>
          <p className="sub">Three people we keep in the room when we decide anything. If it does not work for them, it does not ship.</p>
          <div className="lp-stories">
            {STORIES.map((s, i) => (
              <article className="lp-story" key={s.who}>
                <span className="num" aria-hidden="true">{i + 1}</span>
                <div className="who">{s.who}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <div className="how">{s.how.map((h) => <span key={h}>{h}</span>)}</div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section tight">
        <div className="lp-wrap">
          <div className="lp-flow">
            <div>
              <div className="lp-kicker" style={{ color: '#f5b31c' }}>How money moves</div>
              <h2>Nothing is marked delivered because someone said so.</h2>
              <p>Every transfer moves through the same stages, each one confirmed by something independent: the processor’s signed message, the operator’s own confirmation, or two people checking documents. The app shows you which stage you are at, always.</p>
              <Link to="/register" className="lp-btn light" style={{ marginTop: 10 }}>Try a sandbox transfer</Link>
            </div>
            <div className="lp-steps">
              {STEPS.map(([b, s], i) => <div className={`lp-step ${i === STEPS.length - 1 ? 'check' : ''}`} key={b}><i>{i === STEPS.length - 1 ? '✓' : String(i + 1).padStart(2, '0')}</i><div><b>{b}</b><span>{s}</span></div></div>)}
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-wrap">
          <div className="lp-kicker">What you can do</div>
          <h2>One wallet. Cash, cards, mobile money, banks and QR codes all talk to each other.</h2>
          <div className="lp-pillars">
            <div className="lp-pillar wide"><div className="shot"><img src="/screens/move-money.png" alt="Move money: fund from a card, bank, mobile money or wallet and deliver to a wallet, bank, mobile money number or agent" loading="lazy" /></div><div className="body"><h3>Move money between any two rails</h3><p>Card to mobile money, wallet to bank, mobile money to a cash agent: one quote, one approval, every stage visible.</p><Link to="/app/move">Move money →</Link></div></div>
            <div className="lp-pillar"><div className="shot"><img src="/screens/vcard-list.png" alt="A BitriPay virtual card with masked number, holder, expiry and balance" loading="lazy" /></div><div className="body"><h3>Virtual cards</h3><p>Fund only what you plan to spend, freeze between uses, reveal details with your PIN.</p><Link to="/app/cards">Get a card →</Link></div></div>
            <div className="lp-pillar"><div className="shot"><img src="/screens/merchant-pos.png" alt="Merchant point of sale showing a dynamic QR code for an amount" loading="lazy" /></div><div className="body"><h3>Point of sale on any phone</h3><p>Type the amount, show the code. Payment links for WhatsApp, a checkout for your website, daily settlements.</p><Link to="/register?role=merchant">For merchants →</Link></div></div>
            <div className="lp-pillar"><div className="shot"><img src="/screens/agent-dashboard.png" alt="Agent tools: cash-in, cash-out codes and the payout queue" loading="lazy" /></div><div className="body"><h3>Agents keep cash in the system</h3><p>Cash-in, cash-out and local payouts, approved on the customer’s own phone and reconciled daily.</p><Link to="/register?role=agent">Become an agent →</Link></div></div>
            <div className="lp-pillar"><div className="shot"><img src="/screens/web-statements.png" alt="A bank-grade account statement with running balance and integrity hash" loading="lazy" /></div><div className="body"><h3>Statements a bank would sign</h3><p>Numbered, hashed statements with a running balance, as PDF or CSV, for your accountant or your landlord.</p><Link to="/app/statements">See a statement →</Link></div></div>
          </div>
        </div>
      </section>

      <section className="lp-section" style={{ background: 'var(--lp-paper-2)', borderBlock: '1px solid var(--lp-line)' }}>
        <div className="lp-wrap lp-trust">
          <div>
            <div className="lp-kicker">Your balance, legally</div>
            <h2>Electronic money backed one-to-one. Not a promise, a rule in the ledger.</h2>
            <p className="sub" style={{ marginBottom: 20 }}>Issued balance can never exceed cleared safeguarded funds. One treasury administrator records the funding, a different one confirms it, and every day the platform reconciles reserves against every balance. If they ever disagree, issuance stops itself.</p>
            <ul>
              <li>Two people for every sensitive action: creating balance, releasing a held payout, changing a rate.</li>
              <li>Immutable, hash-chained records that auditors and regulators can read.</li>
              <li>Card details stay with the licensed processor; biometrics stay on your phone.</li>
              <li>Where a market is not yet authorised, the app says sandbox and no real money is accepted.</li>
            </ul>
            <p style={{ marginTop: 22 }}><a href="/legal/safeguarding" style={{ color: 'var(--lp-forest)', fontWeight: 600 }}>Read how safeguarding works →</a></p>
          </div>
          <div className="lp-ledger" aria-label="Example of the safeguarding rule">
            <div className="row"><span className="t">Cleared safeguarded funds</span><span>1,000,000.00</span></div>
            <div className="row"><span className="t">− Redemptions in progress</span><span>−12,400.00</span></div>
            <div className="row"><span className="t">− Reserved exposure</span><span>−3,000.00</span></div>
            <div className="row"><span className="t">− E-money outstanding</span><span>−961,250.00</span></div>
            <div className="row"><span>Headroom for issuance</span><span>23,350.00</span></div>
            <div style={{ fontFamily: 'var(--lp-body)', fontSize: 13, color: 'var(--lp-ink-2)', marginTop: 4 }}>Illustrative figures. The real position is reconciled daily and published to the treasury console.</div>
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-wrap">
          <div className="lp-roles">
            <div className="lp-role forest">
              <h3>For merchants</h3>
              <p>Accept balance, cards, mobile money and bank transfers with a QR code, a link or a checkout on your site. Settle to your bank or wallet on your schedule.</p>
              <ul><li>Point of sale on any phone, staff logins</li><li>Payment links for WhatsApp and Facebook</li><li>Checkout API, webhooks and a WooCommerce plugin</li><li>Refunds and disputes handled in the dashboard</li></ul>
              <div><Link to="/register?role=merchant" className="lp-btn light">Open a merchant account</Link></div>
            </div>
            <div className="lp-role">
              <h3>For agents</h3>
              <p>Be the bank in a place that has none. Cash-in, cash-out and local payouts, each approved on the customer’s own phone, with a float reconciled daily.</p>
              <ul><li>Commission shown to both sides before confirming</li><li>Loud alert for every payout instruction</li><li>Secured payout device app for the merchant SIM</li><li>Training and supervision included</li></ul>
              <div><Link to="/register?role=agent" className="lp-btn primary">Apply as an agent</Link></div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section tight">
        <div className="lp-wrap">
          <div className="lp-kicker">Questions people ask first</div>
          <h2>Straight answers.</h2>
          <div className="lp-faq">{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
        </div>
      </section>

      {posts.length > 0 && (
        <section className="lp-section">
          <div className="lp-wrap">
            <div className="lp-kicker">From the blog</div>
            <h2>Guides written for the people who use them.</h2>
            <div className="lp-posts">{posts.map((p) => <a className="lp-post" href={p.url} key={p.id}><div className="m">{p.category} · {p.readingMinutes} min read</div><h3>{p.title}</h3><p>{p.excerpt}</p></a>)}</div>
            <p style={{ marginTop: 20 }}><a href="/blog" style={{ color: 'var(--lp-forest)', fontWeight: 600 }}>All articles →</a></p>
          </div>
        </section>
      )}

      <section className="lp-section tight">
        <div className="lp-wrap">
          <div className="lp-cta">
            <div><h2>Open an account in two minutes.</h2><p>A phone number is enough to start. Explore with sandbox balances, then verify your identity when you are ready to move real money.</p></div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><Link to="/register" className="lp-btn light">Open a free account</Link><Link to="/login" className="lp-btn ghost">Sign in</Link></div>
          </div>
        </div>
      </section>

      <SiteFooter />
      {cookie && (
        <div className="lp-cookie" role="dialog" aria-label="Cookie notice">
          <span style={{ flex: 1 }}>{site?.gdpr?.message || 'We use strictly necessary cookies and anonymous page counts. No advertising trackers.'} <a href="/legal/cookies">Cookie policy</a></span>
          <button type="button" className="lp-btn light" style={{ padding: '8px 14px' }} onClick={() => { localStorage.setItem('bitripay.cookies', '1'); setCookie(false); }}>OK</button>
        </div>
      )}
    </div>
  );
}
