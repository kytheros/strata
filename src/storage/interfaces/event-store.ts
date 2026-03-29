/**
 * Event store interface for SVO (Subject-Verb-Object) event extraction.
 *
 * Events bridge vocabulary gaps in retrieval — a search for "fitness tracker"
 * will match an event where the user "bought Fitbit" because the alias
 * "purchased a wearable device" is indexed in FTS5.
 */

export interface SVOEvent {
  subject: string;
  verb: string;
  object: string;
  startDate: string | null;
  endDate: string | null;
  aliases: string[];
  category: string;
  sessionId: string;
  project: string;
  timestamp: number;
}

export interface IEventStore {
  addEvents(events: SVOEvent[], user?: string): Promise<number>;
  search(query: string, limit?: number): Promise<SVOEvent[]>;
  getBySession(sessionId: string): Promise<SVOEvent[]>;
  deleteBySession(sessionId: string): Promise<void>;
  getEventCount(): Promise<number>;
}
