/**
 * Connection TLS policy.
 *
 * This exists because the original policy — SSL for anything that is not
 * loopback — made the worker unable to reach Postgres over a Docker bridge or a
 * private VPC address. It tried to negotiate TLS against a server that does not
 * speak it, and every connection failed. The bug was invisible to the test
 * suite, which connects over 127.0.0.1, and only appeared when the worker ran
 * in a container.
 */
import { describe, expect, it } from 'vitest';
import { hostOf, isPrivateHost, resolveSslConfig } from '../src/pool.js';

describe('host extraction', () => {
  it('reads the host from a connection string', () => {
    expect(hostOf('postgresql://u:p@db.example.com:5432/x')).toBe('db.example.com');
    expect(hostOf('postgresql://u:p@172.17.0.2:5432/x')).toBe('172.17.0.2');
    expect(hostOf('postgres://u:p@[::1]:5432/x')).toBe('::1');
  });

  it('returns empty for something unparseable rather than throwing', () => {
    expect(hostOf('not a url')).toBe('');
  });
});

describe('private host classification', () => {
  const priv = [
    '127.0.0.1', '127.5.5.5', 'localhost', 'db.localhost',
    '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.10',
    '169.254.1.1', '100.64.0.1', '0.0.0.0',
    '::1', 'fe80::1', 'fc00::1', 'fd00::1',
    // Compose and Kubernetes service names have no dot.
    'db', 'postgres', 'my-database',
  ];
  for (const host of priv) {
    it(`treats ${host} as private`, () => expect(isPrivateHost(host)).toBe(true));
  }

  const publicHosts = [
    'db.zzlbenmmsjumysqptnhi.supabase.co',
    'aws-0-us-east-1.pooler.supabase.com',
    'example.com',
    '8.8.8.8',
    '172.32.0.1',   // just outside RFC1918
    '172.15.0.1',   // just below RFC1918
    '192.169.1.1',  // adjacent to, but not, 192.168/16
  ];
  for (const host of publicHosts) {
    it(`treats ${host} as public`, () => expect(isPrivateHost(host)).toBe(false));
  }
});

describe('ssl resolution', () => {
  it('stays out of the way when sslmode is stated explicitly', () => {
    expect(resolveSslConfig('postgresql://u:p@h.example.com/x?sslmode=require')).toBeUndefined();
    expect(resolveSslConfig('postgresql://u:p@h.example.com/x?a=b&sslmode=disable')).toBeUndefined();
  });

  it('honours DATABASE_SSL over the inferred default', () => {
    const supabase = 'postgresql://u:p@db.ref.supabase.co:5432/postgres';
    expect(resolveSslConfig(supabase, 'disable')).toBe(false);
    expect(resolveSslConfig(supabase, 'require')).toEqual({ rejectUnauthorized: true });
    expect(resolveSslConfig(supabase, 'no-verify')).toEqual({ rejectUnauthorized: false });
    // Case and padding should not change the decision.
    expect(resolveSslConfig(supabase, '  DISABLE  ')).toBe(false);
  });

  it('disables TLS for a database on a network we already control', () => {
    // Each of these previously produced a TLS attempt against a plaintext
    // server, which is the bug this policy exists to prevent.
    for (const url of [
      'postgresql://postgres:postgres@127.0.0.1:55432/mcp_upgrade_test',
      'postgresql://postgres:postgres@172.17.0.2:5432/mcp_upgrade_test',
      'postgresql://postgres:postgres@db:5432/mcp_upgrade_test',
      'postgresql://postgres:postgres@10.0.1.5:5432/app',
      'postgresql://postgres:postgres@localhost:5432/app',
    ]) {
      expect(resolveSslConfig(url, undefined), url).toBe(false);
    }
  });

  it('enables TLS for anything reachable over the public internet', () => {
    for (const url of [
      'postgresql://u:p@db.ref.supabase.co:5432/postgres',
      'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
    ]) {
      expect(resolveSslConfig(url, undefined), url).toEqual({ rejectUnauthorized: false });
    }
  });
});
