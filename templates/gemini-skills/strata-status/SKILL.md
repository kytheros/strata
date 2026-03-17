---
name: strata-status
description: Get a quick overview of what Strata knows about the current project — session count, recent activity, key decisions, and knowledge health.
---

# Strata Status

Get a quick overview of the current project's Strata memory.

## Instructions

Run these in parallel:
1. `get_project_context` with depth="detailed" for the current project
2. `list_projects` sorted by "recent"
3. `find_patterns` with type="all"

### Output Format

```
## Strata Memory Status

### Current Project: {name}
- Sessions indexed: {count}
- Last activity: {date}
- Key decisions: {list}
- Known solutions: {list}

### Knowledge Health
- Total projects tracked: {count}
- Open evidence gaps: {count}
- Recurring issues: {list}
```
