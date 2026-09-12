import { Link } from 'react-router-dom';
import { useStore } from '../lib/store';

/** Site-wide footer: product, company and every policy. Legal and company pages are server-rendered, so they use plain links. */
export const FOOTER_LINKS = {
  product: [
    { label: 'Send money', to: '/app/send' },
    { label: 'QR payments', to: '/app/scan' },
    { label: 'Add money', to: '/app/add-money' },
    { label: 'Virtual cards', to: '/app/cards' },
    { label: 'Remittance', to: '/app/remittance' },
    { label: 'Agents & cash', to: '/app/agents' },
    { label: 'For merchants', to: '/register?role=merchant' },
    { label: 'Become an agent', to: '/register?role=agent' },
  ],
  company: [
    { label: 'About us', href: '/about' },
    { label: 'Blog', href: '/blog' },
    { label: 'Security', href: '/legal/security' },
    { label: 'Regulatory information', href: '/legal/regulatory' },
    { label: 'Fees & charges', href: '/legal/fees' },
    { label: 'Contact', href: '/contact' },
  ],
  legal: [
    { label: 'Privacy policy', href: '/legal/privacy' },
    { label: 'Terms of service', href: '/legal/terms' },
    { label: 'Cookie policy', href: '/legal/cookies' },
    { label: 'Acceptable use', href: '/legal/acceptable-use' },
    { label: 'AML, KYC & sanctions', href: '/legal/aml-kyc' },
    { label: 'Safeguarding of funds', href: '/legal/safeguarding' },
    { label: 'Refunds & cancellations', href: '/legal/refunds' },
    { label: 'Complaints', href: '/legal/complaints' },
    { label: 'Accessibility', href: '/legal/accessibility' },
    { label: 'Agent & merchant agreement', href: '/legal/agent-merchant-agreement' },
  ],
};

export function SiteFooter() {
  const { config } = useStore();
  const site = config?.site;
  const year = new Date().getFullYear();
  return (
    <footer className="lp-footer">
      <div className="lp-wrap lp-footer-grid">
        <div className="lp-footer-brand">
          <div className="lp-brand"><i /> {site?.siteName || 'BitriPay'}</div>
          <p>Money that works for everyone: the mother selling food at the market, the moto-taxi rider paid by his passengers, the shop on the corner and the family sending money home.</p>
          {site?.contactEmail && <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>}
          <div className="lp-footer-social">
            {site?.social?.twitter && <a href={site.social.twitter} rel="noopener" target="_blank">X</a>}
            {site?.social?.facebook && <a href={site.social.facebook} rel="noopener" target="_blank">Facebook</a>}
            {site?.social?.instagram && <a href={site.social.instagram} rel="noopener" target="_blank">Instagram</a>}
            {site?.social?.linkedin && <a href={site.social.linkedin} rel="noopener" target="_blank">LinkedIn</a>}
            {site?.social?.youtube && <a href={site.social.youtube} rel="noopener" target="_blank">YouTube</a>}
          </div>
        </div>
        <div>
          <h4>Product</h4>
          <ul>{FOOTER_LINKS.product.map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}</ul>
        </div>
        <div>
          <h4>Company</h4>
          <ul>{FOOTER_LINKS.company.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}</ul>
        </div>
        <div>
          <h4>Legal</h4>
          <ul>{FOOTER_LINKS.legal.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}</ul>
        </div>
      </div>
      <div className="lp-wrap lp-footer-legal">
        <p>© {year} {site?.siteName || 'BitriPay'}. BitriPay balances are electronic money, not bank deposits, and are backed one-to-one by safeguarded funds where the platform is authorised. Where it is not yet authorised, accounts run in sandbox mode with no real-world value and the app says so. Cross-border transfers are a regulated money-transfer service offered only through authorised corridors. Card payments are processed by licensed card processors; BitriPay never stores full card numbers.</p>
        <p className="lp-footer-links"><a href="/sitemap.xml">Sitemap</a><a href="/feed.xml">RSS</a><a href="/llms.txt">llms.txt</a>{site?.appUrls?.playStore && <a href={site.appUrls.playStore}>Google Play</a>}{site?.appUrls?.appStore && <a href={site.appUrls.appStore}>App Store</a>}</p>
      </div>
    </footer>
  );
}
