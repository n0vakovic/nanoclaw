import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  claimGoogleApproval,
  createGoogleApproval,
  decideGoogleApproval,
  finishGoogleApproval,
  getGoogleApproval,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

function pending(expiresAt = '2099-01-01T00:10:00.000Z') {
  return createGoogleApproval({
    id: 'G-0123456789',
    source_group: 'main',
    source_chat_jid: 'tg:100',
    operation: 'calendar.create',
    account_alias: 'work',
    resource_alias: 'work_primary',
    payload_json: '{"exact":true}',
    payload_hash: 'abc123',
    summary: 'Create event',
    created_at: '2099-01-01T00:00:00.000Z',
    expires_at: expiresAt,
  });
}

describe('Google approval ledger', () => {
  it('uses the full durable state machine and erases terminal payloads', () => {
    pending();
    expect(getGoogleApproval('G-0123456789')?.state).toBe('pending');

    decideGoogleApproval(
      'G-0123456789',
      'approved',
      'tg:100',
      '42',
      new Date('2099-01-01T00:01:00.000Z'),
    );
    expect(claimGoogleApproval('G-0123456789').state).toBe('executing');

    const completed = finishGoogleApproval('G-0123456789', {
      state: 'succeeded',
      resultJson: '{"id":"event-1"}',
    });
    expect(completed.state).toBe('succeeded');
    expect(completed.payload_json).toBeNull();
    expect(completed.payload_hash).toBe('abc123');
  });

  it('persists expiry and erases the payload', () => {
    pending('2099-01-01T00:01:00.000Z');

    expect(() =>
      decideGoogleApproval(
        'G-0123456789',
        'approved',
        'tg:100',
        '42',
        new Date('2099-01-01T00:02:00.000Z'),
      ),
    ).toThrow('expired');

    const expired = getGoogleApproval('G-0123456789');
    expect(expired?.state).toBe('expired');
    expect(expired?.payload_json).toBeNull();
  });

  it('allows only one decision and one execution claim', () => {
    pending();
    decideGoogleApproval(
      'G-0123456789',
      'approved',
      'tg:100',
      '42',
      new Date('2099-01-01T00:01:00.000Z'),
    );
    expect(() =>
      decideGoogleApproval(
        'G-0123456789',
        'rejected',
        'tg:100',
        '42',
        new Date('2099-01-01T00:02:00.000Z'),
      ),
    ).toThrow('already approved');
    claimGoogleApproval('G-0123456789');
    expect(() => claimGoogleApproval('G-0123456789')).toThrow('cannot execute');
  });

  it('rejects once and minimizes the retained proposal data', () => {
    pending();
    const rejected = decideGoogleApproval(
      'G-0123456789',
      'rejected',
      'tg:100',
      '42',
      new Date('2099-01-01T00:01:00.000Z'),
    );
    expect(rejected.state).toBe('rejected');
    expect(rejected.payload_json).toBeNull();
    expect(rejected.summary).toBe('calendar.create on work_primary');
  });
});
