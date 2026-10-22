/**
 * Which Node.js the platform is willing to run on, and whether the process actually running is one of them.
 *
 * This exists because "update Node" is an instruction nobody can act on without first knowing what is installed, and
 * on this platform the answer is not on the host: the API runs in a container built from `node:22-alpine`, so the
 * host's own `node -v` says nothing about production. The administrator console reads the verdict below from the
 * running process, which is the only place the question has a true answer.
 *
 * The floor is a patch version rather than a major line on purpose. A major line tells you a release series is still
 * supported; it does not tell you whether this particular build carries the fixes published for that series. The
 * minimum below is the first build of each supported line that is not known to be vulnerable, and it moves when
 * upstream publishes a security release — alongside `engines.node` in the root package.json, which a test keeps in
 * step with this file so the two cannot disagree.
 */

/** The lowest acceptable build of each supported release line, newest line first. */
export const SUPPORTED_NODE_LINES = [
  { major: 26, minimum: '26.12.1' },
  { major: 24, minimum: '24.22.1' },
  { major: 22, minimum: '22.23.4' },
] as const;

/** The floor as `engines.node` states it: the oldest build of the oldest supported line. */
export const MIN_NODE = SUPPORTED_NODE_LINES[SUPPORTED_NODE_LINES.length - 1].minimum;

export interface NodeSupport {
  /** The version as the process reports it, with the leading `v`. */
  version: string;
  /** False when the line is no longer supported upstream, or when this build predates its line's security floor. */
  supported: boolean;
  /** The floor this version was judged against, or null when the line itself is not supported at all. */
  minimum: string | null;
  /** Readable enough to put in front of an administrator without a second lookup. */
  reason: string;
}

const parse = (raw: string): [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Numeric comparison, so 22.9.0 is correctly older than 22.23.4 rather than later by string order. */
const olderThan = (a: [number, number, number], b: [number, number, number]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/** Judge a Node version string against the supported lines. Defaults to the process this is running in. */
export function nodeSupport(raw: string = process.version): NodeSupport {
  const version = raw.startsWith('v') ? raw : `v${raw}`;
  const parsed = parse(raw);
  if (!parsed) return { version, supported: false, minimum: null, reason: `unreadable version string ${version}` };
  const line = SUPPORTED_NODE_LINES.find((l) => l.major === parsed[0]);
  if (!line) {
    const lines = SUPPORTED_NODE_LINES.map((l) => l.major).join(', ');
    return { version, supported: false, minimum: null, reason: `Node ${parsed[0]} is not a supported line; supported lines are ${lines}` };
  }
  const floor = parse(line.minimum);
  if (floor && olderThan(parsed, floor)) {
    return { version, supported: false, minimum: line.minimum, reason: `${version} is older than ${line.minimum}, the oldest build of Node ${line.major} without known published vulnerabilities` };
  }
  return { version, supported: true, minimum: line.minimum, reason: `${version} is at or above ${line.minimum}` };
}
