/**
 * SQLite-backed entity store for cross-session entity tracking.
 * Provides CRUD operations for entities, relations, and knowledge-entity links.
 * Follows the same prepared-statement pattern as SqliteKnowledgeStore.
 * Implements IEntityStore for pluggable storage support.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { KnowledgeEntry } from "../knowledge/knowledge-store.js";
import type { EntityType } from "../knowledge/entity-extractor.js";
import type { IEntityStore, EntityListOptions, EntityGraph } from "./interfaces/index.js";

// Re-export types from interfaces for backward compatibility
export type { EntityRow, EntityInput, EntityRelationRow, RelationInput } from "./interfaces/entity-store.js";
import type { EntityRow, EntityInput, EntityRelationRow, RelationInput } from "./interfaces/entity-store.js";

export class SqliteEntityStore implements IEntityStore {
  private stmts: {
    findByCanonical: Database.Statement;
    insert: Database.Statement;
    updateOnDuplicate: Database.Statement;
    findByName: Database.Statement;
    findByType: Database.Statement;
    findByTypeAndProject: Database.Statement;
    insertRelation: Database.Statement;
    hasRelation: Database.Statement;
    getRelationsFor: Database.Statement;
    linkKnowledge: Database.Statement;
    getKnowledgeForEntity: Database.Statement;
    searchEntities: Database.Statement;
    searchEntitiesByType: Database.Statement;
    topEntities: Database.Statement;
    getById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      findByCanonical: db.prepare(
        "SELECT * FROM entities WHERE LOWER(canonical_name) = LOWER(?)"
      ),
      insert: db.prepare(`
        INSERT INTO entities (id, name, type, canonical_name, aliases, first_seen, last_seen, mention_count, project, user)
        VALUES (@id, @name, @type, @canonicalName, @aliases, @firstSeen, @lastSeen, 1, @project, @user)
      `),
      updateOnDuplicate: db.prepare(`
        UPDATE entities
        SET last_seen = @lastSeen,
            mention_count = mention_count + 1,
            aliases = @aliases
        WHERE LOWER(canonical_name) = LOWER(@canonicalName)
      `),
      findByName: db.prepare(
        "SELECT * FROM entities WHERE LOWER(canonical_name) = LOWER(?)"
      ),
      findByType: db.prepare(
        "SELECT * FROM entities WHERE type = ? ORDER BY mention_count DESC"
      ),
      findByTypeAndProject: db.prepare(
        "SELECT * FROM entities WHERE type = ? AND project = ? ORDER BY mention_count DESC"
      ),
      insertRelation: db.prepare(`
        INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, context, session_id, created_at)
        VALUES (@id, @sourceEntityId, @targetEntityId, @relationType, @context, @sessionId, @createdAt)
      `),
      hasRelation: db.prepare(
        "SELECT 1 FROM entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?"
      ),
      getRelationsFor: db.prepare(`
        SELECT * FROM entity_relations
        WHERE source_entity_id = ? OR target_entity_id = ?
        ORDER BY created_at DESC
      `),
      linkKnowledge: db.prepare(`
        INSERT OR IGNORE INTO knowledge_entities (entry_id, entity_id)
        VALUES (?, ?)
      `),
      getKnowledgeForEntity: db.prepare(`
        SELECT k.* FROM knowledge k
        INNER JOIN knowledge_entities ke ON ke.entry_id = k.id
        WHERE ke.entity_id = ?
        ORDER BY k.timestamp DESC
      `),
      searchEntities: db.prepare(`
        SELECT * FROM entities
        WHERE LOWER(canonical_name) LIKE '%' || LOWER(?) || '%'
           OR LOWER(aliases) LIKE '%' || LOWER(?) || '%'
           OR LOWER(name) LIKE '%' || LOWER(?) || '%'
        ORDER BY mention_count DESC
      `),
      searchEntitiesByType: db.prepare(`
        SELECT * FROM entities
        WHERE (LOWER(canonical_name) LIKE '%' || LOWER(?) || '%'
           OR LOWER(aliases) LIKE '%' || LOWER(?) || '%'
           OR LOWER(name) LIKE '%' || LOWER(?) || '%')
          AND type = ?
        ORDER BY mention_count DESC
      `),
      topEntities: db.prepare(
        "SELECT * FROM entities ORDER BY mention_count DESC LIMIT ?"
      ),
      getById: db.prepare("SELECT * FROM entities WHERE id = ?"),
    };
  }

  /**
   * Upsert an entity. If canonical_name already exists (case-insensitive),
   * increments mention_count, updates last_seen, and merges aliases.
   */
  async upsertEntity(input: EntityInput): Promise<string> {
    const existing = this.stmts.findByCanonical.get(
      input.canonicalName
    ) as EntityRow | undefined;

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

      this.stmts.updateOnDuplicate.run({
        lastSeen: Math.max(input.lastSeen, existing.last_seen),
        aliases: JSON.stringify(mergedAliases),
        canonicalName: input.canonicalName,
      });
      return existing.id;
    }

    this.stmts.insert.run({
      id: input.id,
      name: input.name,
      type: input.type,
      canonicalName: input.canonicalName,
      aliases: JSON.stringify(input.aliases.map((a) => a.toLowerCase())),
      firstSeen: input.firstSeen,
      lastSeen: input.lastSeen,
      project: input.project ?? null,
      user: input.user ?? null,
    });
    return input.id;
  }

  /**
   * Add a relation between two entities. Silently ignores duplicates
   * on (source, target, relation_type) triples.
   */
  async addRelation(input: RelationInput): Promise<void> {
    const exists = this.stmts.hasRelation.get(
      input.sourceEntityId,
      input.targetEntityId,
      input.relationType
    );
    if (exists) return;

    this.stmts.insertRelation.run({
      id: randomUUID(),
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      relationType: input.relationType,
      context: input.context ?? null,
      sessionId: input.sessionId ?? null,
      createdAt: Date.now(),
    });
  }

  /**
   * Link a knowledge entry to an entity. Silently ignores duplicate pairs.
   */
  async linkToKnowledge(entryId: string, entityId: string): Promise<void> {
    this.stmts.linkKnowledge.run(entryId, entityId);
  }

  /**
   * Find an entity by canonical name (case-insensitive).
   */
  async findByName(name: string): Promise<EntityRow | undefined> {
    return this.stmts.findByName.get(name) as EntityRow | undefined;
  }

  /**
   * Find entities by type, optionally scoped to a project.
   */
  async findByType(type: EntityType, project?: string): Promise<EntityRow[]> {
    if (project) {
      return this.stmts.findByTypeAndProject.all(type, project) as EntityRow[];
    }
    return this.stmts.findByType.all(type) as EntityRow[];
  }

  /**
   * Get all relations where the entity is source or target.
   */
  async getRelationsFor(entityId: string): Promise<EntityRelationRow[]> {
    return this.stmts.getRelationsFor.all(
      entityId,
      entityId
    ) as EntityRelationRow[];
  }

  /**
   * Get knowledge entries linked to an entity.
   */
  async getKnowledgeForEntity(entityId: string): Promise<KnowledgeEntry[]> {
    const rows = this.stmts.getKnowledgeForEntity.all(entityId) as Array<{
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
    }>;
    return rows.map((row) => ({
      id: row.id,
      type: row.type as KnowledgeEntry["type"],
      project: row.project,
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

  /**
   * Search entities by query string (matches canonical_name, aliases, or name).
   * Optionally filtered by entity type.
   */
  async searchEntities(
    query: string,
    type?: EntityType,
    limit?: number
  ): Promise<EntityRow[]> {
    const effectiveLimit = Math.max(1, Math.min(limit ?? 20, 100));
    let results: EntityRow[];
    if (type) {
      results = this.stmts.searchEntitiesByType.all(
        query, query, query, type
      ) as EntityRow[];
    } else {
      results = this.stmts.searchEntities.all(query, query, query) as EntityRow[];
    }
    return results.slice(0, effectiveLimit);
  }

  /**
   * Get the top N entities by mention count.
   */
  async getTopEntities(limit: number = 20): Promise<EntityRow[]> {
    return this.stmts.topEntities.all(limit) as EntityRow[];
  }

  /**
   * Get an entity by its ID.
   */
  async getById(id: string): Promise<EntityRow | undefined> {
    return this.stmts.getById.get(id) as EntityRow | undefined;
  }

  /**
   * Paginated entity listing with filters.
   */
  async getEntities(options: EntityListOptions): Promise<{ entities: EntityRow[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.type) {
      conditions.push("type = ?");
      params.push(options.type);
    }

    if (options.project) {
      conditions.push("project = ?");
      params.push(options.project);
    }

    if (options.search) {
      conditions.push(
        "(LOWER(canonical_name) LIKE '%' || LOWER(?) || '%' OR LOWER(aliases) LIKE '%' || LOWER(?) || '%')"
      );
      params.push(options.search, options.search);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM entities ${where}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT * FROM entities ${where} ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, options.limit, options.offset) as EntityRow[];

    return { entities: rows, total: countRow.count };
  }

  /**
   * Graph data for visualization: nodes + edges.
   */
  async getEntityGraph(project?: string): Promise<EntityGraph> {
    let entityRows: EntityRow[];
    if (project) {
      entityRows = this.db
        .prepare("SELECT * FROM entities WHERE project = ?")
        .all(project) as EntityRow[];
    } else {
      entityRows = this.db
        .prepare("SELECT * FROM entities")
        .all() as EntityRow[];
    }

    const nodes = entityRows.map((e) => ({
      id: e.id,
      name: e.canonical_name,
      type: e.type,
      mentions: e.mention_count,
    }));

    // Build a set of entity IDs for filtering edges
    const entityIds = new Set(entityRows.map((e) => e.id));

    // Get all relations, then filter to only include edges where both endpoints are in our node set
    const allRelations = this.db
      .prepare("SELECT * FROM entity_relations")
      .all() as EntityRelationRow[];

    const edges = allRelations
      .filter((r) => entityIds.has(r.source_entity_id) && entityIds.has(r.target_entity_id))
      .map((r) => ({
        source: r.source_entity_id,
        target: r.target_entity_id,
        type: r.relation_type,
        context: r.context ?? undefined,
      }));

    return { nodes, edges };
  }

  /**
   * Entity type distribution counts.
   */
  async getEntityTypeDistribution(project?: string): Promise<Record<string, number>> {
    let rows: Array<{ type: string; count: number }>;

    if (project) {
      rows = this.db
        .prepare("SELECT type, COUNT(*) as count FROM entities WHERE project = ? GROUP BY type")
        .all(project) as Array<{ type: string; count: number }>;
    } else {
      rows = this.db
        .prepare("SELECT type, COUNT(*) as count FROM entities GROUP BY type")
        .all() as Array<{ type: string; count: number }>;
    }

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }
}
