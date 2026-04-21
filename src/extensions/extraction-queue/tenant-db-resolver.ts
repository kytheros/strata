import type { Database as SqliteDb } from "better-sqlite3";

export type TenantWriteTarget =
  | { kind: "v2"; worldDb: SqliteDb; agentId: string }
  | {
      kind: "legacy";
      addEntry: (
        text: string,
        tags: string[],
        importance: number,
      ) => Promise<string>;
      agentId: string;
    };

export interface TenantDbResolver {
  withTenantDb<T>(
    tenantId: string,
    agentId: string,
    fn: (target: TenantWriteTarget) => Promise<T>,
  ): Promise<T>;
}

export interface CompositeResolverHandlers {
  v2: <T>(
    worldId: string,
    agentId: string,
    fn: (target: TenantWriteTarget) => Promise<T>,
  ) => Promise<T>;
  legacy: <T>(
    playerId: string,
    agentId: string,
    fn: (target: TenantWriteTarget) => Promise<T>,
  ) => Promise<T>;
}

export class CompositeTenantResolver implements TenantDbResolver {
  constructor(private handlers: CompositeResolverHandlers) {}

  async withTenantDb<T>(
    tenantId: string,
    agentId: string,
    fn: (target: TenantWriteTarget) => Promise<T>,
  ): Promise<T> {
    const idx = tenantId.indexOf(":");
    const prefix = idx < 0 ? tenantId : tenantId.slice(0, idx);
    const rest = idx < 0 ? "" : tenantId.slice(idx + 1);
    if (prefix === "v2") return this.handlers.v2(rest, agentId, fn);
    if (prefix === "legacy") return this.handlers.legacy(rest, agentId, fn);
    throw new Error(`unknown tenant prefix: ${prefix}`);
  }
}
