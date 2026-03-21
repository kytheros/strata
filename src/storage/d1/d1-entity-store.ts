/**
 * D1-backed entity store for cross-session entity tracking.
 *
 * Implements IEntityStore using Cloudflare D1 async APIs.
 * Mirrors SqliteEntityStore method-for-method, including upsert with alias
 * merging, relations, knowledge-entity links, and graph projection.
 */

import type { D1Database } from "./d1-types.js";
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

/** Escape SQL LIKE wildcards (% and _) in user input to prevent pattern injection. */
function escapeLike(input: string): string {
  return input.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Generate a UUID v4. Uses crypto.randomUUID() when available (Workers runtime),
 * otherwise falls back to a manual implementation.
 */
function generateUUID(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class D1EntityStore implements IEntityStore {
  constructor(
    private db: D1Database,
    private userId: string,
  ) {}

  /**
   * Upsert an entity. If canonical_name already exists (case-insensitive),
   * increments mention_count, updates last_seen, and merges aliases.
   */
  async upsertEntity(input: EntityInput): Promise<string> {
    const existing = await this.db
      .prepare("SELECT * FROM entities WHERE LOWER(canonical_name) = LOWER(?) AND (user = ? OR user IS NULL)")
      .bind(input.canonicalName, input.user ?? this.userId)
      .first<EntityRow>();

    if (existing) {
      // Merge aliases
      const existingAliases: string[] = existing.aliases
        ? JSON.parse(existing.aliases)
        : [];
      const mergedSet = new Set([
        ...existingAliases.map((a) => a.toLowerCase()),
        ...input.aliases.map((a) => a.toLowerCase()),
      ]);
      const mergedAliases = [...mergedSet];

      await this.db
        .prepare(`
          UPDATE entities
          SET last_seen = ?,
              mention_count = mention_count + 1,
              aliases = ?
          WHERE LOWER(canonical_name) = LOWER(?) AND (user = ? OR user IS NULL)
        `)
        .bind(
          Math.max(input.lastSeen, existing.last_seen),
          JSON.stringify(mergedAliases),
          input.canonicalName,
          input.user ?? this.userId
        )
        .run();
      return existing.id;
    }

    await this.db
      .prepare(`
        INSERT INTO entities (id, name, type, canonical_name, aliases, first_seen, last_seen, mention_count, project, user)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `)
      .bind(
        input.id,
        input.name,
        input.type,
        input.canonicalName,
        JSON.stringify(input.aliases.map((a) => a.toLowerCase())),
        input.firstSeen,
        input.lastSeen,
        input.project ?? null,
        input.user ?? this.userId
      )
      .run();
    return input.id;
  }

  /**
   * Add a relation between two entities. Silently ignores duplicates
   * on (source, target, relation_type) triples.
   */
  async addRelation(input: RelationInput): Promise<void> {
    // Verify source entity belongs to this user before creating a relation
    const sourceEntity = await this.db
      .prepare("SELECT id FROM entities WHERE id = ? AND (user = ? OR user IS NULL)")
      .bind(input.sourceEntityId, this.userId)
      .first<{ id: string }>();
    if (!sourceEntity) return; // Entity doesn't belong to this user

    const exists = await this.db
      .prepare(
        "SELECT 1 FROM entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?"
      )
      .bind(input.sourceEntityId, input.targetEntityId, input.relationType)
      .first();
    if (exists) return;

    await this.db
      .prepare(`
        INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, context, session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        generateUUID(),
        input.sourceEntityId,
        input.targetEntityId,
        input.relationType,
        input.context ?? null,
        input.sessionId ?? null,
        Date.now()
      )
      .run();
  }

  /**
   * Link a knowledge entry to an entity. Silently ignores duplicate pairs.
   */
  async linkToKnowledge(entryId: string, entityId: string): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO knowledge_entities (entry_id, entity_id) VALUES (?, ?)")
      .bind(entryId, entityId)
      .run();
  }

  async findByName(name: string): Promise<EntityRow | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM entities WHERE LOWER(canonical_name) = LOWER(?) AND (user = ? OR user IS NULL)")
      .bind(name, this.userId)
      .first<EntityRow>();
    return row ?? undefined;
  }

  async findByType(type: EntityType, project?: string): Promise<EntityRow[]> {
    if (project) {
      const result = await this.db
        .prepare(
          "SELECT * FROM entities WHERE type = ? AND project = ? AND (user = ? OR user IS NULL) ORDER BY mention_count DESC"
        )
        .bind(type, project, this.userId)
        .all<EntityRow>();
      return result.results;
    }
    const result = await this.db
      .prepare(
        "SELECT * FROM entities WHERE type = ? AND (user = ? OR user IS NULL) ORDER BY mention_count DESC"
      )
      .bind(type, this.userId)
      .all<EntityRow>();
    return result.results;
  }

  async getRelationsFor(entityId: string): Promise<EntityRelationRow[]> {
    // First verify the entity belongs to this user
    const entity = await this.db
      .prepare("SELECT id FROM entities WHERE id = ? AND (user = ? OR user IS NULL)")
      .bind(entityId, this.userId)
      .first<{ id: string }>();
    if (!entity) return [];

    const result = await this.db
      .prepare(`
        SELECT er.* FROM entity_relations er
        JOIN entities e ON e.id = er.source_entity_id OR e.id = er.target_entity_id
        WHERE (er.source_entity_id = ? OR er.target_entity_id = ?)
        AND (e.user = ? OR e.user IS NULL)
        ORDER BY er.created_at DESC
      `)
      .bind(entityId, entityId, this.userId)
      .all<EntityRelationRow>();
    return result.results;
  }

  async getKnowledgeForEntity(entityId: string): Promise<KnowledgeEntry[]> {
    const result = await this.db
      .prepare(`
        SELECT k.* FROM knowledge k
        INNER JOIN knowledge_entities ke ON ke.entry_id = k.id
        WHERE ke.entity_id = ?
        ORDER BY k.timestamp DESC
      `)
      .bind(entityId)
      .all<{
        id: string;
        type: string;
        project: string;
        session_id: string;
        timestamp: number;
        summary: string;
        details: string;
        tags: string | null;
        related_files: string | null;
        occurrences: number | null;
        project_count: number | null;
        extracted_at: number | null;
        user: string;
      }>();

    return result.results.map((row) => ({
      id: row.id,
      type: row.type as KnowledgeEntry["type"],
      project: row.project,
      user: row.user,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      summary: row.summary,
      details: row.details,
      tags: row.tags ? JSON.parse(row.tags) : [],
      relatedFiles: row.related_files ? JSON.parse(row.related_files) : [],
      occurrences: row.occurrences ?? undefined,
      projectCount: row.project_count ?? undefined,
      extractedAt: row.extracted_at ?? undefined,
    }));
  }

  async searchEntities(
    query: string,
    type?: EntityType,
    limit?: number
  ): Promise<EntityRow[]> {
    const effectiveLimit = Math.max(1, Math.min(limit ?? 20, 100));
    const escaped = escapeLike(query);

    let sql: string;
    let params: unknown[];

    if (type) {
      sql = `
        SELECT * FROM entities
        WHERE (LOWER(canonical_name) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
           OR LOWER(aliases) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
           OR LOWER(name) LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
          AND type = ?
          AND (user = ? OR user IS NULL)
        ORDER BY mention_count DESC
        LIMIT ?
      `;
      params = [escaped, escaped, escaped, type, this.userId, effectiveLimit];
    } else {
      sql = `
        SELECT * FROM entities
        WHERE (LOWER(canonical_name) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
           OR LOWER(aliases) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'
           OR LOWER(name) LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
          AND (user = ? OR user IS NULL)
        ORDER BY mention_count DESC
        LIMIT ?
      `;
      params = [escaped, escaped, escaped, this.userId, effectiveLimit];
    }

    const result = await this.db.prepare(sql).bind(...params).all<EntityRow>();
    return result.results;
  }

  async getTopEntities(limit: number = 20): Promise<EntityRow[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM entities WHERE user = ? OR user IS NULL ORDER BY mention_count DESC LIMIT ?"
      )
      .bind(this.userId, limit)
      .all<EntityRow>();
    return result.results;
  }

  async getById(id: string): Promise<EntityRow | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM entities WHERE id = ? AND (user = ? OR user IS NULL)")
      .bind(id, this.userId)
      .first<EntityRow>();
    return row ?? undefined;
  }

  async getEntities(options: EntityListOptions): Promise<{ entities: EntityRow[]; total: number }> {
    const conditions: string[] = ["(user = ? OR user IS NULL)"];
    const params: unknown[] = [this.userId];

    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }

    if (options.project) {
      conditions.push("project = ?");
      params.push(options.project);
    }

    if (options.search) {
      const escaped = escapeLike(options.search);
      conditions.push(
        "(LOWER(canonical_name) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' OR LOWER(aliases) LIKE '%' || LOWER(?) || '%' ESCAPE '\\')"
      );
      params.push(escaped, escaped);
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

    const countRow = await this.db
      // nosemgrep: semgrep.sql-injection-template-literal — where built from code-controlled conditions, user values bound via .bind()
      .prepare(`SELECT COUNT(*) as count FROM entities ${where}`)
      .bind(...params)
      .first<{ count: number }>();

    const result = await this.db
      // nosemgrep: semgrep.sql-injection-template-literal — where/orderBy built from code-controlled conditions, user values bound via .bind()
      .prepare(`SELECT * FROM entities ${where} ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...params, options.limit, options.offset)
      .all<EntityRow>();

    return { entities: result.results, total: countRow?.count ?? 0 };
  }

  async getEntityGraph(project?: string): Promise<EntityGraph> {
    let entityResult;
    if (project) {
      entityResult = await this.db
        .prepare("SELECT * FROM entities WHERE project = ? AND (user = ? OR user IS NULL)")
        .bind(project, this.userId)
        .all<EntityRow>();
    } else {
      entityResult = await this.db
        .prepare("SELECT * FROM entities WHERE user = ? OR user IS NULL")
        .bind(this.userId)
        .all<EntityRow>();
    }

    const entityRows = entityResult.results;

    const nodes = entityRows.map((e) => ({
      id: e.id,
      name: e.canonical_name,
      type: e.type,
      mentions: e.mention_count,
    }));

    // Build a set of entity IDs for filtering edges
    const entityIds = new Set(entityRows.map((e) => e.id));

    // Get relations scoped through user-owned entities (avoids loading all relations)
    const relationsResult = entityIds.size > 0
      ? await this.db
          .prepare(`
            SELECT er.* FROM entity_relations er
            JOIN entities e ON e.id = er.source_entity_id
            WHERE (e.user = ? OR e.user IS NULL)
          `)
          .bind(this.userId)
          .all<EntityRelationRow>()
      : { results: [] as EntityRelationRow[] };

    const edges = relationsResult.results
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
      sql = "SELECT type, COUNT(*) as count FROM entities WHERE project = ? AND (user = ? OR user IS NULL) GROUP BY type";
      params = [project, this.userId];
    } else {
      sql = "SELECT type, COUNT(*) as count FROM entities WHERE user = ? OR user IS NULL GROUP BY type";
      params = [this.userId];
    }

    const result = await this.db.prepare(sql).bind(...params).all<{ type: string; count: number }>();

    const out: Record<string, number> = {};
    for (const row of result.results) {
      out[row.type] = row.count;
    }
    return out;
  }
}
