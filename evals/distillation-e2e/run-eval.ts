#!/usr/bin/env tsx
import { applyIntegrityGate, resolveProvider } from "./lib/integrity-gate.js";
import { loadFixtures } from "./lib/fixture-loader.js";
import { parseArgs } from "node:util";

async function main(): Promise<number> {
  applyIntegrityGate();
  let provider;
  try { provider = resolveProvider(); } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  const { values } = parseArgs({
    options: {
      "fixtures-dir": { type: "string", default: "evals/distillation-e2e/fixtures" },
      decision: { type: "boolean", default: false },
    },
  });

  const fixtures = loadFixtures(values["fixtures-dir"]!);
  process.stdout.write(`loaded ${fixtures.length} fixtures from ${values["fixtures-dir"]}\n`);
  process.stdout.write(`provider: ${JSON.stringify(provider)}\n`);
  process.stdout.write(`N=${values.decision ? 3 : 1}\n`);
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(2);
});
