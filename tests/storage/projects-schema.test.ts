import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/storage/database.js";

describe("projects table", () => {
  it("is created with canonical_slug PRIMARY KEY and required columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-proj-schema-"));
    const db = openDatabase(join(dir, "test.db"));
    const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{name:string;pk:number;notnull:number}>;
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    expect(byName.canonical_slug).toMatchObject({ pk: 1, notnull: 1 });
    expect(byName.display_name).toMatchObject({ notnull: 1 });
    expect(byName.aliases).toMatchObject({ notnull: 1 });
    expect(byName.first_seen).toMatchObject({ notnull: 1 });
    expect(byName.last_seen).toMatchObject({ notnull: 1 });
    db.close();
  });
});
