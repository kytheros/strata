import { CONFIG } from "../config.js";
import type { ParsedSession } from "../parsers/session-parser.js";

export interface SessionChunk {
  text: string;
  role: "user" | "assistant" | "mixed";
  timestamp: number;
  toolNames: string[];
  messageIndex: number;
}

/**
 * Split a parsed session into word-grouped chunks at CONFIG.indexing.chunkSize.
 * Groups consecutive user→assistant turns into 'mixed' chunks; flushes on role
 * switches and when the chunk reaches chunkSize*1.5 words. This is the canonical
 * production chunker (AutoResearch chunking ceiling 25/25); shared by
 * IndexManager.chunkSession and the conversation-ingest write-path (#30).
 */
export function chunkSession(session: ParsedSession): SessionChunk[] {
  const chunks: SessionChunk[] = [];
  const { chunkSize, maxChunksPerSession } = CONFIG.indexing;

  let currentText = "";
  let currentRole: "user" | "assistant" | "mixed" | null = null;
  let currentTimestamp = 0;
  let currentToolNames: string[] = [];
  let currentMessageIndex = 0;

  const flush = () => {
    if (currentText.trim() && currentRole) {
      // Split if too long
      const words = currentText.split(/\s+/);
      for (let i = 0; i < words.length; i += chunkSize) {
        if (chunks.length >= maxChunksPerSession) return;
        chunks.push({
          text: words.slice(i, i + chunkSize).join(" "),
          role: currentRole,
          timestamp: currentTimestamp,
          toolNames: [...currentToolNames],
          messageIndex: currentMessageIndex,
        });
      }
    }
    currentText = "";
    currentRole = null;
    currentToolNames = [];
  };

  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i];

    // Group user+assistant exchanges together for better context
    if (currentRole && currentRole !== msg.role) {
      // If switching from user to assistant, keep them together
      if (currentRole === "user" && msg.role === "assistant") {
        currentRole = "mixed";
      } else {
        flush();
      }
    }

    if (!currentRole) {
      currentRole = msg.role;
      currentTimestamp = msg.timestamp
        ? new Date(msg.timestamp).getTime() || 0
        : 0;
      currentMessageIndex = i;
    }

    currentText += (currentText ? "\n" : "") + msg.text;
    if (msg.toolNames.length > 0) {
      currentToolNames.push(...msg.toolNames);
    }
    if (msg.toolInputSnippets.length > 0) {
      currentText += " " + msg.toolInputSnippets.join(" ");
    }

    // Flush if chunk is getting large
    const wordCount = currentText.split(/\s+/).length;
    if (wordCount >= chunkSize * 1.5) {
      flush();
    }
  }

  flush();
  return chunks;
}
