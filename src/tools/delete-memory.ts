/**
 * delete_memory MCP tool handler.
 * Allows Claude to hard-delete a knowledge entry by ID.
 */

import type { IKnowledgeStore } from "../storage/interfaces/knowledge-store.js";

export interface DeleteMemoryArgs {
  id: string;
}

/**
 * Handle the delete_memory tool call.
 * Hard-deletes a knowledge entry. The deletion is recorded in knowledge_history.
 * Returns a confirmation string or error message (never throws).
 */
export async function handleDeleteMemory(
  knowledgeStore: IKnowledgeStore,
  args: DeleteMemoryArgs
): Promise<string> {
  const { id } = args;

  try {
    const deleted = await knowledgeStore.deleteEntry(id);
    if (!deleted) {
      return `Error: entry ${id} not found.`;
    }
    return `Deleted entry ${id}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error deleting entry ${id}: ${msg}`;
  }
}
