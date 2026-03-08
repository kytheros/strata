/**
 * Registry for conversation parsers.
 * Manages registration and discovery of available parsers.
 */

import type { ConversationParser } from "./parser-interface.js";

export class ParserRegistry {
  private parsers = new Map<string, ConversationParser>();

  /**
   * Register a parser. Throws if a parser with the same ID is already registered.
   */
  register(parser: ConversationParser): void {
    if (this.parsers.has(parser.id)) {
      throw new Error(`Parser with id "${parser.id}" is already registered`);
    }
    this.parsers.set(parser.id, parser);
  }

  /**
   * Get all registered parsers.
   */
  getAll(): ConversationParser[] {
    return [...this.parsers.values()];
  }

  /**
   * Get a parser by ID.
   */
  getById(id: string): ConversationParser | undefined {
    return this.parsers.get(id);
  }

  /**
   * Detect which parsers have data available on this machine.
   */
  detectAvailable(): ConversationParser[] {
    return this.getAll().filter((p) => p.detect());
  }
}
