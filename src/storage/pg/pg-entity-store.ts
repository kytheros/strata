/**
 * Postgres-backed entity store for cross-session entity tracking.
 *
 * Implements IEntityStore using pg Pool async APIs.
 * No FTS -- entities use ILIKE for search, same as D1 adapter.
 */

import type { PgPool } from "./pg-types.js";
import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";
import type { EntityType } from "../../knowledge/entity-extractor.js";
import type {
  IEntityStore,
  EntityRow,
  EntityInput,
  EntityRelationRow,
  RelationInput,
  EntityListOptions,
  EntityGraph,
} from "../interfaces/index.js";
import { randomUUID } from "crypto";

/** Row shape from the entities table in Postgres. */
interface PgEntityRow {
  id: string;
  name: string;
  type: string;
  canonical_name: string;
  aliases: string;
  first_seen: string; // bigint
  last_seen: string;  // bigint
  mention_count: number;
  project: string | null;
  user_scope: string | null;
}

function pgRowToEntityRow(row: PgEntityRow): EntityRow {
  return {
    id: row.id,
    name: row.name,
    type: row.type as EntityType,
    canonical_name: row.canonical_name,
    aliases: row.aliases,
    first_seen: Number(row.first_seen),
    last_seen: Number(row.last_seen),
    mention_count: row.mention_count,
    project: row.project,
    user: row.user_scope,
  };
}

export class PgEntityStore implements IEntityStore {
  constructor(
    private pool: PgPool,
    private userId: string,
  ) {}

  async upsertEntity(input: EntityInput): Promise<string> {
    const { rows: existingRows } = await this.pool.query<PgEntityRow>(
      "SELECT * FROM entities WHERE LOWER(canonical_name) = LOWER($1) AND (user_scope = $2 OR user_scope IS NULL)",
      [input.canonicalName, input.user ?? this.userId]
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];
      // Merge aliases
      const existingAliases: string[] = existing.aliases ? JSON.parse(existing.aliases) : [];
      const mergedSet = new Set([
        ...existingAliases.map((a) => a.toLowerCase()),
        ...input.aliases.map((a) => a.toLowerCase()),
      ]);
      const mergedAliases = [...mergedSet];

      await this.pool.query(
        `UPDATE entities
         SET last_seen = $1,
             mention_count = mention_count + 1,
             aliases = $2
         WHERE LOWER(canonical_name) = LOWER($3) AND (user_scope = $4 OR user_scope IS NULL)`,
        [
          Math.max(input.lastSeen, Number(existing.last_seen)),
          JSON.stringify(mergedAliases),
          input.canonicalName,
          input.user ?? this.userId,
        ]
      );
      return existing.id;
    }

    await this.pool.query(
      `INSERT INTO entities (id, name, type, canonical_name, aliases, first_seen, last_seen, mention_count, project, user_scope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
      [
        input.id,
        input.name,
        input.type,
        input.canonicalName,
        JSON.stringify(input.aliases.map((a) => a.toLowerCase())),
        input.firstSeen,
        input.lastSeen,
        input.project ?? null,
        input.user ?? this.userId,
      ]
    );
    return input.id;
  }

  async addRelation(input: RelationInput): Promise<void> {
    // Verify source entity belongs to this user
    const { rows: sourceRows } = await this.pool.query(
      "SELECT id FROM entities WHERE id = $1 AND (user_scope = $2 OR user_scope IS NULL)",
      [input.sourceEntityId, this.userId]
    );
    if (sourceRows.length === 0) return;

    // Check for existing relation
    const { rows: existingRows } = await this.pool.query(
      "SELECT 1 FROM entity_relations WHERE source_entity_id = $1 AND target_entity_id = $2 AND relation_type = $3",
      [input.sourceEntityId, input.targetEntityId, input.relationType]
    );
    if (existingRows.length > 0) return;

    await this.pool.query(
      `INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, context, session_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        input.sourceEntityId,
        input.targetEntityId,
        input.relationType,
        input.context ?? null,
        input.sessionId ?? null,
        Date.now(),
      ]
    );
  }

  async linkToKnowledge(entryId: string, entityId: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO knowledge_entities (entry_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [entryId, entityId]
    );
  }

  async findByName(name: string): Promise<EntityRow | undefined> {
    const { rows } = await this.pool.query<PgEntityRow>(
      "SELECT * FROM entities WHERE LOWER(canonical_name) = LOWER($1) AND (user_scope = $2 OR user_scope IS NULL)",
      [name, this.userId]
    );
    return rows.length > 0 ? pgRowToEntityRow(rows[0]) : undefined;
  }

  async findByType(type: EntityType, project?: string): Promise<EntityRow[]> {
    if (project) {
      const { rows } = await this.pool.query<PgEntityRow>(
        "SELECT * FROM entities WHERE type = $1 AND project = $2 AND (user_scope = $3 OR user_scope IS NULL) ORDER BY mention_count DESC",
        [type, project, this.userId]
      );
      return rows.map(pgRowToEntityRow);
    }
    const { rows } = await this.pool.query<PgEntityRow>(
      "SELECT * FROM entities WHERE type = $1 AND (user_scope = $2 OR user_scope IS NULL) ORDER BY mention_count DESC",
      [type, this.userId]
    );
    return rows.map(pgRowToEntityRow);
  }

  async getRelationsFor(entityId: string): Promise<EntityRelationRow[]> {
    // Verify entity belongs to this user
    const { rows: entityRows } = await this.pool.query(
      "SELECT id FROM entities WHERE id = $1 AND (user_scope = $2 OR user_scope IS NULL)",
      [entityId, this.userId]
    );
    if (entityRows.length === 0) return [];

    const { rows } = await this.pool.query<{
      id: string; source_entity_id: string; target_entity_id: string;
      relation_type: string; context: string | null; session_id: string | null;
      created_at: string;
    }>(
      `SELECT DISTINCT er.id, er.source_entity_id, er.target_entity_id,
              er.relation_type, er.context, er.session_id, er.created_at
       FROM entity_relations er
       JOIN entities e ON e.id = er.source_entity_id OR e.id = er.target_entity_id
       WHERE (er.source_entity_id = $1 OR er.target_entity_id = $1)
       AND (e.user_scope = $2 OR e.user_scope IS NULL)
       ORDER BY er.created_at DESC`,
      [entityId, this.userId]
    );

    return rows.map((r) => ({
      id: r.id,
      source_entity_id: r.source_entity_id,
      target_entity_id: r.target_entity_id,
      relation_type: r.relation_type,
      context: r.context,
      session_id: r.session_id,
      created_at: Number(r.created_at),
    }));
  }

  async getKnowledgeForEntity(entityId: string): Promise<KnowledgeEntry[]> {
    const { rows } = await this.pool.query<{
      id: string; type: string; project: string; session_id: string;
      timestamp: string; summary: string; details: string;
      tags: string | null; related_files: string | null;
      occurrences: number | null; project_count: number | null;
      extracted_at: string | null; user_scope: string;
    }>(
      `SELECT k.* FROM knowledge k
       INNER JOIN knowledge_entities ke ON ke.entry_id = k.id
       WHERE ke.entity_id = $1
       ORDER BY k.timestamp DESC`,
      [entityId]
    );

    return rows.map((row) => ({
      id: row.id,
      type: row.type as KnowledgeEntry["type"],
      project: row.project,
      user: row.user_scope,
      sessionId: row.session_id,
      timestamp: Number(row.timestamp),
      summary: row.summary,
      details: row.details,
      tags: row.tags ? JSON.parse(row.tags) : [],
      relatedFiles: row.related_files ? JSON.parse(row.related_files) : [],
      occurrences: row.occurrences ?? undefined,
      projectCount: row.project_count ?? undefined,
      extractedAt: row.extracted_at ? Number(row.extracted_at) : undefined,
    }));
  }

  async searchEntities(query: string, type?: EntityType, limit?: number): Promise<EntityRow[]> {
    const effectiveLimit = Math.max(1, Math.min(limit ?? 20, 100));

    if (type) {
      const { rows } = await this.pool.query<PgEntityRow>(
        `SELECT * FROM entities
         WHERE (LOWER(canonical_name) LIKE '%' || LOWER($1) || '%'
            OR LOWER(aliases) LIKE '%' || LOWER($1) || '%'
            OR LOWER(name) LIKE '%' || LOWER($1) || '%')
           AND type = $2
           AND (user_scope = $3 OR user_scope IS NULL)
         ORDER BY mention_count DESC
         LIMIT $4`,
        [query, type, this.userId, effectiveLimit]
      );
      return rows.map(pgRowToEntityRow);
    }

    const { rows } = await this.pool.query<PgEntityRow>(
      `SELECT * FROM entities
       WHERE (LOWER(canonical_name) LIKE '%' || LOWER($1) || '%'
          OR LOWER(aliases) LIKE '%' || LOWER($1) || '%'
          OR LOWER(name) LIKE '%' || LOWER($1) || '%')
         AND (user_scope = $2 OR user_scope IS NULL)
       ORDER BY mention_count DESC
       LIMIT $3`,
      [query, this.userId, effectiveLimit]
    );
    return rows.map(pgRowToEntityRow);
  }

  async getTopEntities(limit: number = 20): Promise<EntityRow[]> {
    const { rows } = await this.pool.query<PgEntityRow>(
      "SELECT * FROM entities WHERE user_scope = $1 OR user_scope IS NULL ORDER BY mention_count DESC LIMIT $2",
      [this.userId, limit]
    );
    return rows.map(pgRowToEntityRow);
  }

  async getById(id: string): Promise<EntityRow | undefined> {
    const { rows } = await this.pool.query<PgEntityRow>(
      "SELECT * FROM entities WHERE id = $1 AND (user_scope = $2 OR user_scope IS NULL)",
      [id, this.userId]
    );
    return rows.length > 0 ? pgRowToEntityRow(rows[0]) : undefined;
  }

  async getEntities(options: EntityListOptions): Promise<{ entities: EntityRow[]; total: number }> {
    const conditions: string[] = ["(user_scope = $1 OR user_scope IS NULL)"];
    const params: unknown[] = [this.userId];
    let paramIdx = 2;

    if (options.type) {
      conditions.push(`type = $${paramIdx}`);
      params.push(options.type);
      paramIdx++;
    }

    if (options.project) {
      conditions.push(`project = $${paramIdx}`);
      params.push(options.project);
      paramIdx++;
    }

    if (options.search) {
      conditions.push(
        `(LOWER(canonical_name) LIKE '%' || LOWER($${paramIdx}) || '%' OR LOWER(aliases) LIKE '%' || LOWER($${paramIdx}) || '%')`
      );
      params.push(options.search);
      paramIdx++;
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    let orderBy: string;
    switch (options.sort) {
      case "recent":
        orderBy = "ORDER BY last_seen DESC";
        break;
      case "oldest":
        orderBy = "ORDER BY first_seen ASC";
        break;
      case "mentions":
      default:
        orderBy = "ORDER BY mention_count DESC";
        break;
    }

    const countParams = [...params];
    // nosemgrep: sql-injection-template-literal -- where from code-controlled conditions
    const { rows: countRows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM entities ${where}`,
      countParams
    );

    params.push(options.limit, options.offset);
    // nosemgrep: sql-injection-template-literal -- where/orderBy from code-controlled conditions
    const { rows } = await this.pool.query<PgEntityRow>(
      `SELECT * FROM entities ${where} ${orderBy} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    );

    return { entities: rows.map(pgRowToEntityRow), total: Number(countRows[0].count) };
  }

  async getEntityGraph(project?: string): Promise<EntityGraph> {
    let entityRows: PgEntityRow[];

    if (project) {
      const { rows } = await this.pool.query<PgEntityRow>(
        "SELECT * FROM entities WHERE project = $1 AND (user_scope = $2 OR user_scope IS NULL)",
        [project, this.userId]
      );
      entityRows = rows;
    } else {
      const { rows } = await this.pool.query<PgEntityRow>(
        "SELECT * FROM entities WHERE user_scope = $1 OR user_scope IS NULL",
        [this.userId]
      );
      entityRows = rows;
    }

    const nodes = entityRows.map((e) => ({
      id: e.id,
      name: e.canonical_name,
      type: e.type,
      mentions: e.mention_count,
    }));

    const entityIds = new Set(entityRows.map((e) => e.id));

    let relationsRows: { id: string; source_entity_id: string; target_entity_id: string; relation_type: string; context: string | null }[] = [];

    if (entityIds.size > 0) {
      const { rows } = await this.pool.query<{
        id: string; source_entity_id: string; target_entity_id: string;
        relation_type: string; context: string | null;
      }>(
        `SELECT er.* FROM entity_relations er
         JOIN entities e ON e.id = er.source_entity_id
         WHERE (e.user_scope = $1 OR e.user_scope IS NULL)`,
        [this.userId]
      );
      relationsRows = rows;
    }

    const edges = relationsRows
      .filter((r) => entityIds.has(r.source_entity_id) && entityIds.has(r.target_entity_id))
      .map((r) => ({
        source: r.source_entity_id,
        target: r.target_entity_id,
        type: r.relation_type,
        context: r.context ?? undefined,
      }));

    return { nodes, edges };
  }

  async getEntityTypeDistribution(project?: string): Promise<Record<string, number>> {
    let sql: string;
    let params: unknown[];

    if (project) {
      sql = "SELECT type, COUNT(*) as count FROM entities WHERE project = $1 AND (user_scope = $2 OR user_scope IS NULL) GROUP BY type";
      params = [project, this.userId];
    } else {
      sql = "SELECT type, COUNT(*) as count FROM entities WHERE user_scope = $1 OR user_scope IS NULL GROUP BY type";
      params = [this.userId];
    }

    const { rows } = await this.pool.query<{ type: string; count: string }>(sql, params);

    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row.type] = Number(row.count);
    }
    return out;
  }
}
