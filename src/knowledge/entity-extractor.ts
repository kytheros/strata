/**
 * Heuristic entity extraction from text.
 * Identifies libraries, services, tools, languages, frameworks, people, concepts, and files
 * using regex patterns and a built-in alias map.
 */

import { randomUUID } from "crypto";

/** Entity types recognized by the extractor. */
export type EntityType =
  | "library"
  | "service"
  | "tool"
  | "language"
  | "framework"
  | "person"
  | "concept"
  | "file";

/** An entity extracted from text. */
export interface ExtractedEntity {
  name: string;
  type: EntityType;
  canonicalName: string;
}

/** A relationship between two entities. */
export interface ExtractedRelation {
  sourceCanonical: string;
  targetCanonical: string;
  relationType: "replaced_by" | "used_for" | "depends_on" | "co_occurs";
  context: string;
}

/**
 * Canonical name → known aliases.
 * Aliases are checked case-insensitively as whole words.
 */
export const ALIAS_MAP: Record<string, string[]> = {
  postgresql: ["postgres", "pg", "postgresql"],
  javascript: ["js", "javascript"],
  typescript: ["ts", "typescript"],
  nodejs: ["node", "nodejs", "node.js"],
  react: ["react", "reactjs", "react.js"],
  python: ["py", "python", "python3"],
  kubernetes: ["k8s", "kubernetes"],
  docker: ["docker", "dockerfile"],
  mongodb: ["mongo", "mongodb"],
  redis: ["redis"],
  mysql: ["mysql"],
  sqlite: ["sqlite", "sqlite3", "better-sqlite3"],
  vue: ["vue", "vuejs", "vue.js"],
  angular: ["angular", "angularjs"],
  svelte: ["svelte", "sveltekit"],
  nextjs: ["next", "nextjs", "next.js"],
  express: ["express", "expressjs"],
  fastify: ["fastify"],
  django: ["django"],
  flask: ["flask"],
  rust: ["rust"],
  golang: ["go", "golang"],
  java: ["java"],
  csharp: ["c#", "csharp", "dotnet", ".net"],
  ruby: ["ruby"],
  php: ["php"],
  swift: ["swift"],
  vitest: ["vitest"],
  jest: ["jest"],
  mocha: ["mocha"],
  webpack: ["webpack"],
  vite: ["vite"],
  eslint: ["eslint"],
  prettier: ["prettier"],
  git: ["git"],
  github: ["github"],
  gitlab: ["gitlab"],
  nginx: ["nginx"],
  apache: ["apache"],
  aws: ["aws", "amazon web services"],
  gcp: ["gcp", "google cloud"],
  azure: ["azure"],
  graphql: ["graphql"],
  grpc: ["grpc"],
  rabbitmq: ["rabbitmq"],
  kafka: ["kafka"],
  elasticsearch: ["elasticsearch", "elastic"],
  supabase: ["supabase"],
  firebase: ["firebase"],
  prisma: ["prisma"],
  drizzle: ["drizzle"],
  tailwind: ["tailwind", "tailwindcss"],
  sass: ["sass", "scss"],
  npm: ["npm"],
  yarn: ["yarn"],
  pnpm: ["pnpm"],
  bun: ["bun"],
};

/** Reverse lookup: alias → canonical name. Built once at module load. */
const ALIAS_REVERSE = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(ALIAS_MAP)) {
  for (const alias of aliases) {
    ALIAS_REVERSE.set(alias.toLowerCase(), canonical);
  }
}

/** Entity type classification for known canonical names. */
const TYPE_MAP: Record<string, EntityType> = {
  // Languages
  javascript: "language",
  typescript: "language",
  python: "language",
  rust: "language",
  golang: "language",
  java: "language",
  csharp: "language",
  ruby: "language",
  php: "language",
  swift: "language",
  // Frameworks
  react: "framework",
  vue: "framework",
  angular: "framework",
  svelte: "framework",
  nextjs: "framework",
  express: "framework",
  fastify: "framework",
  django: "framework",
  flask: "framework",
  tailwind: "framework",
  // Services / databases
  postgresql: "service",
  mongodb: "service",
  redis: "service",
  mysql: "service",
  sqlite: "service",
  nginx: "service",
  apache: "service",
  elasticsearch: "service",
  rabbitmq: "service",
  kafka: "service",
  supabase: "service",
  firebase: "service",
  aws: "service",
  gcp: "service",
  azure: "service",
  github: "service",
  gitlab: "service",
  // Tools
  docker: "tool",
  kubernetes: "tool",
  git: "tool",
  webpack: "tool",
  vite: "tool",
  eslint: "tool",
  prettier: "tool",
  npm: "tool",
  yarn: "tool",
  pnpm: "tool",
  bun: "tool",
  // Libraries
  vitest: "library",
  jest: "library",
  mocha: "library",
  prisma: "library",
  drizzle: "library",
  sass: "library",
  graphql: "library",
  grpc: "library",
};

/** Words that should never be emitted as entities. */
const SUPPRESSION_LIST = new Set([
  "it", "is", "use", "the", "a", "an", "and", "or", "but", "for", "in",
  "on", "at", "to", "of", "with", "from", "by", "as", "do", "did",
  "has", "had", "have", "not", "all", "are", "was", "were", "be",
  "been", "this", "that", "can", "will", "would", "should", "could",
  "just", "then", "than", "also", "so", "if", "up", "out", "about",
  "set", "get", "let", "new", "old", "run", "fix", "add", "put",
  "end", "try", "way", "may", "say", "see",
]);

/** npm scoped package pattern: @scope/name or regular-package-name */
const NPM_PATTERN = /(?:@[\w.-]+\/[\w.-]+|(?<![/\\])[\w][\w.-]*-[\w][\w.-]*)/g;

/** Unix file paths with segments >= 3 chars each */
const FILE_PATTERN = /(?:\/[\w.-]{3,}){2,}/g;

/** URL pattern */
const URL_PATTERN = /https?:\/\/[^\s)]+/g;

/**
 * Extract entities from text using heuristic patterns and the alias map.
 * Synchronous, no I/O, designed to complete in < 5ms for 2000 chars.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  if (!text || !text.trim()) return [];

  const found = new Map<string, ExtractedEntity>();

  // 1. Check alias map matches (whole-word, case-insensitive)
  const textLower = text.toLowerCase();
  for (const [canonical, aliases] of Object.entries(ALIAS_MAP)) {
    for (const alias of aliases) {
      const aliasLower = alias.toLowerCase();
      // Build word-boundary pattern — handle special chars in alias
      const escaped = aliasLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      if (re.test(text)) {
        if (!found.has(canonical)) {
          found.set(canonical, {
            name: alias,
            type: TYPE_MAP[canonical] || "library",
            canonicalName: canonical,
          });
        }
        break; // first alias match is enough
      }
    }
  }

  // 2. npm packages not in alias map
  const npmMatches = text.match(NPM_PATTERN);
  if (npmMatches) {
    for (const match of npmMatches) {
      // Skip if it's already covered by alias map
      const lower = match.toLowerCase();
      if (SUPPRESSION_LIST.has(lower)) continue;
      if (ALIAS_REVERSE.has(lower)) continue;
      // Must contain a hyphen or be scoped to qualify as npm package
      if (!match.startsWith("@") && !match.includes("-")) continue;
      const canonical = lower;
      if (!found.has(canonical)) {
        found.set(canonical, {
          name: match,
          type: "library",
          canonicalName: canonical,
        });
      }
    }
  }

  // 3. File paths
  const fileMatches = text.match(FILE_PATTERN);
  if (fileMatches) {
    for (const match of fileMatches) {
      const canonical = match;
      if (!found.has(canonical)) {
        found.set(canonical, {
          name: match,
          type: "file",
          canonicalName: canonical,
        });
      }
    }
  }

  // 4. URLs
  const urlMatches = text.match(URL_PATTERN);
  if (urlMatches) {
    for (const match of urlMatches) {
      const canonical = match;
      if (!found.has(canonical)) {
        found.set(canonical, {
          name: match,
          type: "service",
          canonicalName: canonical,
        });
      }
    }
  }

  return [...found.values()];
}

/** Relation-indicating patterns. Each produces a (source, target, type) triple. */
const REPLACED_BY_PATTERNS = [
  /switched\s+from\s+(\S+)\s+to\s+(\S+)/gi,
  /migrated\s+from\s+(\S+)\s+to\s+(\S+)/gi,
  /moved\s+from\s+(\S+)\s+to\s+(\S+)/gi,
  /replaced\s+(\S+)\s+with\s+(\S+)/gi,
];

const USED_FOR_PATTERNS = [
  /using\s+(\S+)\s+for\s+(\S+)/gi,
  /(\S+)\s+for\s+(caching|storage|auth|testing|deployment|logging|monitoring)/gi,
  /(\S+)\s+as\s+a\s+(\S+)/gi,
];

const DEPENDS_ON_PATTERNS = [
  /(\S+)\s+depends\s+on\s+(\S+)/gi,
  /(\S+)\s+requires\s+(\S+)/gi,
  /(\S+)\s+uses\s+(\S+)/gi,
];

/**
 * Resolve a raw name to its canonical form using the alias map.
 */
function resolveCanonical(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (SUPPRESSION_LIST.has(lower)) return undefined;
  return ALIAS_REVERSE.get(lower) || undefined;
}

/**
 * Extract relationships between entities found in the same text.
 * Returns directional relations for known patterns, plus co_occurs for
 * any two entities that appear together without a directional pattern.
 */
export function extractRelations(
  text: string,
  entities: ExtractedEntity[]
): ExtractedRelation[] {
  if (entities.length < 2) return [];

  const relations: ExtractedRelation[] = [];
  const seen = new Set<string>();

  function addRelation(
    source: string,
    target: string,
    type: ExtractedRelation["relationType"],
    context: string
  ): void {
    const key = `${source}|${target}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push({
      sourceCanonical: source,
      targetCanonical: target,
      relationType: type,
      context: context.slice(0, 200),
    });
  }

  const entitySet = new Set(entities.map((e) => e.canonicalName));

  // Check replaced_by patterns
  for (const pattern of REPLACED_BY_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const src = resolveCanonical(match[1]);
      const tgt = resolveCanonical(match[2]);
      if (src && tgt && entitySet.has(src) && entitySet.has(tgt)) {
        addRelation(src, tgt, "replaced_by", match[0]);
      }
    }
  }

  // Check used_for patterns
  for (const pattern of USED_FOR_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const src = resolveCanonical(match[1]);
      const tgt = resolveCanonical(match[2]);
      if (src && tgt && entitySet.has(src) && entitySet.has(tgt)) {
        addRelation(src, tgt, "used_for", match[0]);
      }
    }
  }

  // Check depends_on patterns
  for (const pattern of DEPENDS_ON_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const src = resolveCanonical(match[1]);
      const tgt = resolveCanonical(match[2]);
      if (src && tgt && entitySet.has(src) && entitySet.has(tgt)) {
        addRelation(src, tgt, "depends_on", match[0]);
      }
    }
  }

  // co_occurs for any pair without a directional relation
  const directedPairs = new Set<string>();
  for (const r of relations) {
    directedPairs.add(`${r.sourceCanonical}|${r.targetCanonical}`);
    directedPairs.add(`${r.targetCanonical}|${r.sourceCanonical}`);
  }

  const entityList = entities.map((e) => e.canonicalName);
  for (let i = 0; i < entityList.length; i++) {
    for (let j = i + 1; j < entityList.length; j++) {
      const a = entityList[i];
      const b = entityList[j];
      if (a === b) continue;
      const pairKey = `${a}|${b}`;
      if (!directedPairs.has(pairKey)) {
        addRelation(a, b, "co_occurs", text.slice(0, 200));
      }
    }
  }

  return relations;
}
