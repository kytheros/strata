---
name: remember
description: Store a memory in Strata for future recall across sessions. Use when the user says they want to remember something, or uses phrases like "note that", "decided", "fixed by", or "always do".
---

# Remember

Store a memory in Strata for future recall.

## Instructions

The user wants to store something in Strata's persistent memory. Parse their input to determine the best type and tags, then call `store_memory`.

### Type Detection

| Signal | Type |
|--------|------|
| "decided", "going with", "chose" | `decision` |
| "fixed", "resolved", "root cause" | `error_fix` |
| "solved by", "workaround" | `solution` |
| "I prefer", "always use" | `preference` |
| "learned that", "turns out", "TIL" | `learning` |
| "step 1", "procedure for" | `procedure` |
| "the API limit is", "the endpoint is" | `fact` |
| Recurring observation | `pattern` |

### Process

1. Parse the user's text for type signals
2. Extract relevant tags
3. Detect project context from cwd if not specified
4. Call `store_memory` with parsed memory, type, and tags
5. Confirm what was stored
