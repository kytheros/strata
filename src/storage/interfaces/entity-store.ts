/**
 * IEntityStore interface: async-first contract for entity graph persistence.
 *
 * Extracted from SqliteEntityStore public methods. All return types are Promise<T>
 * so that both synchronous (SQLite) and asynchronous (D1) adapters can implement them.
 */

import type { KnowledgeEntry } from "../../knowledge/knowledge-store.js";
import type { EntityType } from "../../knowledge/entity-extractor.js";

/** Stored entity row shape. */
export interface EntityRow {
  id: string;
  name: string;
  type: EntityType;
  canonical_name: string;
  aliases: string; // JSON array
  first_seen: number;
  last_seen: number;
  mention_count: number;
  project: string | null;
  user: string | null;
}

/** Input for upserting an entity. */
export interface EntityInput {
  id: string;
  name: string;
  type: EntityType;
  canonicalName: string;
  aliases: string[];
  firstSeen: number;
  lastSeen: number;
  project?: string;
  user?: string;
}

/** Stored entity relation. */
export interface EntityRelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  context: string | null;
  session_id: string | null;
  created_at: number;
}

/** Input for adding a relation. */
export interface RelationInput {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  context?: string;
  sessionId?: string;
}

/** Options for paginated entity listing. */
export interface EntityListOptions {
  type?: string;
  project?: string;
  search?: string;
  sort?: "mentions" | "recent" | "oldest";
  limit: number;
  offset: number;
}

/** Graph data for visualization: nodes + edges. */
export interface EntityGraph {
  nodes: Array<{ id: string; name: string; type: string; mentions: number }>;
  edges: Array<{ source: string; target: string; type: string; context?: string }>;
}

export interface IEntityStore {
  upsertEntity(input: EntityInput): Promise<string>;
  addRelation(input: RelationInput): Promise<void>;
  linkToKnowledge(entryId: string, entityId: string): Promise<void>;
  findByName(name: string): Promise<EntityRow | undefined>;
  findByType(type: EntityType, project?: string): Promise<EntityRow[]>;
  getRelationsFor(entityId: string): Promise<EntityRelationRow[]>;
  getKnowledgeForEntity(entityId: string): Promise<KnowledgeEntry[]>;
  searchEntities(query: string, type?: EntityType, limit?: number): Promise<EntityRow[]>;
  getTopEntities(limit?: number): Promise<EntityRow[]>;
  getById(id: string): Promise<EntityRow | undefined>;
  getEntities(options: EntityListOptions): Promise<{ entities: EntityRow[]; total: number }>;
  getEntityGraph(project?: string): Promise<EntityGraph>;
  getEntityTypeDistribution(project?: string): Promise<Record<string, number>>;
}
