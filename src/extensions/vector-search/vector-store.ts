/** Community edition stub — vector search requires strata-pro. */
export class VectorStore {
  constructor(_db: unknown, _dimensions: number, _modelName: string) {
    throw new Error("Vector search requires @kytheros/strata-pro");
  }
  hasVector(_id: string): boolean { return false; }
}
