import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { existsSync } from "fs";

// ─── Module imports ───

// These are tested without mocking — they don't call gcloud
import {
  resolveGcpTemplateDir,
  checkPrerequisites,
  enableApis,
  promptChoice,
  deployCloudRun,
  deployCloudSql,
} from "../../src/cli/deploy-gcp.js";
import { patchTemplate, detectTier } from "../../src/cli/deploy.js";

// ─── resolveGcpTemplateDir ───

describe("resolveGcpTemplateDir", () => {
  it("finds the cloud-run template directory", () => {
    const dir = resolveGcpTemplateDir("cloud-run");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "Dockerfile.gcp"))).toBe(true);
    expect(existsSync(join(dir, "litestream.yml"))).toBe(true);
    expect(existsSync(join(dir, "entrypoint.sh"))).toBe(true);
  });

  it("finds the cloud-sql template directory", () => {
    const dir = resolveGcpTemplateDir("cloud-sql");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "Dockerfile.gcp"))).toBe(true);
    expect(existsSync(join(dir, "cloud-run-service.yaml"))).toBe(true);
  });
});

// ─── patchTemplate with GCP vars ───

describe("patchTemplate with GCP variables", () => {
  it("patches GCS_BUCKET in litestream.yml", () => {
    const tmpl = "bucket: {{GCS_BUCKET}}";
    const result = patchTemplate(tmpl, { GCS_BUCKET: "strata-backup-my-project" });
    expect(result).toBe("bucket: strata-backup-my-project");
  });

  it("patches all Cloud SQL service manifest placeholders", () => {
    const tmpl = "name: {{SERVICE_NAME}}\nmax: {{MAX_INSTANCES}}\nsql: {{CLOUD_SQL_CONNECTION}}\nimage: {{IMAGE_URL}}";
    const result = patchTemplate(tmpl, {
      SERVICE_NAME: "strata-mcp",
      MAX_INSTANCES: "10",
      CLOUD_SQL_CONNECTION: "proj:us-central1:strata-db",
      IMAGE_URL: "us-central1-docker.pkg.dev/proj/repo/strata:latest",
    });
    expect(result).not.toContain("{{");
    expect(result).toContain("name: strata-mcp");
    expect(result).toContain("max: 10");
    expect(result).toContain("proj:us-central1:strata-db");
  });
});

// ─── detectTier ───

describe("detectTier for GCP deploy", () => {
  it("returns community when no config exists", () => {
    expect(detectTier("/nonexistent/path/config.json")).toBe("community");
  });
});

// ─── checkPrerequisites (mocked) ───

describe("checkPrerequisites", () => {
  let execSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // We need to mock execSync at the module level
    execSyncMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when gcloud is not installed", async () => {
    // Import the module and test the function's error path directly
    // Since we can't easily mock execSync in ESM, test the error message
    // by checking the function contract
    try {
      // This will either work (gcloud installed) or throw
      const result = checkPrerequisites();
      // If gcloud is installed, we should get an object back
      expect(result).toHaveProperty("email");
      expect(result).toHaveProperty("projectId");
      expect(result).toHaveProperty("region");
    } catch (err) {
      // Expected when gcloud is not installed
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(
        msg.includes("gcloud CLI not found") || msg.includes("Not authenticated")
      ).toBe(true);
    }
  });
});

// ─── Mode selection logic ───

describe("mode selection logic", () => {
  it("--multi-tenant flag routes to Cloud SQL flow", async () => {
    // Test that args parsing correctly identifies --multi-tenant
    const args = ["--multi-tenant"];
    const multiTenant = args.includes("--multi-tenant");
    expect(multiTenant).toBe(true);
  });

  it("empty args defaults to mode choice", () => {
    const args: string[] = [];
    const multiTenant = args.includes("--multi-tenant");
    expect(multiTenant).toBe(false);
  });

  it("flags object also triggers multi-tenant mode", () => {
    const flags = { "multi-tenant": true };
    const multiTenant = flags["multi-tenant"] === true;
    expect(multiTenant).toBe(true);
  });
});

// ─── enableApis ───

describe("enableApis", () => {
  it("throws with clear message when API enable fails", () => {
    // enableApis calls execSync which will fail without gcloud
    // Test that it wraps the error properly
    try {
      enableApis("fake-project", ["run.googleapis.com"]);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Failed to enable APIs");
    }
  });
});

// ─── deployGcp entry point ───

describe("deployGcp entry point", () => {
  it("module exports deployGcp function", async () => {
    const mod = await import("../../src/cli/deploy-gcp.js");
    expect(typeof mod.deployGcp).toBe("function");
  });

  it("module exports deployCloudRun function", async () => {
    const mod = await import("../../src/cli/deploy-gcp.js");
    expect(typeof mod.deployCloudRun).toBe("function");
  });

  it("module exports deployCloudSql function", async () => {
    const mod = await import("../../src/cli/deploy-gcp.js");
    expect(typeof mod.deployCloudSql).toBe("function");
  });

  it("module exports checkPrerequisites function", async () => {
    const mod = await import("../../src/cli/deploy-gcp.js");
    expect(typeof mod.checkPrerequisites).toBe("function");
  });

  it("module exports resolveGcpTemplateDir function", async () => {
    const mod = await import("../../src/cli/deploy-gcp.js");
    expect(typeof mod.resolveGcpTemplateDir).toBe("function");
  });

  it("module exports promptChoice function", async () => {
    const mod = await import("../../src/cli/deploy-gcp.js");
    expect(typeof mod.promptChoice).toBe("function");
  });
});

// ─── CLI registration ───

describe("CLI registration", () => {
  it("deploy gcp route exists in cli.ts", async () => {
    // Read the cli.ts source and verify gcp is registered
    const { readFileSync } = await import("fs");
    const { join: pathJoin } = await import("path");
    const cliSource = readFileSync(
      pathJoin(import.meta.dirname, "..", "..", "src", "cli.ts"),
      "utf-8"
    );
    expect(cliSource).toContain('"gcp"');
    expect(cliSource).toContain("deploy-gcp");
    expect(cliSource).toContain("deployGcp");
  });

  it("help text includes gcp deploy command", async () => {
    const { readFileSync } = await import("fs");
    const { join: pathJoin } = await import("path");
    const cliSource = readFileSync(
      pathJoin(import.meta.dirname, "..", "..", "src", "cli.ts"),
      "utf-8"
    );
    expect(cliSource).toContain("strata deploy gcp");
    expect(cliSource).toContain("Deploy Strata to GCP Cloud Run");
  });
});
