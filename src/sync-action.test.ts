import { describe, it, expect } from 'vitest';

import { pickVerb, inflowHeader } from './sync-action.js';

const NOW_DATE = '20260504';
const NOW_TS = '20260504T091234';
const noExists = () => false;

describe('pickVerb — non-fragments paths', () => {
  it('plain .md outside fragments → write', () => {
    expect(pickVerb('concepts/foo.md', NOW_DATE, NOW_TS, noExists)).toEqual({
      verb: 'write',
      targetRelPath: 'concepts/foo.md',
    });
  });

  it('plain .md at the root of a repo → write', () => {
    expect(pickVerb('foo.md', NOW_DATE, NOW_TS, noExists)).toEqual({
      verb: 'write',
      targetRelPath: 'foo.md',
    });
  });

  it('.inflow.md outside fragments → append, target strips .inflow', () => {
    expect(
      pickVerb('concepts/foo.inflow.md', NOW_DATE, NOW_TS, noExists),
    ).toEqual({ verb: 'append', targetRelPath: 'concepts/foo.md' });
  });

  it('top-level .inflow.md (not fragments) → append', () => {
    expect(pickVerb('foo.inflow.md', NOW_DATE, NOW_TS, noExists)).toEqual({
      verb: 'append',
      targetRelPath: 'foo.md',
    });
  });
});

describe('pickVerb — fragments snapshots', () => {
  it('fragments/<base>.inflow.md → fragments/<base>/<base>.<nowDate>.md when no collision', () => {
    expect(
      pickVerb('fragments/memgraph.inflow.md', NOW_DATE, NOW_TS, noExists),
    ).toEqual({
      verb: 'snapshot',
      targetRelPath: `fragments/memgraph/memgraph.${NOW_DATE}.md`,
    });
  });

  it('fragments/<base>.inflow.md → escalates to <base>.<nowTs>.md on collision', () => {
    const dated = `fragments/memgraph/memgraph.${NOW_DATE}.md`;
    expect(
      pickVerb(
        'fragments/memgraph.inflow.md',
        NOW_DATE,
        NOW_TS,
        (rel) => rel === dated,
      ),
    ).toEqual({
      verb: 'snapshot',
      targetRelPath: `fragments/memgraph/memgraph.${NOW_TS}.md`,
    });
  });

  it('fragments/<base>/<base>.<YYYYMMDD>.inflow.md → strip .inflow when no collision', () => {
    expect(
      pickVerb(
        'fragments/software-2.0/software-2.0.20260406.inflow.md',
        NOW_DATE,
        NOW_TS,
        noExists,
      ),
    ).toEqual({
      verb: 'snapshot',
      targetRelPath: 'fragments/software-2.0/software-2.0.20260406.md',
    });
  });

  it('fragments/<base>/<base>.<YYYYMMDD>.inflow.md → appends HHMMSS on collision', () => {
    const target = 'fragments/software-2.0/software-2.0.20260406.md';
    expect(
      pickVerb(
        'fragments/software-2.0/software-2.0.20260406.inflow.md',
        NOW_DATE,
        NOW_TS,
        (rel) => rel === target,
      ),
    ).toEqual({
      verb: 'snapshot',
      targetRelPath: 'fragments/software-2.0/software-2.0.20260406.091234.md',
    });
  });

  it('fragments/<base>/<other>.md (plain variant) → snapshot, write-through path unchanged', () => {
    expect(
      pickVerb(
        'fragments/software-2.0/software-2.0.20260124.newsletter.md',
        NOW_DATE,
        NOW_TS,
        noExists,
      ),
    ).toEqual({
      verb: 'snapshot',
      targetRelPath:
        'fragments/software-2.0/software-2.0.20260124.newsletter.md',
    });
  });

  it('fragments/<base>.md (plain, top of fragments) → throws to protect canonical', () => {
    expect(() =>
      pickVerb('fragments/memgraph.md', NOW_DATE, NOW_TS, noExists),
    ).toThrow(/canonical/);
  });
});

describe('inflowHeader', () => {
  it('contains the timestamp and source path inside an HTML comment', () => {
    const header = inflowHeader(
      'concepts/ibmr.inflow.md',
      '2026-04-30T13:01:45.000Z',
    );
    expect(header).toBe(
      '\n\n---\n<!-- inflow from DamRassBot · 2026-04-30T13:01:45.000Z · concepts/ibmr.inflow.md -->\n',
    );
  });

  it('starts with two newlines so it always separates from prior content', () => {
    const header = inflowHeader('a.md', '2026-01-01T00:00:00.000Z');
    expect(header.startsWith('\n\n')).toBe(true);
  });
});
