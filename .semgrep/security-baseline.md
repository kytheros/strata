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
| mcp-missing-input-validation | 23 in strata/ | Disabled in custom-rules.yml. MCP SDK `registerTool()` validates all input against the Zod schema at the framework level before invoking handlers. Every handler receives pre-validated params. False positive by design for MCP SDK codebases. |

## WARNING Severity — Accepted (13 findings)

### prototype-pollution-bracket-notation (13 findings)

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

## Notes

- **Gitleaks**: All findings are in `.env`/`.env.local` (gitignored) or test fixtures. Credentials rotated.
- **npm audit**: Run `npm audit` periodically to check for dependency vulnerabilities.
