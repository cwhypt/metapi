import { describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { authMiddleware, extractClientIp, isIpAllowed } from './auth.js';

describe('auth middleware IP helpers', () => {
  it('extracts first forwarded IP and normalizes ipv4-mapped address', () => {
    const ip = extractClientIp('::ffff:10.0.0.1', '198.51.100.7, 203.0.113.2');
    expect(ip).toBe('198.51.100.7');
  });

  it('allows request when allowlist is empty', () => {
    expect(isIpAllowed('203.0.113.8', [])).toBe(true);
  });

  it('rejects non-allowlisted IP when allowlist is configured', () => {
    expect(isIpAllowed('203.0.113.8', ['203.0.113.9'])).toBe(false);
    expect(isIpAllowed('203.0.113.9', ['203.0.113.9'])).toBe(true);
  });

  it('matches ipv4 CIDR ranges in the allowlist', () => {
    expect(isIpAllowed('8.8.8.8', ['8.8.8.0/24'])).toBe(true);
    expect(isIpAllowed('8.8.9.8', ['8.8.8.0/24'])).toBe(false);
    expect(isIpAllowed('8.8.8.8', ['8.8.0.0/16'])).toBe(true);
  });

  it('ignores malformed CIDR entries instead of matching unexpectedly', () => {
    expect(isIpAllowed('8.8.8.8', ['8.8.8.0/99'])).toBe(false);
    expect(isIpAllowed('8.8.8.8', ['not-an-ip/24'])).toBe(false);
  });

  it('authenticates by token even when a legacy admin IP allowlist is configured', async () => {
    const originalAuthToken = config.authToken;
    const originalAdminIpAllowlist = config.adminIpAllowlist;

    config.authToken = 'secret-token';
    config.adminIpAllowlist = ['203.0.113.9'];

    const send = vi.fn();
    const code = vi.fn(() => ({ send }));
    const reply = { code } as any;
    const request = {
      ip: '198.51.100.7',
      headers: {
        authorization: 'Bearer secret-token',
        'x-forwarded-for': '198.51.100.7',
      },
    } as any;

    try {
      await authMiddleware(request, reply);
      expect(code).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      config.authToken = originalAuthToken;
      config.adminIpAllowlist = originalAdminIpAllowlist;
    }
  });
});
