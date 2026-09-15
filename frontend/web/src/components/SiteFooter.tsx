import { Link } from 'react-router-dom';
import { tr } from '../lib/i18n';
import { useStore } from '../lib/store';

/** Site-wide footer: product, company and every policy. Legal and company pages are server-rendered, so they use plain links. */
export const FOOTER_LINKS = {
  product: [
    { label: tr('Send money'), to: '/app/send' },
    { label: tr('QR payments'), to: '/app/scan' },
    { label: tr('Add money'), to: '/app/add-money' },
    { label: tr('Virtual cards'), to: '/app/cards' },
    { label: tr('Remittance'), to: '/app/remittance' },
    { label: tr('Agents & cash'), to: '/app/agents' },
    { label: tr('For merchants'), to: '/register?role=merchant' },
    { label: tr('Become an agent'), to: '/register?role=agent' },
  ],
  explore: [
    { label: tr('How it works'), href: '/how-it-works' },
    { label: tr('Industries'), href: '/industries' },
    { label: tr('Enterprise groups'), href: '/enterprise' },
    { label: tr('Developers'), href: '/developers' },
    { label: tr('Get started'), href: '/get-started' },
    { label: tr('Growth & influencers'), href: '/growth' },
    { label: tr('Platform status'), href: '/status' },
  ],
  company: [
    { label: tr('About us'), href: '/about' },
    { label: tr('Blog'), href: '/blog' },
    { label: tr('Security'), href: '/legal/security' },
    { label: tr('Regulatory information'), href: '/legal/regulatory' },
    { label: tr('Fees & charges'), href: '/legal/fees' },
    { label: tr('Contact'), href: '/contact' },
  ],
  legal: [
    { label: tr('Privacy policy'), href: '/legal/privacy' },
    { label: tr('Terms of service'), href: '/legal/terms' },
    { label: tr('Cookie policy'), href: '/legal/cookies' },
    { label: tr('Acceptable use'), href: '/legal/acceptable-use' },
    { label: tr('AML, KYC & sanctions'), href: '/legal/aml-kyc' },
    { label: tr('Safeguarding of funds'), href: '/legal/safeguarding' },
    { label: tr('Refunds & cancellations'), href: '/legal/refunds' },
    { label: tr('Complaints'), href: '/legal/complaints' },
    { label: tr('Accessibility'), href: '/legal/accessibility' },
    { label: tr('Agent & merchant agreement'), href: '/legal/agent-merchant-agreement' },
    { label: tr('All policies'), href: '/policies' },
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
          <div className="lp-brand">
            <img src="/brand/logo.svg" alt={site?.siteName || 'BitriPay'} width={140} height={34} />
          </div>
          <p>{tr('Money that works for everyone: the mother selling food at the market, the moto-taxi rider paid by his passengers, the shop on the corner and the family sending money home.')}</p>
          {site?.contactEmail && <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>}
          <div className="lp-footer-social">
            {site?.social?.twitter && (
              <a href={site.social.twitter} rel="noopener" target="_blank">
                X
              </a>
            )}
            {site?.social?.facebook && (
              <a href={site.social.facebook} rel="noopener" target="_blank">
                {tr('Facebook')}
              </a>
            )}
            {site?.social?.instagram && (
              <a href={site.social.instagram} rel="noopener" target="_blank">
                {tr('Instagram')}
              </a>
            )}
            {site?.social?.linkedin && (
              <a href={site.social.linkedin} rel="noopener" target="_blank">
                {tr('LinkedIn')}
              </a>
            )}
            {site?.social?.youtube && (
              <a href={site.social.youtube} rel="noopener" target="_blank">
                {tr('YouTube')}
              </a>
            )}
          </div>
        </div>
        <div>
          <h4>{tr('Product')}</h4>
          <ul>
            {FOOTER_LINKS.product.map((l) => (
              <li key={l.to}>
                <Link to={l.to}>{l.label}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>{tr('Explore')}</h4>
          <ul>
            {FOOTER_LINKS.explore.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>{tr('Company')}</h4>
          <ul>
            {FOOTER_LINKS.company.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>{tr('Legal')}</h4>
          <ul>
            {FOOTER_LINKS.legal.map((l) => (
              <li key={l.href}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="lp-wrap lp-footer-legal">
        <p>
          © {year} {site?.siteName || tr('BitriPay')}. BitriPay balances are electronic money, not bank deposits, and are backed one-to-one by safeguarded funds where the platform is authorised. Where
          it is not yet authorised, accounts run in sandbox mode with no real-world value and the app says so. Cross-border transfers are a regulated money-transfer service offered only through
          authorised corridors. Card payments are processed by licensed card processors; BitriPay never stores full card numbers.
        </p>
        <p className="lp-footer-links">
          <a href="/sitemap.xml">{tr('Sitemap')}</a>
          <a href="/feed.xml">RSS</a>
          <a href="/llms.txt">llms.txt</a>
          {site?.appUrls?.playStore && <a href={site.appUrls.playStore}>{tr('Google Play')}</a>}
          {site?.appUrls?.appStore && <a href={site.appUrls.appStore}>{tr('App Store')}</a>}
        </p>
      </div>
    </footer>
  );
}
