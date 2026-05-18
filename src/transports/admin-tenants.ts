/**
 * Admin endpoint for multi-tenant namespace provisioning.
 *
 * POST /admin/tenants
 *   - Auth: Authorization: Bearer <STRATA_ADMIN_TOKEN>
 *   - Body: { tenant_token: string }
 *   - Response 201: { tenant_token, created: true }
 *   - Response 400: { error: 'invalid_input', issues: [...] }
 *   - Response 401: { error: 'unauthorized' }
 *
 * Used by PointsPilot on user signup to ensure a Strata namespace exists
 * for each user. Idempotent — calling with the same tenant_token twice
 * must not error or duplicate. See specs/2026-05-18-pointspilot-design.md §4.2.
 */

import { z } from 'zod';

const schema = z.object({
  tenant_token: z
    .string()
    .uuid()
    .or(z.string().regex(/^[a-z0-9-]{16,64}$/)),
});

export interface AdminContext {
  adminToken: string;
  /**
   * Ensures the namespace for tenant_token exists.
   * Must be idempotent — safe to call multiple times for the same token.
   * For v1, the caller provides this; a future Durable Object promotion
   * replaces the implementation without changing this interface.
   */
  ensureTenantNamespace: (tenant_token: string) => Promise<void>;
}

/** Parse a JSON body from a Web-standard Request (used in tests; Node path uses parseBody). */
async function parseRequestJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleAdminCreateTenant(
  req: Request,
  ctx: AdminContext
): Promise<Response> {
  // Auth check: require Bearer <adminToken>
  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader !== `Bearer ${ctx.adminToken}`) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  // Parse + validate body
  const raw = await parseRequestJson(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }

  const { tenant_token } = parsed.data;
  await ctx.ensureTenantNamespace(tenant_token);

  return jsonResponse({ tenant_token, created: true }, 201);
}
