import { describe, it, expect } from "vitest";
import { resolveTemplateDir, patchTemplate, generateGatewayToken, detectTier } from "../../src/cli/deploy.js";
import { join } from "path";
import { existsSync } from "fs";

describe("deploy helpers", () => {
  it("resolveTemplateDir finds the templates directory", () => {
    const dir = resolveTemplateDir();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(dir, "src", "index.community.ts"))).toBe(true);
  });

  it("patchTemplate replaces all placeholders", () => {
    const tmpl = "name = {{WORKER_NAME}}\ndb = {{DB_NAME}}\nid = {{DB_ID}}";
    const result = patchTemplate(tmpl, {
      WORKER_NAME: "my-strata",
      DB_NAME: "strata-db",
      DB_ID: "abc-123",
    });
    expect(result).toBe("name = my-strata\ndb = strata-db\nid = abc-123");
    expect(result).not.toContain("{{");
  });

  it("generateGatewayToken returns a 64-char hex string", () => {
    const token = generateGatewayToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detectTier returns community when no config exists", () => {
    const tier = detectTier("/nonexistent/path/config.json");
    expect(tier).toBe("community");
  });
});
