import { describe, it, expect } from "vitest";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { patchTemplate } from "../../src/cli/deploy.js";

// Resolve template directories relative to package root
function getPackageRoot(): string {
  // tests/cli/ -> package root is ../../
  return join(import.meta.dirname, "..", "..");
}

const cloudRunDir = join(getPackageRoot(), "templates", "gcp-cloud-run");
const cloudSqlDir = join(getPackageRoot(), "templates", "gcp-cloud-sql");

// ─── Tier A: Cloud Run + Litestream ───

describe("GCP Cloud Run + Litestream templates", () => {
  it("template directory exists", () => {
    expect(existsSync(cloudRunDir)).toBe(true);
  });

  it("contains Dockerfile.gcp", () => {
    expect(existsSync(join(cloudRunDir, "Dockerfile.gcp"))).toBe(true);
  });

  it("contains litestream.yml", () => {
    expect(existsSync(join(cloudRunDir, "litestream.yml"))).toBe(true);
  });

  it("contains entrypoint.sh", () => {
    expect(existsSync(join(cloudRunDir, "entrypoint.sh"))).toBe(true);
  });

  it("Dockerfile.gcp uses node:22-alpine base image", () => {
    const content = readFileSync(join(cloudRunDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("FROM node:22-alpine");
  });

  it("Dockerfile.gcp has multi-stage build", () => {
    const content = readFileSync(join(cloudRunDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("FROM node:22-alpine AS builder");
    // Second FROM for runtime stage
    const fromCount = (content.match(/^FROM /gm) || []).length;
    expect(fromCount).toBe(2);
  });

  it("Dockerfile.gcp installs litestream", () => {
    const content = readFileSync(join(cloudRunDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("litestream");
    expect(content).toContain("/usr/local/bin/");
  });

  it("Dockerfile.gcp exposes port 8080", () => {
    const content = readFileSync(join(cloudRunDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("EXPOSE 8080");
  });

  it("Dockerfile.gcp runs as non-root strata user", () => {
    const content = readFileSync(join(cloudRunDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("adduser -S strata");
    expect(content).toContain("USER strata");
  });

  it("Dockerfile.gcp sets STRATA_DATA_DIR", () => {
    const content = readFileSync(join(cloudRunDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("ENV STRATA_DATA_DIR=/tmp/strata");
  });

  it("litestream.yml contains GCS_BUCKET placeholder", () => {
    const content = readFileSync(join(cloudRunDir, "litestream.yml"), "utf-8");
    expect(content).toContain("{{GCS_BUCKET}}");
  });

  it("litestream.yml is valid YAML after patching", () => {
    const raw = readFileSync(join(cloudRunDir, "litestream.yml"), "utf-8");
    const patched = patchTemplate(raw, { GCS_BUCKET: "my-strata-backup" });
    expect(patched).toContain("bucket: my-strata-backup");
    expect(patched).not.toContain("{{");
    // Basic YAML structure: should have dbs key and replicas
    expect(patched).toContain("dbs:");
    expect(patched).toContain("replicas:");
    expect(patched).toContain("type: gcs");
  });

  it("entrypoint.sh has correct shebang", () => {
    const content = readFileSync(join(cloudRunDir, "entrypoint.sh"), "utf-8");
    expect(content.startsWith("#!/bin/sh")).toBe(true);
  });

  it("entrypoint.sh uses set -e for error handling", () => {
    const content = readFileSync(join(cloudRunDir, "entrypoint.sh"), "utf-8");
    expect(content).toContain("set -e");
  });

  it("entrypoint.sh restores from litestream", () => {
    const content = readFileSync(join(cloudRunDir, "entrypoint.sh"), "utf-8");
    expect(content).toContain("litestream restore");
    expect(content).toContain("-if-replica-exists");
  });

  it("entrypoint.sh starts litestream replicate in background", () => {
    const content = readFileSync(join(cloudRunDir, "entrypoint.sh"), "utf-8");
    expect(content).toContain("litestream replicate &");
  });

  it("entrypoint.sh starts strata serve", () => {
    const content = readFileSync(join(cloudRunDir, "entrypoint.sh"), "utf-8");
    expect(content).toContain("exec node dist/cli.js serve --port 8080");
  });
});

// ─── Tier B: Cloud Run + Cloud SQL ───

describe("GCP Cloud SQL templates", () => {
  it("template directory exists", () => {
    expect(existsSync(cloudSqlDir)).toBe(true);
  });

  it("contains Dockerfile.gcp", () => {
    expect(existsSync(join(cloudSqlDir, "Dockerfile.gcp"))).toBe(true);
  });

  it("contains cloud-run-service.yaml", () => {
    expect(existsSync(join(cloudSqlDir, "cloud-run-service.yaml"))).toBe(true);
  });

  it("Dockerfile.gcp uses node:22-alpine base image", () => {
    const content = readFileSync(join(cloudSqlDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("FROM node:22-alpine");
  });

  it("Dockerfile.gcp has multi-stage build", () => {
    const content = readFileSync(join(cloudSqlDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("FROM node:22-alpine AS builder");
    const fromCount = (content.match(/^FROM /gm) || []).length;
    expect(fromCount).toBe(2);
  });

  it("Dockerfile.gcp does NOT install litestream", () => {
    const content = readFileSync(join(cloudSqlDir, "Dockerfile.gcp"), "utf-8");
    expect(content).not.toContain("litestream");
  });

  it("Dockerfile.gcp exposes port 8080", () => {
    const content = readFileSync(join(cloudSqlDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("EXPOSE 8080");
  });

  it("Dockerfile.gcp runs as non-root strata user", () => {
    const content = readFileSync(join(cloudSqlDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("adduser -S strata");
    expect(content).toContain("USER strata");
  });

  it("Dockerfile.gcp uses --multi-tenant flag", () => {
    const content = readFileSync(join(cloudSqlDir, "Dockerfile.gcp"), "utf-8");
    expect(content).toContain("--multi-tenant");
  });

  it("cloud-run-service.yaml contains required placeholders", () => {
    const content = readFileSync(join(cloudSqlDir, "cloud-run-service.yaml"), "utf-8");
    expect(content).toContain("{{SERVICE_NAME}}");
    expect(content).toContain("{{MAX_INSTANCES}}");
    expect(content).toContain("{{CLOUD_SQL_CONNECTION}}");
    expect(content).toContain("{{IMAGE_URL}}");
  });

  it("cloud-run-service.yaml patches correctly", () => {
    const raw = readFileSync(join(cloudSqlDir, "cloud-run-service.yaml"), "utf-8");
    const patched = patchTemplate(raw, {
      SERVICE_NAME: "strata-mcp",
      MAX_INSTANCES: "10",
      CLOUD_SQL_CONNECTION: "my-project:us-central1:strata-db",
      IMAGE_URL: "us-central1-docker.pkg.dev/my-project/strata-images/strata:latest",
    });
    expect(patched).toContain("name: strata-mcp");
    expect(patched).toContain('maxScale: "10"');
    expect(patched).toContain("my-project:us-central1:strata-db");
    expect(patched).not.toContain("{{");
  });

  it("cloud-run-service.yaml configures CPU always-on", () => {
    const content = readFileSync(join(cloudSqlDir, "cloud-run-service.yaml"), "utf-8");
    expect(content).toContain('run.googleapis.com/cpu-throttling: "false"');
  });

  it("cloud-run-service.yaml sets containerPort 8080", () => {
    const content = readFileSync(join(cloudSqlDir, "cloud-run-service.yaml"), "utf-8");
    expect(content).toContain("containerPort: 8080");
  });

  it("cloud-run-service.yaml references secrets", () => {
    const content = readFileSync(join(cloudSqlDir, "cloud-run-service.yaml"), "utf-8");
    expect(content).toContain("database-url");
    expect(content).toContain("gemini-api-key");
    expect(content).toContain("secretKeyRef");
  });
});

// ─── Shared patchTemplate tests with GCP-specific placeholders ───

describe("patchTemplate with GCP placeholders", () => {
  it("replaces all GCP-specific placeholders", () => {
    const tmpl = "bucket: {{GCS_BUCKET}}\nservice: {{SERVICE_NAME}}\nimage: {{IMAGE_URL}}";
    const result = patchTemplate(tmpl, {
      GCS_BUCKET: "strata-backup-my-project",
      SERVICE_NAME: "strata-mcp",
      IMAGE_URL: "us-central1-docker.pkg.dev/proj/repo/strata:latest",
    });
    expect(result).toBe(
      "bucket: strata-backup-my-project\nservice: strata-mcp\nimage: us-central1-docker.pkg.dev/proj/repo/strata:latest"
    );
    expect(result).not.toContain("{{");
  });

  it("handles multiple occurrences of the same placeholder", () => {
    const tmpl = "{{SERVICE_NAME}} runs on {{SERVICE_NAME}}";
    const result = patchTemplate(tmpl, { SERVICE_NAME: "strata-mcp" });
    expect(result).toBe("strata-mcp runs on strata-mcp");
  });

  it("leaves unmatched placeholders intact", () => {
    const tmpl = "bucket: {{GCS_BUCKET}}\nother: {{UNKNOWN}}";
    const result = patchTemplate(tmpl, { GCS_BUCKET: "my-bucket" });
    expect(result).toContain("bucket: my-bucket");
    expect(result).toContain("{{UNKNOWN}}");
  });
});
