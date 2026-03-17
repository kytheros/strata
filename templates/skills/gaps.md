# Gaps

Show open evidence gaps — things that were searched for but never answered.

## Instructions

Use Strata MCP tools to find and display open evidence gaps for the current project.

### Process

1. Call `search_history` with query `"evidence_gaps status:open"` to find gap-related entries
2. If the project has a Strata database, the gaps are tracked automatically when searches return no results
3. Present the gaps as a prioritized list

### Output Format

```
## Open Knowledge Gaps

| Query | Times Searched | First Seen | Last Seen |
|-------|---------------|------------|-----------|
| "kubernetes deployment" | 5 | 2026-03-01 | 2026-03-11 |
| "CORS middleware config" | 3 | 2026-03-05 | 2026-03-10 |

### Suggestions
- To fill a gap, use `/remember` or `store_memory` with relevant knowledge
- Gaps are automatically resolved when matching knowledge is stored
```

If no gaps are found, tell the user their knowledge base has good coverage.
