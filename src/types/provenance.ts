/**
 * Provenance handle — the structured form of the bracket-handle citation
 * (`[mem:<short> sess:<short> t:<date>]`) used in agent-facing search tool
 * responses. Encodes "where did this come from" — id, session, timing, edits.
 *
 * Note: the discriminator for "what kind of result is this" (conversation /
 * document / chunk / turn) lives on `SearchResult.source` (shipped under
 * TIRQDP-2.1, commits 02e0670 + e5ba798). ProvenanceHandle deliberately does
 * not duplicate it.
 */
export interface ProvenanceHandle {
  /** Full row id of the source memory. */
  id: string;
  /** Session that produced the memory, or null for legacy / ingest_document rows. */
  sessionId: string | null;
  /** Originating creation timestamp (ms epoch). */
  createdAt: number;
  /** Most recent mutation timestamp (ms epoch). */
  updatedAt: number;
  /** Count of rows in knowledge_history for this id. */
  editCount: number;
}
