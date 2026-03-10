# Security Baseline — Accepted Risks

All suppressions require justification and quarterly review. ERROR-severity suppressions require a tracking issue.

**Last Updated**: 2026-03-08
**Next Review**: 2026-06-08

## ERROR Severity (1 finding)

| ID | Rule | File | Line | Justification |
|----|------|------|------|---------------|
| SB-001 | sql-injection-template-literal | strata/src/storage/sqlite-knowledge-store.ts | 339 | `setClauses` array contains only hardcoded string literals (`"tags = ?"`, `"type = ?"`, etc.) joined with `, `. No user input flows into the SQL structure. All dynamic values use `?` parameterized placeholders. Safe by construction. |

## WARNING Severity — Disabled Rule

| Rule | Findings | Justification |
|------|----------|---------------|
| mcp-missing-input-validation | 46 across strata/ and strata-pro/ | Disabled in custom-rules.yml. MCP SDK `registerTool()` validates all input against the Zod schema at the framework level before invoking handlers. Every handler in our codebase receives pre-validated params. False positive by design for MCP SDK codebases. |

## WARNING Severity — Accepted (17 findings)

### mcp-schema-missing-strict (2 findings in strata-pro/)

| File | Line | Justification |
|------|------|---------------|
| strata-pro/src/server.ts | 222 | Schema used for `registerTool()` definition. MCP SDK controls property filtering. `.strict()` on nested `z.object()` within `z.array()` would reject valid tool calls with optional fields. |
| strata-pro/src/server.ts | 226 | Same — nested schema for `toolCalls` array. SDK handles validation boundary. |

### prototype-pollution-bracket-notation (15 findings)

All bracket-notation assignments use controlled, internal keys (loop counters, known field names from database rows, or serialization indices). None accept external user input.

| File | Line | Key Source |
|------|------|-----------|
| strata/src/cli.ts | 129 | CLI arg parsing — internal key mapping |
| strata/src/indexing/bm25.ts | 154 | Term frequency map — token string keys from internal tokenizer |
| strata/src/indexing/bm25.ts | 158 | Document frequency map — same |
| strata/src/indexing/index-manager.ts | 139 | Index metadata object — hardcoded field name |
| strata/src/indexing/sqlite-index-manager.ts | 81 | Document field map — database column names |
| strata/src/indexing/sqlite-index-manager.ts | 122 | Same |
| strata/src/indexing/sqlite-index-manager.ts | 127 | Same |
| strata/src/indexing/tfidf.ts | 180 | Term frequency calculation — tokenizer output |
| strata/src/indexing/tfidf.ts | 187 | Same |
| strata/src/indexing/tfidf.ts | 189 | Same |
| strata/src/storage/sqlite-meta-store.ts | 74 | Metadata key from database row |
| strata/src/utils/compact-serializer.ts | 58 | Serialization field index — internal format |
| strata/src/utils/toon-serializer.ts | 85 | Same — internal serialization |
| strata-pro/src/ee/analytics/usage-tracker.ts | 137 | Analytics counter key — internal metric name |
| strata-pro/src/ee/analytics/usage-tracker.ts | 155 | Same |

## Notes

- **strata-team/**: Clean scan — 0 findings
- **Gitleaks**: 7 findings triaged in previous session — all in `.env`/`.env.local` (gitignored) or test fixtures. Credentials rotated.
- **npm audit**: 5 moderate severity vulnerabilities in strata-pro, strata-team, strata-web (shared dependency chain). Run `npm audit fix --force` to address.
