import { describe, it, expect } from 'vitest';
import { handleAdminCreateTenant } from '../../src/transports/admin-tenants.js';

describe('POST /admin/tenants', () => {
  it('rejects requests without admin token', async () => {
    const req = new Request('http://localhost/admin/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_token: 'abc-123-def-456-ghi' }),
    });
    const res = await handleAdminCreateTenant(req as any, { adminToken: 'expected', ensureTenantNamespace: async () => {} });
    expect(res.status).toBe(401);
  });

  it('creates a tenant given a valid token + body', async () => {
    const req = new Request('http://localhost/admin/tenants', {
      method: 'POST',
      headers: { 'authorization': 'Bearer expected', 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_token: 'b3a1-valid-token-here' }),
    });
    const res = await handleAdminCreateTenant(req as any, { adminToken: 'expected', ensureTenantNamespace: async () => {} });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.tenant_token).toBe('b3a1-valid-token-here');
    expect(body.created).toBe(true);
  });
});
