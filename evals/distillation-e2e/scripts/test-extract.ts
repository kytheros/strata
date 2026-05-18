import { getExtractionProvider } from "../../../src/extensions/llm-extraction/provider-factory.js";
import { extractAtomicFacts } from "../../../src/extensions/llm-extraction/utterance-extractor.js";
import { applyHedgeFilter } from "../../../src/extensions/llm-extraction/hedge-filter.js";

async function main() {
  const provider = await getExtractionProvider();
  console.log("provider:", provider?.constructor.name);
  if (!provider) { console.log("NO PROVIDER"); return; }
  const text = "I migrated from axios to native fetch yesterday.";
  console.log("Input:", text);
  try {
    const facts = await extractAtomicFacts(text, { provider, maxItems: 5 });
    console.log("Raw facts:", JSON.stringify(facts, null, 2));
    const filtered = applyHedgeFilter(facts, text);
    console.log("After hedge filter:", JSON.stringify(filtered, null, 2));
  } catch (e) {
    console.error("EXTRACTION THREW:", (e as Error).stack ?? e);
  }
}
main();
