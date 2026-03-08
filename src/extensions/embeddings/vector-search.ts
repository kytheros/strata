/** Type stub for community edition — actual implementation is in strata-pro. */
export interface VectorSearchResult {
  entryId: string;
  score: number;
  text: string;
  project: string;
  timestamp: number;
}

export interface VectorSearch {
  search(queryVec: Float32Array, project: string, limit: number): VectorSearchResult[];
}
