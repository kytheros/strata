/**
 * TOON (Token-Optimized Object Notation) serializer
 *
 * Converts arrays of objects to compact format:
 * entity[count]{field1,field2}:
 *   value1,value2
 *   value1,value2
 *
 * 30-60% token reduction vs. JSON for list responses.
 */

export class ToonSerializer {
  /**
   * Serialize array of objects to TOON format.
   */
  static serialize(
    entityName: string,
    data: Record<string, unknown>[],
    fields: string[]
  ): string {
    if (data.length === 0) {
      return `${entityName}[0]{}: (empty)`;
    }

    const header = `${entityName}[${data.length}]{${fields.join(",")}}:`;

    const rows = data.map((item) => {
      return fields
        .map((field) => {
          const value = item[field];
          if (value === null || value === undefined) return "";
          if (typeof value === "string") {
            return value.replace(/,/g, "\\,").replace(/\n/g, "\\n");
          }
          return String(value);
        })
        .join(",");
    });

    return `${header}\n  ${rows.join("\n  ")}`;
  }

  /**
   * Parse TOON format back to objects (for testing/round-trip).
   */
  static parse(toon: string): Record<string, unknown>[] {
    const lines = toon.trim().split("\n");
    const headerLine = lines[0];

    const fieldsMatch = headerLine.match(/\{([^}]+)\}/);
    if (!fieldsMatch) return [];

    const fields = fieldsMatch[1].split(",");

    return lines.slice(1).map((line) => {
      // Split on unescaped commas
      const values: string[] = [];
      let current = "";
      for (let i = 0; i < line.trimStart().length; i++) {
        const ch = line.trimStart()[i];
        if (ch === "\\" && i + 1 < line.trimStart().length) {
          const next = line.trimStart()[i + 1];
          if (next === ",") {
            current += ",";
            i++;
            continue;
          }
          if (next === "n") {
            current += "\n";
            i++;
            continue;
          }
        }
        if (ch === ",") {
          values.push(current);
          current = "";
          continue;
        }
        current += ch;
      }
      values.push(current);

      const obj: Record<string, unknown> = {};
      fields.forEach((field, i) => {
        obj[field] = values[i] || "";
      });
      return obj;
    });
  }
}
