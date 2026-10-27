import { describe, expect, it } from 'vitest';
import type { ClientSnapshot } from '../camera/client';
import { STRINGS } from '../i18n';
import { badge, cameraRows, justWentOnline, manualErrorKey, retrySeconds, statusKind, statusView } from './connectModel';

const snap = (p: Partial<ClientSnapshot> = {}): ClientSnapshot => ({
  status: 'searching', needsConnect: false, found: [], target: null, hello: null, unsupported: false, reconciling: false, ...p,
});
const cam = (cameraId: string, name = cameraId) => ({ cameraId, name, protocolVersions: { min: 1, max: 1 }, host: '10.0.0.' + cameraId.length, port: 8765 });

describe('connect view-model', () => {
  it('maps every status to a message that exists in the tables', () => {
    for (const status of ['searching', 'connecting', 'online', 'offline', 'busy', 'replaced', 'wrong-camera'] as const) {
      const v = statusView(snap({ status, retryAfterMs: 3000 }));
      expect(STRINGS.pl[v.messageKey], status).toBeDefined();
      expect(STRINGS.ru[v.messageKey], status).toBeDefined();
    }
  });

  it('unsupported protocol wins over offline', () => {
    expect(statusKind(snap({ status: 'offline', unsupported: true }))).toBe('unsupported');
  });

  it('BUSY shows the retry countdown, never below 1 s, and counts down', () => {
    const s = snap({ status: 'busy', retryAfterMs: 5000 });
    expect(statusView(s, 0)).toMatchObject({ messageKey: 'connect.status.busy', params: { s: 5 } });
    expect(statusView(s, 2100).params).toEqual({ s: 3 });
    expect(statusView(s, 99_000).params).toEqual({ s: 1 });
    expect(retrySeconds(undefined, 0)).toBeUndefined();
    expect(statusView(snap({ status: 'busy' })).messageKey).toBe('connect.status.busyNoTime');
  });

  it('"Przejmij" only after the session was replaced (4001)', () => {
    expect(statusView(snap({ status: 'replaced' })).canTakeOver).toBe(true);
    for (const status of ['online', 'busy', 'offline', 'wrong-camera', 'connecting'] as const) {
      expect(statusView(snap({ status })).canTakeOver, status).toBe(false);
    }
  });

  it('wrong camera and offline have their own plain messages', () => {
    expect(statusView(snap({ status: 'wrong-camera' })).messageKey).toBe('connect.status.wrongCamera');
    expect(statusView(snap({ status: 'offline' })).messageKey).toBe('connect.status.offline');
  });

  it('camera rows: the connected one is online, a connecting one connecting, others available', () => {
    const found = [cam('cam-A', 'Alfa'), cam('cam-BB')];
    const target = { cameraId: 'cam-A', host: 'h', port: 1, source: 'nsd' as const };
    expect(cameraRows(snap({ found, target, status: 'online' })).map((r) => [r.name, r.state])).toEqual([
      ['Alfa', 'online'], ['cam-BB', 'available'],
    ]);
    expect(cameraRows(snap({ found, target, status: 'connecting' }))[0]!.state).toBe('connecting');
    expect(cameraRows(snap({ found, target, status: 'offline' }))[0]!.state).toBe('available');
    expect(cameraRows(snap())).toEqual([]);
  });

  it('manual errors map to messages that exist', () => {
    for (const reason of ['invalid-address', 'unreachable', 'bad-response', 'unsupported-version', 'wrong-camera'] as const) {
      const k = manualErrorKey({ ok: false, reason, message: '' });
      expect(STRINGS.pl[k], reason).toBeDefined();
    }
  });

  it('leaves the screen only on the transition to online', () => {
    expect(justWentOnline(undefined, 'online')).toBe(false); // already online when opened
    expect(justWentOnline('connecting', 'online')).toBe(true);
    expect(justWentOnline('online', 'online')).toBe(false);
    expect(justWentOnline('busy', 'busy')).toBe(false);
  });

  it('badge: ok / wait / bad', () => {
    expect(badge(snap({ status: 'online' }))).toEqual({ key: 'conn.online', tone: 'ok' });
    expect(badge(snap({ status: 'searching' })).tone).toBe('wait');
    expect(badge(snap({ status: 'busy' })).tone).toBe('bad');
    expect(badge(snap({ status: 'offline' })).key).toBe('conn.offline');
    expect(badge(snap({ status: 'online', unsupported: true })).key).toBe('conn.offline');
  });
});
