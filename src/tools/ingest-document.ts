/**
 * ingest_document MCP tool handler.
 * Extracts structured insights from an uploaded document and stores them
 * as searchable knowledge entries for future recall.
 */

import { randomUUID } from "crypto";
import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";
import type { KnowledgeEntry, KnowledgeType } from "../knowledge/knowledge-store.js";
import { computeImportance } from "../knowledge/importance.js";

export interface IngestDocumentArgs {
  source: string;
  document_type: string;
  summary: string;
  key_findings: string[];
  metrics?: Record<string, string>;
  tags?: string[];
  project?: string;
  user?: string;
}

/**
 * Handle the ingest_document tool call.
 * Creates knowledge entries for the document summary, each key finding,
 * and optionally a metrics entry. Returns a confirmation message.
 */
export async function handleIngestDocument(
  knowledgeStore: IKnowledgeStore,
  args: IngestDocumentArgs
): Promise<string> {
  const {
    source,
    document_type,
    summary,
    key_findings,
    metrics,
    tags = [],
    project = "global",
    user,
  } = args;

  // --- Validation ---
  if (!source || source.trim().length === 0) {
    return "Error: source is required.";
  }
  if (!document_type || document_type.trim().length === 0) {
    return "Error: document_type is required.";
  }
  if (!summary || summary.trim().length === 0) {
    return "Error: summary is required.";
  }
  if (!key_findings || key_findings.length === 0) {
    return "Error: key_findings must contain at least one finding.";
  }

  const baseTags = ["document-extraction", source.trim(), ...tags];
  const sessionId = "document-extraction";
  const now = Date.now();
  let entriesStored = 0;

  // --- 1. Document summary entry (importance 0.7) ---
  const summaryEntry: KnowledgeEntry = {
    id: randomUUID(),
    type: "fact" as KnowledgeType,
    project,
    user,
    sessionId,
    timestamp: now,
    summary: `[${document_type}] ${source}: ${summary.trim().slice(0, 180)}`,
    details: `Source: ${source}\nType: ${document_type}\n\n${summary.trim()}`,
    tags: baseTags,
    relatedFiles: [],
    extractedAt: now,
  };
  // Compute baseline, then override with fixed importance
  computeImportance({
    text: `${summaryEntry.summary} ${summaryEntry.details}`,
    sessionId,
    knowledgeType: "fact",
  });
  summaryEntry.importance = 0.7;
  await knowledgeStore.addEntry(summaryEntry);
  entriesStored++;

  // --- 2. One entry per key finding (importance 0.5) ---
  for (const finding of key_findings) {
    const trimmed = finding.trim();
    if (trimmed.length === 0) continue;

    const findingEntry: KnowledgeEntry = {
      id: randomUUID(),
      type: "fact" as KnowledgeType,
      project,
      user,
      sessionId,
      timestamp: now,
      summary: trimmed.slice(0, 200),
      details: `Finding from ${source} (${document_type}): ${trimmed}`,
      tags: baseTags,
      relatedFiles: [],
      extractedAt: now,
    };
    findingEntry.importance = 0.5;
    await knowledgeStore.addEntry(findingEntry);
    entriesStored++;
  }

  // --- 3. Metrics entry if provided (importance 0.6) ---
  if (metrics && Object.keys(metrics).length > 0) {
    const metricsLines = Object.entries(metrics)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

    const metricsEntry: KnowledgeEntry = {
      id: randomUUID(),
      type: "fact" as KnowledgeType,
      project,
      user,
      sessionId,
      timestamp: now,
      summary: `Key metrics from ${source}: ${Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 150)}`,
      details: `Metrics extracted from ${source} (${document_type}):\n${metricsLines}`,
      tags: baseTags,
      relatedFiles: [],
      extractedAt: now,
    };
    metricsEntry.importance = 0.6;
    await knowledgeStore.addEntry(metricsEntry);
    entriesStored++;
  }

  return `Ingested ${key_findings.length} findings from ${source} (stored ${entriesStored} entries)`;
}
