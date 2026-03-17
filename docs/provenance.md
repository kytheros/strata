# Provenance and Audit Trail

Strata maintains a complete audit trail of every knowledge mutation. Every add, update, and delete is recorded in the `knowledge_history` table with before/after content, enabling full provenance tracing from any knowledge entry back to its origin.

---

## knowledge_history Table

**Source:** `src/storage/database.ts` (schema), `src/storage/sqlite-knowledge-store.ts` (write operations)

### Schema

```sql
CREATE TABLE knowledge_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    TEXT NOT NULL,
  old_summary TEXT,
  new_summary TEXT,
  old_details TEXT,
  new_details TEXT,
  event       TEXT NOT NULL CHECK(event IN ('add', 'update', 'delete')),
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_knowledge_history_entry ON knowledge_history(entry_id, id DESC);
```

### What Each Event Captures

| Event | old_summary | new_summary | old_details | new_details | When |
|-------|------------|------------|------------|------------|------|
| `add` | `NULL` | Entry summary | `NULL` | Entry details | A new knowledge entry is created via extraction, `store_memory`, or conflict resolution merge |
| `update` | Previous summary | Updated summary | Previous details | Updated details | Entry is modified via `update_memory`, procedure merge, or conflict resolution update |
| `delete` | Entry summary at deletion | `NULL` | Entry details at deletion | `NULL` | Entry is removed via `delete_memory` or conflict resolution supersession |

### Row Type

```typescript
interface KnowledgeHistoryRow {
  id: number;           // Auto-incrementing sequence number
  entry_id: string;     // The knowledge entry ID this event relates to
  old_summary: string | null;
  new_summary: string | null;
  old_details: string | null;
  new_details: string | null;
  event: "add" | "update" | "delete";
  created_at: number;   // Unix timestamp (ms)
}
```

---

## How Mutations Are Recorded

### On Add (`addEntry`)

When a new knowledge entry is stored (`src/storage/sqlite-knowledge-store.ts`), the add is wrapped in a transaction:

1. Check for exact duplicate (project + type + summary + user). If duplicate exists, skip silently.
2. INSERT the entry into the `knowledge` table.
3. INSERT a history row with `event = 'add'`, `old_summary = NULL`, `new_summary = entry.summary`, `old_details = NULL`, `new_details = entry.details`.
4. Prune history if the entry has more than 100 history rows.

### On Update (`updateEntry`)

When a knowledge entry is modified (`src/storage/sqlite-knowledge-store.ts`):

1. Fetch the current row from the `knowledge` table.
2. If the entry does not exist, return false.
3. UPDATE the entry with the provided patch fields (summary, details, tags, type). Sets `updated_at` to the current timestamp.
4. INSERT a history row with `event = 'update'`, capturing both old and new values for summary and details.
5. Prune history if the entry has more than 100 history rows.

Both the UPDATE and the history INSERT run inside a single SQLite transaction for atomicity.

### On Delete (`deleteEntry`)

When a knowledge entry is removed (`src/storage/sqlite-knowledge-store.ts`):

1. Fetch the current row from the `knowledge` table.
2. If the entry does not exist, return false.
3. INSERT a history row with `event = 'delete'`, `old_summary = entry.summary`, `new_summary = NULL`, `old_details = entry.details`, `new_details = NULL`.
4. DELETE the row from the `knowledge` table.
5. Prune history if the entry has more than 100 history rows.

The history INSERT happens before the DELETE, ensuring the audit record is written even if the transaction is interrupted after the DELETE.

---

## Tracing a Knowledge Entry to Its Origin

Every knowledge entry in the `knowledge` table carries origin metadata:

| Column | What It Tells You |
|--------|-------------------|
| `session_id` | The conversation session where this knowledge was extracted. For explicit memories stored via `store_memory`, this is `"explicit-memory"`. |
| `project` | The project context at the time of extraction. For global knowledge, this is `"global"`. |
| `timestamp` | When the knowledge was first created (Unix ms). |
| `extracted_at` | When the extraction pipeline processed the source session (Unix ms). May differ from `timestamp` for batch-extracted entries. |
| `updated_at` | When the entry was last modified (Unix ms). `NULL` if never updated. |
| `user` | The user scope that created this entry. Defaults to `STRATA_DEFAULT_USER` env var or `"default"`. |
| `type` | The knowledge category (decision, solution, error_fix, etc.) which indicates the extraction pattern that detected it. |
| `tags` | JSON array of tags, which may include technology names, error codes, or topic markers from the extraction pipeline. |
| `related_files` | JSON array of file paths referenced in the source conversation, linking knowledge to specific code. |
| `occurrences` | For learning entries: how many source entries were clustered to produce this synthesized learning. |
| `project_count` | For learning entries: how many distinct projects contributed to this learning. |

### Tracing Example

Given a knowledge entry with `id = "abc-123"`:

1. **Check the entry itself:** `SELECT * FROM knowledge WHERE id = 'abc-123'` reveals the session, project, timestamp, and type.
2. **Check the history:** `SELECT * FROM knowledge_history WHERE entry_id = 'abc-123' ORDER BY id ASC` shows the complete lifecycle: when it was added, every update with before/after diffs, and whether it was deleted.
3. **Find the source conversation:** If `session_id` is not `"explicit-memory"`, use `SELECT * FROM summaries WHERE session_id = '<session_id>'` to find the session summary, or `SELECT * FROM documents WHERE session_id = '<session_id>'` to find the raw conversation chunks.
4. **Check entity links:** `SELECT e.* FROM entities e JOIN knowledge_entities ke ON e.id = ke.entity_id WHERE ke.entry_id = 'abc-123'` shows which entities (libraries, services, tools) are associated with this knowledge.

---

## Evidence Gap Tracking

The `evidence_gaps` table tracks knowledge blind spots -- queries that returned no results or low-confidence results.

### Schema

```sql
CREATE TABLE evidence_gaps (
  id               TEXT PRIMARY KEY,
  query            TEXT NOT NULL,
  tool             TEXT NOT NULL,
  project          TEXT,
  user             TEXT NOT NULL DEFAULT 'default',
  result_count     INTEGER NOT NULL,
  top_score        REAL,
  top_confidence   REAL,
  occurred_at      INTEGER NOT NULL,
  resolved_at      INTEGER,
  resolution_id    TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1
);
```

### Gap Lifecycle

1. **Recording:** When a search returns empty or low-confidence results, a gap is recorded. If an unresolved gap with the same normalized query already exists, its `occurrence_count` is incremented.
2. **Resolution:** When `store_memory` writes new knowledge, the system checks open gaps using Jaccard similarity (threshold: 0.4). Matching gaps are marked resolved with `resolved_at` timestamp and `resolution_id` pointing to the new knowledge entry.
3. **Pruning:** Gaps older than 90 days are auto-pruned. Each project+user combination is limited to 100 open gaps.

### Gap-Aware Nudges

When a gap has `occurrence_count >= 2`, search tools inject a nudge:

```
Note: This topic has been searched 3 times without good matches --
consider using store_memory to record relevant knowledge.
```

---

## Accessing the Audit Trail

### Via MCP Tool: `memory_history` (Pro)

The `memory_history` tool (`strata-pro/src/tools/memory-history.ts`) exposes the audit trail through MCP:

```
memory_history({ id: "abc-123" })
memory_history({ id: "abc-123", limit: 100 })
```

Returns the most recent history rows for the given entry ID, ordered newest-first. The `limit` parameter defaults to 20, maximum 100.

History persists even after an entry is deleted, so you can always trace what happened to a removed entry.

### Via SQL (direct database access)

```sql
-- Get the complete history for an entry
SELECT * FROM knowledge_history
WHERE entry_id = 'abc-123'
ORDER BY id DESC;

-- Find all deletions in the last 7 days
SELECT * FROM knowledge_history
WHERE event = 'delete'
  AND created_at > (strftime('%s', 'now') * 1000 - 7 * 86400000)
ORDER BY created_at DESC;

-- Count mutations by type
SELECT event, COUNT(*) as count
FROM knowledge_history
GROUP BY event;
```

### History Pruning

Each entry's history is capped at 100 rows. When a new mutation would exceed this limit, the oldest rows are pruned. The pruning runs inside the same transaction as the mutation, so it is atomic.

---

## Further Reading

- [Evaluator Pipeline](evaluator-pipeline.md) -- quality gates that determine what gets stored
- [Architecture Overview](architecture.md) -- full system design and storage schema
