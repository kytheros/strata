/**
 * MCP tool handler: get_user_profile
 *
 * Returns a synthesized user profile computed from structural analysis
 * of stored knowledge, entities, sessions, and evidence gaps.
 * Zero LLM cost — pure SQL aggregations and threshold rules.
 */

import type { StorageContext } from "../storage/interfaces/index.js";
import {
  synthesizeProfile,
  formatProfile,
  type ProfileSynthesizerStores,
} from "../knowledge/profile-synthesizer.js";
import type Database from "better-sqlite3";

export async function handleGetUserProfile(
  storage: StorageContext,
  args: { project?: string; user?: string },
  db?: Database.Database,
): Promise<string> {
  const stores: ProfileSynthesizerStores = {
    knowledge: storage.knowledge,
    entities: storage.entities,
    summaries: storage.summaries,
    gapDb: db,
  };

  const profile = await synthesizeProfile(stores, {
    project: args.project,
    user: args.user,
  });

  return formatProfile(profile);
}
