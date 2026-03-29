/**
 * Profile synthesizer: structural reasoning layer.
 *
 * Computes typed claims about the user from existing data stores
 * (knowledge entries, entity graph, session summaries, evidence gaps)
 * using pure SQL aggregations and threshold rules. Zero LLM calls.
 *
 * Every claim includes evidence metadata so it can be audited and verified.
 */

import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import type { IEntityStore, EntityRow, EntityRelationRow } from "../storage/interfaces/entity-store.js";
import type { ISummaryStore } from "../storage/interfaces/summary-store.js";
import type { KnowledgeEntry } from "./knowledge-store.js";
import { jaccardSimilarity, stemmedWords } from "./learning-synthesizer.js";
import { CONFIG } from "../config.js";
import type Database from "better-sqlite3";
import { listGaps, type EvidenceGap } from "../search/evidence-gaps.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaimCategory =
  | "expertise"
  | "preference"
  | "workflow"
  | "stack"
  | "evolution"
  | "gap"
  | "contradiction";

export interface ProfileClaim {
  category: ClaimCategory;
  claim: string;
  confidence: number;
  evidence: Record<string, unknown>;
}

export interface UserProfile {
  expertise: ProfileClaim[];
  preferences: ProfileClaim[];
  workflow: ProfileClaim[];
  stack: ProfileClaim[];
  evolution: ProfileClaim[];
  gaps: ProfileClaim[];
  contradictions: ProfileClaim[];
  metadata: {
    totalEntries: number;
    totalSessions: number;
    totalEntities: number;
    computedAt: string;
  };
}

export interface ProfileSynthesizerStores {
  knowledge: IKnowledgeStore;
  entities: IEntityStore;
  summaries: ISummaryStore;
  gapDb?: Database.Database;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function synthesizeProfile(
  stores: ProfileSynthesizerStores,
  options?: { project?: string; user?: string },
): Promise<UserProfile> {
  const { knowledge, entities, summaries, gapDb } = stores;
  const project = options?.project;
  const user = options?.user;

  // Gather base data in parallel
  const [allEntries, topEntities, sessionCount, typeDist] = await Promise.all([
    knowledge.getAllEntries(user),
    entities.getTopEntities(50),
    summaries.getCount(),
    entities.getEntityTypeDistribution(project),
  ]);

  const projectEntries = project
    ? allEntries.filter((e) => e.project.toLowerCase().includes(project.toLowerCase()))
    : allEntries;

  const totalEntities = Object.values(typeDist).reduce((a, b) => a + b, 0);

  // Run all synthesizers in parallel
  const [expertise, preferences, workflow, stack, evolution, gaps, contradictions] =
    await Promise.all([
      synthesizeExpertise(topEntities, entities, project),
      synthesizePreferences(projectEntries),
      synthesizeWorkflow(summaries, project),
      synthesizeStack(topEntities, entities),
      synthesizeEvolution(entities),
      synthesizeGaps(gapDb, topEntities, project, user),
      synthesizeContradictions(projectEntries),
    ]);

  return {
    expertise,
    preferences,
    workflow,
    stack,
    evolution,
    gaps,
    contradictions,
    metadata: {
      totalEntries: projectEntries.length,
      totalSessions: sessionCount,
      totalEntities,
      computedAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Claim generators
// ---------------------------------------------------------------------------

async function synthesizeExpertise(
  topEntities: EntityRow[],
  entityStore: IEntityStore,
  project?: string,
): Promise<ProfileClaim[]> {
  const cfg = CONFIG.profile;
  const claims: ProfileClaim[] = [];

  for (const entity of topEntities) {
    if (claims.length >= cfg.maxClaimsPerCategory) break;
    if (entity.mention_count < cfg.expertiseMinMentions) continue;

    const tenureDays = (entity.last_seen - entity.first_seen) / 86400000;
    if (tenureDays < cfg.expertiseMinTenureDays) continue;

    // Get related entities for context
    const relations = await entityStore.getRelationsFor(entity.id);
    const coOccurring = relations
      .filter((r) => r.relation_type === "co_occurs")
      .length;

    // Confidence: weighted composite of mentions, tenure, and relations
    const mentionScore = Math.min(entity.mention_count / 100, 1.0);
    const tenureScore = Math.min(tenureDays / 365, 1.0);
    const relationScore = Math.min(coOccurring / 10, 1.0);
    const confidence = mentionScore * 0.4 + tenureScore * 0.35 + relationScore * 0.25;

    claims.push({
      category: "expertise",
      claim: `${entity.canonical_name} expertise (${entity.mention_count} mentions over ${Math.round(tenureDays)} days)`,
      confidence: Math.round(confidence * 100) / 100,
      evidence: {
        entity: entity.canonical_name,
        type: entity.type,
        mentions: entity.mention_count,
        tenureDays: Math.round(tenureDays),
        coOccurringEntities: coOccurring,
        firstSeen: new Date(entity.first_seen).toISOString().split("T")[0],
        lastSeen: new Date(entity.last_seen).toISOString().split("T")[0],
      },
    });
  }

  return claims;
}

async function synthesizePreferences(
  entries: KnowledgeEntry[],
): Promise<ProfileClaim[]> {
  const cfg = CONFIG.profile;
  const claims: ProfileClaim[] = [];

  const preferenceEntries = entries.filter((e) => e.type === "preference");
  if (preferenceEntries.length === 0) return claims;

  // Group by primary tag
  const tagGroups = new Map<string, KnowledgeEntry[]>();
  for (const entry of preferenceEntries) {
    const primaryTag = entry.tags[0];
    if (!primaryTag) continue;
    const group = tagGroups.get(primaryTag) ?? [];
    group.push(entry);
    tagGroups.set(primaryTag, group);
  }

  for (const [tag, group] of tagGroups) {
    if (claims.length >= cfg.maxClaimsPerCategory) break;
    if (group.length < cfg.preferenceMinEntries) continue;

    // Pick the most recent entry's summary as the representative preference
    const sorted = [...group].sort((a, b) => b.timestamp - a.timestamp);
    const representative = sorted[0].summary;
    const confidence = Math.min(group.length / 10, 1.0);

    claims.push({
      category: "preference",
      claim: representative,
      confidence: Math.round(confidence * 100) / 100,
      evidence: {
        tag,
        entryCount: group.length,
        entryIds: group.map((e) => e.id).slice(0, 5),
        mostRecent: new Date(sorted[0].timestamp).toISOString().split("T")[0],
      },
    });
  }

  return claims;
}

async function synthesizeWorkflow(
  summaries: ISummaryStore,
  project?: string,
): Promise<ProfileClaim[]> {
  const claims: ProfileClaim[] = [];

  // Activity patterns from heatmap
  const heatmap = await summaries.getSessionHeatmap(Date.now() - 90 * 86400000);
  if (heatmap.length === 0) return claims;

  // Sessions per day distribution
  const dailyCounts = heatmap.map((h) => h.count);
  const avgSessionsPerDay =
    dailyCounts.reduce((a, b) => a + b, 0) / Math.max(dailyCounts.length, 1);
  const activeDays = dailyCounts.filter((c) => c > 0).length;

  if (activeDays >= 5) {
    claims.push({
      category: "workflow",
      claim: `Active ${activeDays} days in the last 90 days (avg ${avgSessionsPerDay.toFixed(1)} sessions/day)`,
      confidence: Math.min(activeDays / 60, 1.0),
      evidence: {
        activeDays,
        avgSessionsPerDay: Math.round(avgSessionsPerDay * 10) / 10,
        periodDays: 90,
      },
    });
  }

  // Project concurrency
  const projectCounts = await summaries.getProjectSessionCounts();
  const activeProjects = Object.keys(projectCounts).length;
  if (activeProjects >= 2) {
    const topProjects = Object.entries(projectCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    claims.push({
      category: "workflow",
      claim: `Works across ${activeProjects} projects`,
      confidence: Math.min(activeProjects / 8, 1.0),
      evidence: {
        activeProjects,
        topProjects: Object.fromEntries(topProjects),
      },
    });
  }

  return claims;
}

async function synthesizeStack(
  topEntities: EntityRow[],
  entityStore: IEntityStore,
): Promise<ProfileClaim[]> {
  const cfg = CONFIG.profile;
  const claims: ProfileClaim[] = [];

  // Build co-occurrence matrix for top entities
  const entityNames = topEntities.slice(0, 20).map((e) => e.canonical_name);
  const pairs: Array<{ a: string; b: string; count: number; total: number }> = [];

  for (const entity of topEntities.slice(0, 20)) {
    const relations = await entityStore.getRelationsFor(entity.id);
    const coOccurs = relations.filter((r) => r.relation_type === "co_occurs");

    for (const rel of coOccurs) {
      // Find the other entity
      const otherId =
        rel.source_entity_id === entity.id
          ? rel.target_entity_id
          : rel.source_entity_id;

      const other = topEntities.find((e) => e.id === otherId);
      if (!other) continue;

      // Avoid duplicate pairs
      const [a, b] =
        entity.canonical_name < other.canonical_name
          ? [entity.canonical_name, other.canonical_name]
          : [other.canonical_name, entity.canonical_name];

      if (!pairs.find((p) => p.a === a && p.b === b)) {
        // Co-occurrence score: relation count / min(mentions_a, mentions_b)
        const sameRelations = coOccurs.filter(
          (r) => r.source_entity_id === otherId || r.target_entity_id === otherId,
        ).length;
        const minMentions = Math.min(entity.mention_count, other.mention_count);
        const score = minMentions > 0 ? sameRelations / minMentions : 0;

        pairs.push({ a, b, count: sameRelations, total: minMentions });
      }
    }
  }

  // Group strongly co-occurring entities into stacks
  const strongPairs = pairs.filter(
    (p) => p.count >= 2 && p.total >= cfg.expertiseMinMentions,
  );

  if (strongPairs.length > 0) {
    // Build a simple stack from the most connected entities
    const entityFreq = new Map<string, number>();
    for (const p of strongPairs) {
      entityFreq.set(p.a, (entityFreq.get(p.a) ?? 0) + p.count);
      entityFreq.set(p.b, (entityFreq.get(p.b) ?? 0) + p.count);
    }

    const stackMembers = [...entityFreq.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 6)
      .map(([name]) => name);

    if (stackMembers.length >= 2) {
      claims.push({
        category: "stack",
        claim: `Primary stack: ${stackMembers.join(", ")}`,
        confidence: Math.min(strongPairs.length / 10, 1.0),
        evidence: {
          technologies: stackMembers,
          coOccurrencePairs: strongPairs.slice(0, 10).map((p) => ({
            a: p.a,
            b: p.b,
            relationCount: p.count,
          })),
        },
      });
    }
  }

  return claims;
}

async function synthesizeEvolution(
  entityStore: IEntityStore,
): Promise<ProfileClaim[]> {
  const cfg = CONFIG.profile;
  const claims: ProfileClaim[] = [];

  // Find replacement chains
  const topEntities = await entityStore.getTopEntities(100);

  for (const entity of topEntities) {
    if (claims.length >= cfg.maxClaimsPerCategory) break;

    const relations = await entityStore.getRelationsFor(entity.id);
    const replacements = relations.filter(
      (r) => r.relation_type === "replaced_by" && r.source_entity_id === entity.id,
    );

    for (const rel of replacements) {
      const target = topEntities.find((e) => e.id === rel.target_entity_id);
      if (!target) continue;

      claims.push({
        category: "evolution",
        claim: `Migrated from ${entity.canonical_name} to ${target.canonical_name}`,
        confidence: 0.85,
        evidence: {
          from: entity.canonical_name,
          to: target.canonical_name,
          detectedAt: new Date(rel.created_at).toISOString().split("T")[0],
          context: rel.context,
        },
      });
    }
  }

  return claims;
}

async function synthesizeGaps(
  gapDb: Database.Database | undefined,
  topEntities: EntityRow[],
  project?: string,
  user?: string,
): Promise<ProfileClaim[]> {
  if (!gapDb) return [];

  const cfg = CONFIG.profile;
  const claims: ProfileClaim[] = [];

  const gaps = listGaps(gapDb, {
    project,
    user,
    status: "open",
    minOccurrences: cfg.gapMinOccurrences,
    limit: cfg.maxClaimsPerCategory,
  });

  for (const gap of gaps) {
    const confidence = Math.min(gap.occurrenceCount / 10, 0.9);

    // Check if the gap topic is adjacent to a known expertise
    const adjacentExpertise = findAdjacentExpertise(gap.query, topEntities);

    claims.push({
      category: "gap",
      claim: `Knowledge gap: "${gap.query}" (searched ${gap.occurrenceCount} times, no results)`,
      confidence: Math.round(confidence * 100) / 100,
      evidence: {
        query: gap.query,
        occurrences: gap.occurrenceCount,
        firstSeen: new Date(gap.occurredAt).toISOString().split("T")[0],
        adjacentExpertise,
      },
    });
  }

  return claims;
}

function findAdjacentExpertise(
  query: string,
  topEntities: EntityRow[],
): string | null {
  const queryWords = stemmedWords(query);
  let bestMatch: string | null = null;
  let bestSim = 0;

  for (const entity of topEntities.slice(0, 20)) {
    const entityWords = stemmedWords(entity.canonical_name);
    const sim = jaccardSimilarity(queryWords, entityWords);
    if (sim > bestSim && sim > 0.2) {
      bestSim = sim;
      bestMatch = entity.canonical_name;
    }
  }

  return bestMatch;
}

async function synthesizeContradictions(
  entries: KnowledgeEntry[],
): Promise<ProfileClaim[]> {
  const cfg = CONFIG.profile;
  const claims: ProfileClaim[] = [];

  // Compare within decision and preference types
  const candidates = entries.filter(
    (e) => e.type === "decision" || e.type === "preference",
  );

  if (candidates.length < 2 || candidates.length > 500) return claims;

  // Negation patterns that indicate opposing positions
  const negationPairs = [
    [/\buse\b/i, /\bavoid\b/i],
    [/\bprefer\b/i, /\bstopped?\s+using\b/i],
    [/\bswitched?\s+to\b/i, /\bswitched?\s+from\b/i],
    [/\balways\b/i, /\bnever\b/i],
    [/\benable\b/i, /\bdisable\b/i],
    [/\badd\b/i, /\bremove\b/i],
  ];

  for (let i = 0; i < candidates.length && claims.length < cfg.maxClaimsPerCategory; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      // Must share at least one tag
      const sharedTags = a.tags.filter((t) => b.tags.includes(t));
      if (sharedTags.length === 0) continue;

      // Check text similarity
      const sim = jaccardSimilarity(stemmedWords(a.summary), stemmedWords(b.summary));
      if (sim < cfg.contradictionMinSimilarity) continue;

      // Check for opposing sentiment
      const hasNegation = negationPairs.some(
        ([pos, neg]) =>
          (pos.test(a.summary) && neg.test(b.summary)) ||
          (neg.test(a.summary) && pos.test(b.summary)),
      );

      if (!hasNegation) continue;

      // The newer entry is likely the current position
      const [older, newer] = a.timestamp < b.timestamp ? [a, b] : [b, a];

      claims.push({
        category: "contradiction",
        claim: `Potential contradiction: "${older.summary}" vs "${newer.summary}"`,
        confidence: Math.round(sim * 100) / 100,
        evidence: {
          olderEntry: { id: older.id, summary: older.summary, date: new Date(older.timestamp).toISOString().split("T")[0] },
          newerEntry: { id: newer.id, summary: newer.summary, date: new Date(newer.timestamp).toISOString().split("T")[0] },
          sharedTags,
          similarity: Math.round(sim * 100) / 100,
          resolution: `Newer entry (${new Date(newer.timestamp).toISOString().split("T")[0]}) may supersede older`,
        },
      });
      break; // Only one contradiction per entry
    }
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a UserProfile as readable markdown text for MCP tool output.
 */
export function formatProfile(profile: UserProfile): string {
  const lines: string[] = [];

  lines.push("## User Profile");
  lines.push("");
  lines.push(
    `*${profile.metadata.totalEntries} knowledge entries across ${profile.metadata.totalSessions} sessions, ${profile.metadata.totalEntities} entities*`,
  );

  if (profile.expertise.length > 0) {
    lines.push("");
    lines.push("### Expertise");
    for (const c of profile.expertise) {
      const ev = c.evidence as Record<string, unknown>;
      lines.push(
        `- **${ev.entity}** (${ev.type}): ${ev.mentions} mentions over ${ev.tenureDays} days [confidence: ${c.confidence}]`,
      );
    }
  }

  if (profile.preferences.length > 0) {
    lines.push("");
    lines.push("### Preferences");
    for (const c of profile.preferences) {
      const ev = c.evidence as Record<string, unknown>;
      lines.push(
        `- ${c.claim} (${ev.entryCount} entries, tag: ${ev.tag}) [confidence: ${c.confidence}]`,
      );
    }
  }

  if (profile.stack.length > 0) {
    lines.push("");
    lines.push("### Technology Stack");
    for (const c of profile.stack) {
      lines.push(`- ${c.claim} [confidence: ${c.confidence}]`);
    }
  }

  if (profile.workflow.length > 0) {
    lines.push("");
    lines.push("### Workflow");
    for (const c of profile.workflow) {
      lines.push(`- ${c.claim} [confidence: ${c.confidence}]`);
    }
  }

  if (profile.evolution.length > 0) {
    lines.push("");
    lines.push("### Technology Evolution");
    for (const c of profile.evolution) {
      const ev = c.evidence as Record<string, unknown>;
      lines.push(`- ${c.claim} (${ev.detectedAt}) [confidence: ${c.confidence}]`);
    }
  }

  if (profile.gaps.length > 0) {
    lines.push("");
    lines.push("### Knowledge Gaps");
    for (const c of profile.gaps) {
      const ev = c.evidence as Record<string, unknown>;
      const adj = ev.adjacentExpertise
        ? ` (adjacent to ${ev.adjacentExpertise} expertise)`
        : "";
      lines.push(`- ${ev.query}: searched ${ev.occurrences} times${adj} [confidence: ${c.confidence}]`);
    }
  }

  if (profile.contradictions.length > 0) {
    lines.push("");
    lines.push("### Potential Contradictions");
    for (const c of profile.contradictions) {
      const ev = c.evidence as Record<string, unknown>;
      const older = ev.olderEntry as Record<string, unknown>;
      const newer = ev.newerEntry as Record<string, unknown>;
      lines.push(`- **${older.date}**: "${older.summary}"`);
      lines.push(`  **${newer.date}**: "${newer.summary}"`);
      lines.push(`  *${ev.resolution}*`);
    }
  }

  if (
    profile.expertise.length === 0 &&
    profile.preferences.length === 0 &&
    profile.stack.length === 0 &&
    profile.workflow.length === 0
  ) {
    lines.push("");
    lines.push(
      "*Not enough data to generate profile claims. Use Strata across more sessions to build up knowledge.*",
    );
  }

  return lines.join("\n");
}

/**
 * Format a compact summary of top claims for injection into get_project_context.
 * Returns only expertise + preferences (most useful for session-start context).
 */
export function formatProfileCompact(profile: UserProfile): string {
  const lines: string[] = [];
  const topExpertise = profile.expertise.slice(0, 3);
  const topPrefs = profile.preferences.slice(0, 3);

  if (topExpertise.length === 0 && topPrefs.length === 0) return "";

  lines.push("### User Profile");

  if (topExpertise.length > 0) {
    const names = topExpertise.map((c) => {
      const ev = c.evidence as Record<string, unknown>;
      return `${ev.entity} (${ev.mentions} mentions)`;
    });
    lines.push(`**Expertise**: ${names.join(", ")}`);
  }

  if (topPrefs.length > 0) {
    for (const c of topPrefs) {
      lines.push(`**Preference**: ${c.claim}`);
    }
  }

  if (profile.contradictions.length > 0) {
    lines.push(
      `**Note**: ${profile.contradictions.length} potential contradiction(s) detected — run get_user_profile for details`,
    );
  }

  return lines.join("\n");
}
