/**
 * `strata deploy gcp` — deploys Strata to Google Cloud Platform.
 *
 * Two modes:
 *   - Single-user: Cloud Run + Litestream (SQLite) — default
 *   - Multi-tenant: Cloud Run + Cloud SQL (Postgres) — --multi-tenant flag
 *
 * Uses Node.js readline for interactive prompts (no external dependencies).
 * Shells out to `gcloud` for GCP operations.
 * Uses native fetch for any API calls (no axios/got per monorepo policy).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { patchTemplate, detectTier, generateGatewayToken } from "./deploy.js";

// ─── Helpers (exported for testing) ───

/** Find the templates/gcp-cloud-run or templates/gcp-cloud-sql directory relative to this module. */
export function resolveGcpTemplateDir(mode: "cloud-run" | "cloud-sql"): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  // On Windows, URL pathname starts with /C:/... — strip leading slash
  if (process.platform === "win32" && dir.startsWith("/")) {
    dir = dir.slice(1);
  }
  // Walk up from src/cli/ or dist/cli/ to package root
  const pkgRoot = join(dir, "..", "..");
  const templateDir = join(pkgRoot, "templates", `gcp-${mode}`);
  if (!existsSync(templateDir)) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }
  return templateDir;
}

/** Prompt user for input with a default value. */
function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue?: string
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/** Prompt user to select from numbered choices. Returns 0-based index. */
export function promptChoice(
  rl: ReturnType<typeof createInterface>,
  question: string,
  choices: string[]
): Promise<number> {
  return new Promise((resolve) => {
    console.log(`  ${question}:`);
    for (let i = 0; i < choices.length; i++) {
      console.log(`    ${i + 1}) ${choices[i]}`);
    }
    rl.question("  Choice: ", (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(idx);
      } else {
        resolve(0); // Default to first choice
      }
    });
  });
}

/** Check that gcloud is installed and authenticated. */
export function checkPrerequisites(): { projectId: string; region: string; email: string } {
  // Check gcloud exists
  try {
    execSync("gcloud --version", { stdio: "pipe", timeout: 15_000 });
  } catch {
    throw new Error(
      "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
    );
  }

  // Check authentication
  let email = "";
  try {
    email = execSync("gcloud config get-value account", {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    if (!email || email === "(unset)") {
      throw new Error("not authenticated");
    }
  } catch {
    throw new Error("Not authenticated. Run: gcloud auth login");
  }

  // Get current project
  let projectId = "";
  try {
    projectId = execSync("gcloud config get-value project", {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    if (projectId === "(unset)") projectId = "";
  } catch {
    // Project not set — user will be prompted
  }

  return { projectId, region: "us-central1", email };
}

/** Enable GCP APIs. */
export function enableApis(projectId: string, apis: string[]): void {
  const apiList = apis.join(" ");
  console.log("  Enabling APIs...");
  try {
    execSync(`gcloud services enable ${apiList} --project=${projectId}`, {
      stdio: "pipe",
      timeout: 120_000,
    });
    console.log(`  \u2713 APIs enabled: ${apis.length} services`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to enable APIs: ${msg}`);
  }
}

/** Read Polar license key from ~/.strata/polar.key. */
function readPolarKey(): string | null {
  const p = join(homedir(), ".strata", "polar.key");
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8").trim() || null;
}

/** Read Gemini key from config or return empty string. */
function readGeminiKey(): string {
  try {
    const configPath = join(homedir(), ".strata", "config.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.geminiApiKey) return cfg.geminiApiKey;
    }
  } catch { /* */ }
  return "";
}

// ─── Tier A: Cloud Run + Litestream (SQLite) ───

export async function deployCloudRun(
  projectId: string,
  region: string,
  tier: string,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const polarKey = readPolarKey();

  // Step 1: Enable APIs
  enableApis(projectId, [
    "run.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbuild.googleapis.com",
  ]);

  // Step 2: Create GCS bucket for Litestream backups
  const bucketName = `strata-backup-${projectId}`;
  console.log("\n  Creating GCS bucket for backups...");
  try {
    execSync(
      `gcloud storage buckets create gs://${bucketName} --location=${region} --project=${projectId}`,
      { stdio: "pipe", timeout: 30_000 }
    );
    console.log(`  \u2713 Bucket: gs://${bucketName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("409")) {
      console.log(`  \u2713 Bucket gs://${bucketName} already exists`);
    } else {
      console.log(`  \u2717 Bucket creation failed: ${msg}`);
      console.log(`    Create manually: gcloud storage buckets create gs://${bucketName} --location=${region}`);
    }
  }

  // Step 3: Create Artifact Registry
  console.log("\n  Creating Artifact Registry...");
  try {
    execSync(
      `gcloud artifacts repositories create strata-images --repository-format=docker --location=${region} --project=${projectId}`,
      { stdio: "pipe", timeout: 30_000 }
    );
    console.log("  \u2713 Artifact Registry: strata-images");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("409")) {
      console.log("  \u2713 Artifact Registry strata-images already exists");
    } else {
      console.log(`  \u2717 Artifact Registry creation failed: ${msg}`);
    }
  }

  // Step 4: Scaffold project with patched templates
  const outDir = "./strata-gcp";
  console.log(`\n  Scaffolding project in ${outDir}/...`);
  mkdirSync(outDir, { recursive: true });

  const templateDir = resolveGcpTemplateDir("cloud-run");

  // Copy and patch litestream.yml
  const litestreamTmpl = readFileSync(join(templateDir, "litestream.yml"), "utf-8");
  writeFileSync(
    join(outDir, "litestream.yml"),
    patchTemplate(litestreamTmpl, { GCS_BUCKET: bucketName })
  );

  // Copy Dockerfile and entrypoint
  copyFileSync(join(templateDir, "Dockerfile.gcp"), join(outDir, "Dockerfile"));
  copyFileSync(join(templateDir, "entrypoint.sh"), join(outDir, "entrypoint.sh"));

  console.log("  \u2713 Dockerfile");
  console.log("  \u2713 litestream.yml");
  console.log("  \u2713 entrypoint.sh");

  // Step 5: Build via Cloud Build
  const imageUrl = `${region}-docker.pkg.dev/${projectId}/strata-images/strata:latest`;
  console.log("\n  Building container image via Cloud Build...");
  try {
    execSync(
      `gcloud builds submit --tag ${imageUrl} --project=${projectId}`,
      { cwd: outDir, stdio: "pipe", timeout: 300_000 }
    );
    console.log(`  \u2713 Image: ${imageUrl}`);
  } catch (err) {
    console.log("  \u2717 Cloud Build failed. Run manually:");
    console.log(`    cd ${outDir} && gcloud builds submit --tag ${imageUrl}`);
    console.log("    " + (err instanceof Error ? err.message : String(err)));
  }

  // Step 6: Set secrets
  console.log("\n  Setting secrets...");
  const geminiKey = readGeminiKey() || await prompt(rl, "Gemini API key (optional, Enter to skip)");
  const gatewayToken = generateGatewayToken();

  const secrets: [string, string][] = [
    ["strata-gateway-token", gatewayToken],
  ];
  if (geminiKey) secrets.push(["gemini-api-key", geminiKey]);
  if (tier !== "community" && polarKey) secrets.push(["polar-license-key", polarKey]);

  for (const [name, value] of secrets) {
    try {
      execSync(
        `echo -n "${value}" | gcloud secrets create ${name} --data-file=- --project=${projectId}`,
        { stdio: "pipe", timeout: 15_000 }
      );
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") || msg.includes("409")) {
        // Update existing secret
        try {
          execSync(
            `echo -n "${value}" | gcloud secrets versions add ${name} --data-file=- --project=${projectId}`,
            { stdio: "pipe", timeout: 15_000 }
          );
          console.log(`  \u2713 ${name} (updated)`);
        } catch {
          console.log(`  \u2717 ${name} -- set manually via Secret Manager`);
        }
      } else {
        console.log(`  \u2717 ${name} -- set manually via Secret Manager`);
      }
    }
  }

  // Step 7: Deploy Cloud Run service
  console.log("\n  Deploying Cloud Run service...");
  const secretFlags = secrets
    .map(([name]) => `${name.toUpperCase().replace(/-/g, "_")}=${name}:latest`)
    .join(",");

  let serviceUrl = "";
  try {
    const output = execSync(
      [
        "gcloud run deploy strata-mcp",
        `--image=${imageUrl}`,
        `--region=${region}`,
        `--project=${projectId}`,
        "--min-instances=1",
        "--max-instances=1",
        "--cpu=1",
        "--memory=512Mi",
        "--cpu-boost",
        "--allow-unauthenticated",
        "--timeout=3600",
        `--set-secrets=${secretFlags}`,
      ].join(" "),
      { encoding: "utf-8", stdio: "pipe", timeout: 120_000 }
    );
    const urlMatch = output.match(/https:\/\/[^\s]+/);
    if (urlMatch) serviceUrl = urlMatch[0];
    console.log(`  \u2713 Deployed to ${serviceUrl || "(check gcloud output)"}`);
  } catch (err) {
    console.log("  \u2717 Deploy failed. Run manually:");
    console.log(`    gcloud run deploy strata-mcp --image=${imageUrl} --region=${region}`);
    console.log("    " + (err instanceof Error ? err.message : String(err)));
  }

  // Step 8: Print summary
  const endpoint = serviceUrl
    ? `${serviceUrl}/mcp`
    : `https://strata-mcp-HASH-${region.split("-")[0]}.a.run.app/mcp`;

  printSummary(endpoint, gatewayToken, false);
}

// ─── Tier B: Cloud Run + Cloud SQL (Postgres) ───

export async function deployCloudSql(
  projectId: string,
  region: string,
  tier: string,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const polarKey = readPolarKey();

  // Step 1: Enable APIs
  enableApis(projectId, [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbuild.googleapis.com",
  ]);

  // Step 2: Create Cloud SQL instance
  console.log("\n  Creating Cloud SQL instance (this may take a few minutes)...");
  try {
    execSync(
      [
        "gcloud sql instances create strata-db",
        "--database-version=POSTGRES_17",
        "--tier=db-f1-micro",
        `--region=${region}`,
        `--project=${projectId}`,
      ].join(" "),
      { stdio: "pipe", timeout: 600_000 }
    );
    console.log("  \u2713 Cloud SQL instance: strata-db");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("409")) {
      console.log("  \u2713 Cloud SQL instance strata-db already exists");
    } else {
      console.log(`  \u2717 Cloud SQL creation failed: ${msg}`);
      console.log("    Create manually: gcloud sql instances create strata-db --database-version=POSTGRES_17 --tier=db-f1-micro");
    }
  }

  // Step 3: Create database
  console.log("\n  Creating database...");
  try {
    execSync(
      `gcloud sql databases create strata --instance=strata-db --project=${projectId}`,
      { stdio: "pipe", timeout: 30_000 }
    );
    console.log("  \u2713 Database: strata");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("409")) {
      console.log("  \u2713 Database strata already exists");
    } else {
      console.log(`  \u2717 Database creation failed: ${msg}`);
    }
  }

  // Step 4: Set root password and create user
  const dbPassword = generateGatewayToken().slice(0, 32);
  console.log("\n  Configuring database user...");
  try {
    execSync(
      `gcloud sql users set-password postgres --instance=strata-db --password="${dbPassword}" --project=${projectId}`,
      { stdio: "pipe", timeout: 30_000 }
    );
    console.log("  \u2713 Database user configured");
  } catch (err) {
    console.log("  \u2717 User configuration failed: " + (err instanceof Error ? err.message : String(err)));
  }

  // Step 5: Get connection name
  let connectionName = "";
  try {
    connectionName = execSync(
      `gcloud sql instances describe strata-db --format="value(connectionName)" --project=${projectId}`,
      { encoding: "utf-8", stdio: "pipe", timeout: 15_000 }
    ).trim();
    console.log(`  \u2713 Connection: ${connectionName}`);
  } catch (err) {
    console.log("  \u2717 Could not get connection name: " + (err instanceof Error ? err.message : String(err)));
    connectionName = `${projectId}:${region}:strata-db`;
  }

  const databaseUrl = `postgresql://postgres:${dbPassword}@/strata?host=/cloudsql/${connectionName}`;

  // Step 6: Create Artifact Registry
  console.log("\n  Creating Artifact Registry...");
  try {
    execSync(
      `gcloud artifacts repositories create strata-images --repository-format=docker --location=${region} --project=${projectId}`,
      { stdio: "pipe", timeout: 30_000 }
    );
    console.log("  \u2713 Artifact Registry: strata-images");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("409")) {
      console.log("  \u2713 Artifact Registry strata-images already exists");
    } else {
      console.log(`  \u2717 Artifact Registry creation failed: ${msg}`);
    }
  }

  // Step 7: Scaffold project with templates
  const outDir = "./strata-gcp";
  console.log(`\n  Scaffolding project in ${outDir}/...`);
  mkdirSync(outDir, { recursive: true });

  const templateDir = resolveGcpTemplateDir("cloud-sql");

  // Copy Dockerfile
  copyFileSync(join(templateDir, "Dockerfile.gcp"), join(outDir, "Dockerfile"));

  // Patch and write service manifest
  const serviceTmpl = readFileSync(join(templateDir, "cloud-run-service.yaml"), "utf-8");
  const imageUrl = `${region}-docker.pkg.dev/${projectId}/strata-images/strata:latest`;
  writeFileSync(
    join(outDir, "cloud-run-service.yaml"),
    patchTemplate(serviceTmpl, {
      SERVICE_NAME: "strata-mcp",
      MAX_INSTANCES: "10",
      CLOUD_SQL_CONNECTION: connectionName,
      IMAGE_URL: imageUrl,
    })
  );

  console.log("  \u2713 Dockerfile");
  console.log("  \u2713 cloud-run-service.yaml");

  // Step 8: Build via Cloud Build
  console.log("\n  Building container image via Cloud Build...");
  try {
    execSync(
      `gcloud builds submit --tag ${imageUrl} --project=${projectId}`,
      { cwd: outDir, stdio: "pipe", timeout: 300_000 }
    );
    console.log(`  \u2713 Image: ${imageUrl}`);
  } catch (err) {
    console.log("  \u2717 Cloud Build failed. Run manually:");
    console.log(`    cd ${outDir} && gcloud builds submit --tag ${imageUrl}`);
    console.log("    " + (err instanceof Error ? err.message : String(err)));
  }

  // Step 9: Set secrets
  console.log("\n  Setting secrets...");
  const geminiKey = readGeminiKey() || await prompt(rl, "Gemini API key (optional, Enter to skip)");
  const gatewayToken = generateGatewayToken();

  const secrets: [string, string][] = [
    ["database-url", databaseUrl],
    ["strata-gateway-token", gatewayToken],
  ];
  if (geminiKey) secrets.push(["gemini-api-key", geminiKey]);
  if (tier !== "community" && polarKey) secrets.push(["polar-license-key", polarKey]);

  for (const [name, value] of secrets) {
    try {
      execSync(
        `echo -n "${value}" | gcloud secrets create ${name} --data-file=- --project=${projectId}`,
        { stdio: "pipe", timeout: 15_000 }
      );
      console.log(`  \u2713 ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") || msg.includes("409")) {
        try {
          execSync(
            `echo -n "${value}" | gcloud secrets versions add ${name} --data-file=- --project=${projectId}`,
            { stdio: "pipe", timeout: 15_000 }
          );
          console.log(`  \u2713 ${name} (updated)`);
        } catch {
          console.log(`  \u2717 ${name} -- set manually via Secret Manager`);
        }
      } else {
        console.log(`  \u2717 ${name} -- set manually via Secret Manager`);
      }
    }
  }

  // Step 10: Deploy Cloud Run service with Cloud SQL Auth Proxy
  console.log("\n  Deploying Cloud Run service...");
  const secretFlags = secrets
    .map(([name]) => `${name.toUpperCase().replace(/-/g, "_")}=${name}:latest`)
    .join(",");

  let serviceUrl = "";
  try {
    const output = execSync(
      [
        "gcloud run deploy strata-mcp",
        `--image=${imageUrl}`,
        `--region=${region}`,
        `--project=${projectId}`,
        "--min-instances=1",
        "--max-instances=10",
        "--cpu=2",
        "--memory=1Gi",
        "--cpu-boost",
        "--allow-unauthenticated",
        "--timeout=3600",
        `--add-cloudsql-instances=${connectionName}`,
        `--set-secrets=${secretFlags}`,
      ].join(" "),
      { encoding: "utf-8", stdio: "pipe", timeout: 120_000 }
    );
    const urlMatch = output.match(/https:\/\/[^\s]+/);
    if (urlMatch) serviceUrl = urlMatch[0];
    console.log(`  \u2713 Deployed to ${serviceUrl || "(check gcloud output)"}`);
  } catch (err) {
    console.log("  \u2717 Deploy failed. Run manually:");
    console.log(`    gcloud run deploy strata-mcp --image=${imageUrl} --region=${region} --add-cloudsql-instances=${connectionName}`);
    console.log("    " + (err instanceof Error ? err.message : String(err)));
  }

  // Step 11: Print summary
  const endpoint = serviceUrl
    ? `${serviceUrl}/strata/{userId}/mcp`
    : `https://strata-mcp-HASH-${region.split("-")[0]}.a.run.app/strata/{userId}/mcp`;

  printSummary(endpoint, gatewayToken, true);
}

// ─── Summary printer ───

function printSummary(
  endpoint: string,
  gatewayToken: string,
  multiTenant: boolean
): void {
  console.log("\n  " + "\u2550".repeat(50));
  console.log(`\n  Your Strata MCP endpoint:`);
  console.log(`  ${endpoint}\n`);

  if (multiTenant) {
    console.log("  Multi-tenant mode: each user gets an isolated namespace.");
    console.log("  Replace {userId} with the user's UUID.\n");
  }

  console.log("  Add to Claude Code (~/.claude.json):");
  console.log("  {");
  console.log('    "mcpServers": {');
  console.log('      "strata": {');
  console.log('        "type": "url",');
  console.log(`        "url": "${endpoint}",`);
  console.log('        "headers": {');
  console.log(`          "Authorization": "Bearer ${gatewayToken}"`);
  console.log("        }");
  console.log("      }");
  console.log("    }");
  console.log("  }\n");
}

// ─── Main entry point ───

export async function deployGcp(
  args: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const multiTenant = args.includes("--multi-tenant") || flags["multi-tenant"] === true;

  console.log("\n  Strata \u2192 Google Cloud Platform");
  console.log("  " + "\u2500".repeat(34) + "\n");

  // Detect tier
  const tier = detectTier();
  const polarKey = readPolarKey();
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  console.log(`  Detected tier: ${tierLabel}${polarKey ? ` (key: ...${polarKey.slice(-4)})` : ""}`);

  // Check prerequisites
  let prereqs: { projectId: string; region: string; email: string };
  try {
    prereqs = checkPrerequisites();
  } catch (err) {
    console.log(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  console.log(`  Authenticated as: ${prereqs.email}\n`);

  // Interactive prompts
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const projectId =
    (flags["project"] as string) ||
    await prompt(rl, "GCP project ID", prereqs.projectId);
  if (!projectId) {
    console.log("\n  Error: GCP project ID is required.");
    rl.close();
    process.exit(1);
  }

  const region =
    (flags["region"] as string) ||
    await prompt(rl, "Region", prereqs.region || "us-central1");

  if (multiTenant) {
    await deployCloudSql(projectId, region, tier, rl);
  } else {
    // Prompt for mode choice
    const choice = await promptChoice(rl, "Deployment mode", [
      "Single-user (Cloud Run + Litestream)     [$40-65/mo]",
      "Multi-tenant (Cloud Run + Cloud SQL)      [$90+/mo]",
    ]);

    if (choice === 0) {
      await deployCloudRun(projectId, region, tier, rl);
    } else {
      await deployCloudSql(projectId, region, tier, rl);
    }
  }

  rl.close();
}
