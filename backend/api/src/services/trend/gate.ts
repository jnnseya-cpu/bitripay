/**
 * The switch in front of trend intelligence.
 *
 * Two behaviours, and the difference between them is the whole point. Every write — registering a source, ingesting
 * an observation, scoring a snapshot, proposing or approving a brief — refuses outright when an administrator has
 * the module switched off, so nothing accumulates behind a control that reads "off". The resolver the agents call
 * does the opposite: it returns no brief and lets them run on their existing backlog, because an agent that threw
 * when the module was switched off would take the content schedule down with it.
 *
 * A flag that reports a state it does not enforce is worse than no flag, so this is asserted in the service layer
 * rather than only in middleware: the SEO agent, a job and a direct caller all go through here.
 */
import { unprocessable } from '../../lib/errors';
import { getModules } from '../modules';

export const TREND_OFF_MESSAGE = 'Trend intelligence is switched off by the administrator';

/** True when an administrator has switched the module on. Reads the stored flags on every call: no cache. */
export const trendIntelligenceOn = (): boolean => getModules().trendIntelligence !== false;

/** Refuses a write while the module is off. Resolution never calls this — see `effectiveBrief`. */
export function assertTrendIntelligence(): void {
  if (!trendIntelligenceOn()) throw unprocessable(TREND_OFF_MESSAGE, 'module_disabled', { module: 'trendIntelligence' });
}
