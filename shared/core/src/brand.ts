/**
 * BitriPay brand tokens, taken from the logo: an indigo wordmark with blue dots on the i's and a green-and-orange
 * chevron rising from the p. Every app derives its palette from these values.
 */
export const BRAND = {
  name: 'BitriPay',
  /** Wordmark indigo. */
  indigo: '#2E2A7B',
  indigoDeep: '#221F63',
  indigoLight: '#6B63D9',
  /** Dots on the i's: gradient from sky to deep blue. */
  blue: '#1A8ED8',
  blueDeep: '#1F5EAE',
  /** Chevron. */
  green: '#12A34B',
  greenDeep: '#0E8A3E',
  orange: '#F49D1F',
  orangeDeep: '#D9860F',
  /** Neutrals with a hint of indigo. */
  ink: '#161832',
  paper: '#F6F6FB',
  /** Paths served by the API and proxied by the apps. */
  logo: '/brand/logo.svg',
  logoWhite: '/brand/logo-white.svg',
  mark: '/brand/mark.svg',
} as const;
