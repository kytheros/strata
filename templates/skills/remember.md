# Remember

Store a memory in Strata for future recall across sessions.

## Instructions

The user wants to store something in Strata's persistent memory. Parse their input to determine the best type and tags, then call `store_memory`.

### Type Detection

Analyze the user's text and select the most appropriate type:

| Signal | Type |
|--------|------|
| "decided", "going with", "chose", "switched to" | `decision` |
| "fixed", "resolved", "the issue was", "root cause" | `error_fix` |
| "solved by", "the answer is", "workaround" | `solution` |
| "I prefer", "always use", "don't ever" | `preference` |
| "learned that", "turns out", "TIL" | `learning` |
| "step 1", "first do", "procedure for" | `procedure` |
| "the API limit is", "the endpoint is", "the password is" | `fact` |
| Recurring observation or code pattern | `pattern` |
| General session context | `episodic` |

### Process

1. Parse the user's text for type signals
2. Extract relevant tags (technologies, concepts, project names)
3. Detect project context from the current working directory if not specified
4. Call `store_memory` with the parsed memory, type, and tags
5. Confirm what was stored

### Example

User: `/remember We decided to use PostgreSQL instead of MySQL for JSONB support`

Action: `store_memory("We decided to use PostgreSQL instead of MySQL for JSONB support", type="decision", tags=["postgresql", "mysql", "database"])`
