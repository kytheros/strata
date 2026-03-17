# Strata Status

Get a quick overview of what Strata knows about the current project.

## Instructions

Gather comprehensive status about the current project's Strata memory using multiple tools in parallel.

### Process

Run these in parallel:
1. `get_project_context` with depth="detailed" for the current project
2. `list_projects` sorted by "recent" to see all indexed projects
3. `find_patterns` with type="all" for the current project

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
- Recurring topics: {list}
- Open evidence gaps: {count}
- Recurring issues: {list}

### Recent Activity
{last 3 sessions with topics}
```

Keep the output concise — this is a quick status check, not a deep dive. For deeper research, suggest using `/recall`.
