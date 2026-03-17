---
name: gaps
description: Show open evidence gaps — topics that were searched for but never answered in Strata memory. Use when the user asks what is missing from their knowledge base.
---

# Gaps

Show open evidence gaps — things that were searched for but never answered.

## Instructions

Use Strata MCP tools to find and display open evidence gaps for the current project.

### Process

1. Call `find_patterns` with type="gap" to find open evidence gaps, or use `list_evidence_gaps` if available (Pro)
2. If neither tool returns results, call `search_history` with query "evidence gap" to find gap-related discussions
3. Present the gaps as a prioritized list with occurrence counts

### Output Format

```
## Open Knowledge Gaps

| Query | Times Searched | First Seen | Last Seen |
|-------|---------------|------------|-----------|

### Suggestions
- To fill a gap, use the remember skill or store_memory with relevant knowledge
- Gaps are automatically resolved when matching knowledge is stored
```
