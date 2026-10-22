/**
 * The supported-runtime floor. These tests exist so the three places that state it — this file's constant, the root
 * package.json `engines.node`, and the Dockerfiles' base image — cannot drift apart silently, which is how a platform
 * ends up declaring support for a release line that stopped receiving security fixes months ago.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { nodeSupport, MIN_NODE, SUPPORTED_NODE_LINES } from '../lib/runtime';

const repoRoot = path.resolve(__dirname, '../../../..');
const readRoot = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

describe('supported Node runtimes', () => {
  it('judges a build below its line’s security floor unsupported, and names the floor', () => {
    const v = nodeSupport('v22.22.0');
    expect(v.supported).toBe(false);
    expect(v.minimum).toBe('22.23.4');
    expect(v.reason).toContain('22.23.4');
  });

  it('accepts the floor itself and anything above it, on every supported line', () => {
    for (const line of SUPPORTED_NODE_LINES) {
      expect(nodeSupport(`v${line.minimum}`).supported, `${line.minimum} is the floor`).toBe(true);
      const [maj, min, patch] = line.minimum.split('.').map(Number);
      expect(nodeSupport(`v${maj}.${min}.${patch + 1}`).supported).toBe(true);
      expect(nodeSupport(`v${maj}.${min + 1}.0`).supported).toBe(true);
    }
  });

  it('compares numerically, so a double-digit minor is not read as older than a single-digit one', () => {
    // String comparison puts '22.9.0' after '22.23.4'; the fix for this line shipped in 22.23.4, so it must not pass.
    expect(nodeSupport('v22.9.0').supported).toBe(false);
    expect(nodeSupport('v22.100.0').supported).toBe(true);
  });

  it('refuses a line that is end of life rather than comparing it against a floor it does not have', () => {
    const eol = nodeSupport('v20.20.2');
    expect(eol.supported).toBe(false);
    expect(eol.minimum).toBeNull();
    expect(eol.reason).toContain('not a supported line');
    expect(nodeSupport('v18.20.8').supported).toBe(false);
  });

  it('does not throw on a version string it cannot read', () => {
    const junk = nodeSupport('not-a-version');
    expect(junk.supported).toBe(false);
    expect(junk.reason).toContain('unreadable');
  });

  it('agrees with engines.node in the root package.json', () => {
    const engines = (JSON.parse(readRoot('package.json')) as { engines?: { node?: string } }).engines?.node;
    expect(engines, 'the root package.json must declare engines.node').toBeTruthy();
    expect(engines).toBe(`>=${MIN_NODE}`);
  });

  it('declares a floor the Dockerfiles can actually satisfy', () => {
    // The images track a major line (node:22-alpine) rather than pinning a patch, so the line has to be a supported
    // one; scripts/deploy.sh builds with --pull so a security release within that line reaches the next deploy.
    const dockerfiles = ['backend/api/Dockerfile', 'frontend/web/Dockerfile', 'frontend/admin/Dockerfile'];
    const majors = SUPPORTED_NODE_LINES.map((l) => l.major);
    for (const file of dockerfiles) {
      const bases = [...readRoot(file).matchAll(/^FROM node:(\d+)/gm)].map((m) => Number(m[1]));
      expect(bases.length, `${file} must build on a node base image`).toBeGreaterThan(0);
      for (const major of bases) expect(majors, `${file} builds on Node ${major}`).toContain(major);
    }
    expect(readRoot('scripts/deploy.sh')).toContain('compose build --pull');
  });
});
