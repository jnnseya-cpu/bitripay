/** Thin re-exports so blog.ts and the site renderer can share the SEO engine without import cycles. */
export { applyDynamicLinks, listLinkRules, absoluteUrl, faqJsonLd, breadcrumbJsonLd, organizationJsonLd, websiteJsonLd, siteUrl, pageTitle, type LinkRule } from './seo';
import { getSeoSettings } from './settings';
export const getSeoSettingsCached = () => getSeoSettings();
