/**
 * CompactSerializer — entity-aware response formatter.
 *
 * Automatically selects fields and format based on:
 * - Entity type (results, projects, sessions)
 * - Verbosity level (concise/TOON, standard, detailed)
 */

import { ResponseFormat } from "./response-format.js";
import { ToonSerializer } from "./toon-serializer.js";
import { getFieldsForFormat } from "./field-config.js";

export class CompactSerializer {
  constructor(private entityType: string) {}

  /**
   * Serialize data with format-aware field selection.
   */
  serialize(
    data: Record<string, unknown>[],
    options: { format: ResponseFormat }
  ): string {
    if (data.length === 0) {
      return `${this.entityType}[0]{}: (empty)`;
    }

    switch (options.format) {
      case ResponseFormat.CONCISE:
        return this.serializeConcise(data);
      case ResponseFormat.STANDARD:
        return this.serializeStandard(data);
      case ResponseFormat.DETAILED:
        return this.serializeDetailed(data);
      default:
        return this.serializeStandard(data);
    }
  }

  private serializeConcise(data: Record<string, unknown>[]): string {
    const fields = getFieldsForFormat(this.entityType, "concise");
    if (fields.length === 0) {
      // Fallback: use first 4 keys from first item
      const fallback = Object.keys(data[0]).slice(0, 4);
      return ToonSerializer.serialize(this.entityType, data, fallback);
    }
    return ToonSerializer.serialize(this.entityType, data, fields);
  }

  private serializeStandard(data: Record<string, unknown>[]): string {
    const fields = getFieldsForFormat(this.entityType, "standard");
    if (fields.length === 0) {
      return JSON.stringify(data);
    }

    const filtered = data.map((item) => {
      const obj: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in item) obj[field] = item[field];
      }
      return obj;
    });
    return JSON.stringify(filtered);
  }

  private serializeDetailed(data: Record<string, unknown>[]): string {
    return JSON.stringify(data);
  }
}
