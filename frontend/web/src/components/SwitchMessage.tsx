import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';

/**
 * Customer wording for a national-switch payment state, shown in the user's language: French when the app runs in
 * French, English otherwise. The API always ships both (`customer_message: { fr, en }`); when the link is down, timed
 * out or the circuit is open the wording is «Service temporairement indisponible. Réessayez plus tard.».
 */
export function SwitchMessage({ message, unavailable }: { message?: { fr: string; en: string } | null; unavailable?: boolean }) {
  const { lang } = useStore();
  const t = useT();
  if (unavailable) return <p className="switch-message">{t('switch.unavailable')}</p>;
  if (!message) return null;
  return <p className="switch-message">{lang === 'fr' ? message.fr : message.en}</p>;
}
