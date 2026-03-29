/**
 * Extract knowledge entries (decisions, solutions, error fixes, patterns)
 * from parsed session data using heuristic pattern matching.
 */

import { randomUUID } from "crypto";
import type { ParsedSession } from "../parsers/session-parser.js";
import type { KnowledgeEntry } from "./knowledge-store.js";
import { KnowledgeEvaluator } from "./knowledge-evaluator.js";
import { checkDuplicate } from "./dedup.js";

const DECISION_PATTERNS = [
  /(?:decided to|going with|chose|choosing|we'll use|let's use|switched to|opting for)\s+(.{10,120})/i,
  /(?:decision|approach):\s*(.{10,120})/i,
  /(?:instead of .{5,50}, (?:we|i|let's))\s+(.{10,80})/i,
];

// Personal knowledge patterns — orthogonal to coding patterns.
// Only matched on user messages to capture what the USER said about themselves.

const FACT_PATTERNS = [
  // Possession: "I have a dog", "I got a new bike"
  /(?:I (?:have|own|got)\s+(?:a |an |the |my |two |three |four |five |some |\d+ ))(.{5,120})/i,
  // Identity: "I'm a teacher", "I am an engineer"
  /(?:I(?:'m| am)\s+(?:a |an ))(.{5,80})/i,
  // Personal context: "my dog Max", "my wife", "my apartment"
  /(?:my (?:name|job|work|dog|cat|pet|car|house|apartment|wife|husband|partner|daughter|son|brother|sister|friend|mom|dad|family|plant|garden|bike|boat|truck))\s+(.{3,100})/i,
  // Location/background: "I live in", "I work at"
  /(?:I (?:live|work|grew up|was born)\s+(?:in|at|near)\s+)(.{3,80})/i,
  // Education/skills
  /(?:I (?:speak|know|study|studied|majored in|graduated)\s+)(.{3,80})/i,
  // Acquisition from source: "I got from the nursery", "I got from my sister"
  /(?:(?:I |which I |that I )(?:got|received|bought|picked up|borrowed)\s+(?:from|at)\s+)(.{3,100})/i,
  // Possessive with context: "my snake plant I got", "my new boots from Zara"
  /(?:my (?:new )?\w+(?:\s+\w+)?\s+(?:I |that I |which I )(?:got|bought|picked up|made|built|finished))(.{3,100})/i,
];

const PREFERENCE_PATTERNS = [
  // Direct preference: "I prefer React", "I like hiking"
  /(?:I (?:prefer|like|love|enjoy|hate|dislike|can't stand|always use|usually)\s+)(.{5,120})/i,
  // Favorites: "my favorite restaurant"
  /(?:my (?:favorite|preferred|go-to)\s+)(.{5,80})/i,
  // Enthusiasm: "I'm really into woodworking"
  /(?:I(?:'m| am) (?:a fan of|really into|passionate about|interested in|obsessed with)\s+)(.{5,80})/i,
  // Habitual: "I've been using Vallejo acrylics"
  /(?:I(?:'ve| have) been (?:using|experimenting with)\s+)(.{5,100})/i,
];

const EPISODIC_PATTERNS = [
  // Direct actions: "I went to", "I visited", "I bought"
  /(?:I (?:went|visited|attended|bought|picked up|returned|started|finished|completed|signed up|enrolled|exchanged|watched|cooked|made|built|planted|canceled|cancelled|serviced|cleaned|fixed|repaired)\s+)(.{5,120})/i,
  // Appointments/meetings: "I had an appointment with Dr. Smith" (HUGE gap for medical/professional Qs)
  /(?:I (?:had|have|scheduled|booked|made)\s+(?:a |an |my )?(?:appointment|meeting|session|consultation|check-up|follow-up|interview|lesson|class)\s+)(.{5,120})/i,
  // Temporal context: "last week I went", "recently I finished"
  /(?:(?:last|this|next|yesterday|today|recently|just)\s+(?:week|month|weekend|night|morning|year|summer|winter|spring|fall|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Monday))(?:\s+I\s+|\s*,?\s*I\s+)(.{5,120})/i,
  // Ongoing activities: "I've been working on a model kit"
  /(?:I(?:'ve| have) been (?:working on|learning|practicing|training|building|cooking|reading|watching|playing|hiking|camping|running|swimming|gardening|painting|dealing with|seeing|posting|getting)\s+)(.{5,120})/i,
  // Recent actions: "I just got back from", "I recently finished"
  /(?:I (?:just|recently) (?:got|got back from|bought|adopted|moved|joined|left|quit|started|finished|completed|returned from|attended|noticed|canceled)\s+)(.{5,120})/i,
  // Casual asides (HUGE in LongMemEval): "by the way, I still need to pick up"
  /(?:by the way,?\s+I\s+)(.{10,120})/i,
  // "Oh and" / "Also" asides: common in conversational data
  /(?:(?:oh,?\s+)?(?:and )?by the way|also),?\s+I\s+(.{10,120})/i,
  // "Also" actions: "I also started working on a tank"
  /(?:I also (?:started|finished|bought|got|picked up|need to|have to|want to|attended|visited|went)\s+)(.{5,120})/i,
  // Past trips: "I just got back from a camping trip"
  /(?:I (?:just )?got back from\s+)(.{5,120})/i,
  // Duration activities: "I watched all 22 Marvel movies in two weeks"
  /(?:I (?:watched|read|finished|completed|did|spent)\s+(?:all|the|every)\s+)(.{5,120})/i,
  // Participation: "I recently participated in", "I recently presented"
  /(?:I (?:recently )?(?:participated|presented|competed|performed|volunteered|organized)\s+)(.{5,120})/i,
  // Arrival/receipt: "it arrived on 1/20", "I received it on"
  /(?:(?:it |that |the \w+ )(?:arrived|came|was delivered)\s+(?:on |last |this ))(.{5,80})/i,
  // Numerical changes: "my follower count jumped from X to Y", "went from X to Y"
  /(?:(?:my |the )?\w+(?:\s+\w+)?\s+(?:jumped|grew|increased|went|dropped|fell)\s+from\s+\d+\s+to\s+\d+)(.{0,80})/i,
  // Cost/spending: "I paid $200 to attend", "it cost me $50"
  /(?:I (?:paid|spent)\s+\$?\d+)(.{5,100})/i,
];

const SOLUTION_PATTERNS = [
  /(?:fixed|solved|resolved|the fix was|the issue was|the problem was|solution was|that worked)\s*[:\s]?\s*(.{10,200})/i,
  /(?:works?(?:ed)? (?:now|correctly|properly|after))\s+(.{10,120})/i,
  /(?:root cause|underlying issue)(?:\s+was)?\s*[:\s]\s*(.{10,200})/i,
];

const ERROR_PATTERNS = [
  /(?:error|Error|ERROR|exception|Exception|ECONNREFUSED|ENOENT|EPERM|EACCES|ETIMEDOUT|SIGKILL|SIGTERM|OOM|segfault|panic|fatal)\s*[:\s]?\s*(.{5,150})/i,
  /(?:failed|failing|broken|crash(?:ed|ing)?|not working)\s*[:\s]?\s*(.{5,100})/i,
];

/**
 * Extract knowledge from a single session.
 */
export function extractKnowledge(session: ParsedSession): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const messages = session.messages;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const text = msg.text;

    // Extract decisions
    for (const pattern of DECISION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        entries.push({
          id: randomUUID(),
          type: "decision",
          project: session.project,
          sessionId: session.sessionId,
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
          summary: match[1].trim().replace(/\.$/, ""),
          details: getContext(messages, i),
          tags: extractTags(text),
          relatedFiles: extractFilePaths(text),
        });
        break; // One per message
      }
    }

    // Extract solutions
    for (const pattern of SOLUTION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        entries.push({
          id: randomUUID(),
          type: "solution",
          project: session.project,
          sessionId: session.sessionId,
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
          summary: match[1].trim().replace(/\.$/, ""),
          details: getContext(messages, i),
          tags: extractTags(text),
          relatedFiles: extractFilePaths(text),
        });
        break;
      }
    }

    // Extract error → fix sequences
    if (msg.role === "user" || msg.role === "assistant") {
      for (const pattern of ERROR_PATTERNS) {
        const match = text.match(pattern);
        if (match && i + 1 < messages.length) {
          // Look ahead for a solution
          const nextMessages = messages.slice(i + 1, i + 4);
          for (const nextMsg of nextMessages) {
            for (const solPattern of SOLUTION_PATTERNS) {
              const solMatch = nextMsg.text.match(solPattern);
              if (solMatch) {
                entries.push({
                  id: randomUUID(),
                  type: "error_fix",
                  project: session.project,
                  sessionId: session.sessionId,
                  timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
                  summary: `${match[1].trim()} → ${solMatch[1].trim()}`.slice(0, 200),
                  details: getContext(messages, i, 3),
                  tags: extractTags(text + " " + nextMsg.text),
                  relatedFiles: extractFilePaths(text + " " + nextMsg.text),
                });
                break;
              }
            }
          }
          break;
        }
      }
    }

    // Extract personal facts, preferences, and episodic events (user messages only)
    if (msg.role === "user") {
      for (const pattern of FACT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          entries.push({
            id: randomUUID(),
            type: "fact",
            project: session.project,
            sessionId: session.sessionId,
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
            summary: match[0].trim().slice(0, 120),
            details: getContext(messages, i),
            tags: extractTags(text),
            relatedFiles: [],
          });
          break;
        }
      }

      for (const pattern of PREFERENCE_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          entries.push({
            id: randomUUID(),
            type: "preference",
            project: session.project,
            sessionId: session.sessionId,
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
            summary: match[0].trim().slice(0, 120),
            details: getContext(messages, i),
            tags: extractTags(text),
            relatedFiles: [],
          });
          break;
        }
      }

      for (const pattern of EPISODIC_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          entries.push({
            id: randomUUID(),
            type: "episodic",
            project: session.project,
            sessionId: session.sessionId,
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : session.startTime,
            summary: match[0].trim().slice(0, 120),
            details: getContext(messages, i),
            tags: extractTags(text),
            relatedFiles: [],
          });
          break;
        }
      }
    }
  }

  return deduplicateEntries(entries);
}

/**
 * Get context around a message index.
 */
function getContext(
  messages: ParsedSession["messages"],
  index: number,
  windowSize = 2
): string {
  const start = Math.max(0, index - windowSize);
  const end = Math.min(messages.length, index + windowSize + 1);
  return messages
    .slice(start, end)
    .map((m) => {
      const text = m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text;
      return `[${m.role}] ${text}`;
    })
    .join("\n");
}

/**
 * Extract technology/tool tags from text.
 */
export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  const techPatterns: Record<string, RegExp> = {
    docker: /\bdocker\b/i,
    typescript: /\btypescript\b|\bts\b/i,
    javascript: /\bjavascript\b|\bjs\b/i,
    react: /\breact\b/i,
    node: /\bnode\.?js?\b/i,
    python: /\bpython\b/i,
    git: /\bgit\b/i,
    npm: /\bnpm\b/i,
    css: /\bcss\b|\bstyle/i,
    api: /\bapi\b|\bendpoint/i,
    database: /\bdatabase\b|\bsql\b|\bpostgres\b|\bmongo\b/i,
    testing: /\btest(?:s|ing)?\b/i,
    deployment: /\bdeploy\b|\bci\/cd\b/i,
    security: /\bsecurity\b|\bauth\b/i,
    performance: /\bperformance\b|\boptimiz/i,
    networking: /\bnetwork\b|\bhttp\b|\btcp\b/i,
    linux: /\blinux\b|\bubuntu\b|\bdebian\b/i,
    macos: /\bmacos\b|\bmac\b/i,
    swift: /\bswift\b|\bswiftui\b/i,
    ios: /\bios\b|\bxcode\b/i,
  };

  for (const [tag, pattern] of Object.entries(techPatterns)) {
    if (pattern.test(text)) tags.add(tag);
  }

  return [...tags];
}

/**
 * Extract file paths from text.
 */
export function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  const matches = text.match(/(?:\/[\w.-]+){2,}/g);
  if (matches) {
    for (const match of matches.slice(0, 5)) {
      paths.add(match);
    }
  }
  return [...paths];
}

/**
 * Remove near-duplicate entries.
 */
function deduplicateEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.type}:${e.summary.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract knowledge with evaluation gate and dedup.
 * Filters extracted entries through actionability/specificity/relevance checks,
 * then deduplicates against existing knowledge.
 */
export function extractEvaluatedKnowledge(
  session: ParsedSession,
  existingEntries: KnowledgeEntry[] = []
): KnowledgeEntry[] {
  const raw = extractKnowledge(session);
  const evaluator = new KnowledgeEvaluator();

  const evaluated: KnowledgeEntry[] = [];
  for (const entry of raw) {
    // Evaluate quality (content = summary + details)
    const content = `${entry.summary} ${entry.details}`;
    const evalResult = evaluator.evaluate(content, entry.type);
    if (evalResult.outcome === "rejected") continue;

    // Check dedup against existing entries
    if (existingEntries.length > 0) {
      const existing = existingEntries.map((e) => ({
        id: e.id,
        content: `${e.summary} ${e.details}`,
      }));
      const dedupResult = checkDuplicate(content, existing);

      if (dedupResult.isDuplicate && !dedupResult.shouldMerge) continue;
      // If shouldMerge, we still accept — caller handles merge
    }

    evaluated.push(entry);
  }

  return evaluated;
}
