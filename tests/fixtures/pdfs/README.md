# PDF Test Fixtures

Static PDF fixtures consumed by `tests/tools/pdf-prepare.test.ts`.

These are generated once (committed binaries) so that the test suite has
zero runtime PDF-creation dependency. The repo's runtime no longer
includes `pdf-lib`; this fixture set is what allows that.

## Fixtures

| File | Pages | Purpose |
|------|-------|---------|
| `1-page.pdf` | 1 | Multimodal path, smallest case |
| `6-pages.pdf` | 6 | Multimodal path, upper boundary |
| `7-pages.pdf` | 7 | Text-only path, lower boundary |
| `13-pages.pdf` | 13 | Text-only path, multi-page |
| `empty-or-corrupt.pdf` | — | Throws on parse |

Each text-bearing page contains: `Page N content for testing`

## Regenerating

If a new fixture is needed, edit `scripts/generate-pdf-fixtures.mjs`
to add the page count, then run:

```
node scripts/generate-pdf-fixtures.mjs
```

The script requires `pdf-lib` to be installed. Since `pdf-lib` was removed
from runtime `dependencies`, install it temporarily:

```
npm install --no-save pdf-lib
node scripts/generate-pdf-fixtures.mjs
```

Commit the updated PDFs.
