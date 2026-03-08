import { describe, it, expect } from "vitest";
import {
  extractProcedures,
  parseProcedureDetails,
} from "../../src/knowledge/procedure-extractor.js";
import type { ParsedSession } from "../../src/parsers/session-parser.js";

function makeSession(
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    toolNames?: string[];
  }>
): ParsedSession {
  return {
    sessionId: "test-session",
    project: "test-project",
    cwd: "/test",
    gitBranch: "main",
    messages: messages.map((m, i) => ({
      role: m.role,
      text: m.text,
      toolNames: m.toolNames ?? [],
      toolInputSnippets: [],
      hasCode: false,
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      uuid: `msg-${i}`,
    })),
    startTime: Date.now(),
    endTime: Date.now() + 10000,
    tool: "claude-code",
  } as ParsedSession;
}

describe("parseProcedureDetails", () => {
  it("returns valid ProcedureDetails on well-formed JSON", () => {
    const result = parseProcedureDetails(
      JSON.stringify({ steps: ["step 1", "step 2"] })
    );
    expect(result).toEqual({ steps: ["step 1", "step 2"] });
  });

  it("returns null on malformed JSON", () => {
    expect(parseProcedureDetails("not json")).toBeNull();
  });

  it("returns null when steps is missing", () => {
    expect(parseProcedureDetails(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null when steps has fewer than 2 items", () => {
    expect(
      parseProcedureDetails(JSON.stringify({ steps: ["only one"] }))
    ).toBeNull();
  });

  it("returns null when steps contains non-strings", () => {
    expect(
      parseProcedureDetails(JSON.stringify({ steps: [1, 2, 3] }))
    ).toBeNull();
  });

  it("parses optional prerequisites and warnings", () => {
    const result = parseProcedureDetails(
      JSON.stringify({
        steps: ["a", "b"],
        prerequisites: ["prereq"],
        warnings: ["warn"],
      })
    );
    expect(result).toEqual({
      steps: ["a", "b"],
      prerequisites: ["prereq"],
      warnings: ["warn"],
    });
  });
});

describe("extractProcedures", () => {
  it("returns empty array for empty session", () => {
    const session = makeSession([]);
    expect(extractProcedures(session)).toEqual([]);
  });

  it("extracts numbered list from assistant message", () => {
    const session = makeSession([
      {
        role: "assistant",
        text: `Here's how to deploy to Cloud Run:
1. Build the Docker image with docker build -t myapp .
2. Push to Artifact Registry with docker push
3. Deploy with gcloud run deploy myapp`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("procedure");
    expect(entries[0].summary).toContain("deploy to Cloud Run");

    const details = parseProcedureDetails(entries[0].details);
    expect(details).not.toBeNull();
    expect(details!.steps).toHaveLength(3);
    expect(details!.steps[0]).toContain("Docker image");
  });

  it("extracts step headers (Step 1: Step 2:)", () => {
    const session = makeSession([
      {
        role: "assistant",
        text: `Database migration process:
Step 1: Run the migration script
Step 2: Verify the schema changes
Step 3: Update the seed data`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries.length).toBe(1);

    const details = parseProcedureDetails(entries[0].details);
    expect(details!.steps).toHaveLength(3);
  });

  it("extracts ordinal flow (first...then...finally)", () => {
    const session = makeSession([
      {
        role: "assistant",
        text: `Setting up the dev environment:
First, install Node.js and npm from the official website.
Then, clone the repository from GitHub using git clone.
Next, run npm install to get all dependencies ready.
Finally, start the dev server with npm run dev to verify everything works.`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries.length).toBe(1);

    const details = parseProcedureDetails(entries[0].details);
    expect(details!.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("does not extract from user messages", () => {
    const session = makeSession([
      {
        role: "user",
        text: `1. Do this first
2. Then do this
3. Finally do that`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries).toHaveLength(0);
  });

  it("does not extract single-step lists", () => {
    const session = makeSession([
      {
        role: "assistant",
        text: `1. This is the only step`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries).toHaveLength(0);
  });

  it("does not extract from error messages", () => {
    const session = makeSession([
      {
        role: "assistant",
        text: `Error: Something went wrong
1. First error detail
2. Second error detail
3. Third error detail`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries).toHaveLength(0);
  });

  it("produces valid ProcedureDetails JSON in details field", () => {
    const session = makeSession([
      {
        role: "assistant",
        text: `Steps to fix:
1. Stop the server
2. Clear the cache
3. Restart`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe("procedure");

    const details = JSON.parse(entries[0].details);
    expect(Array.isArray(details.steps)).toBe(true);
    expect(details.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("scans assistant messages after sequential tool-use", () => {
    const session = makeSession([
      { role: "assistant", text: "Running commands", toolNames: ["Bash"] },
      { role: "assistant", text: "Writing file", toolNames: ["Write"] },
      { role: "assistant", text: "Editing", toolNames: ["Edit"] },
      {
        role: "assistant",
        text: `Setup complete:
1. Installed dependencies
2. Created config file
3. Started the service`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts tags from procedure text", () => {
    const session = makeSession([
      {
        role: "assistant",
        text: `Docker deployment steps:
1. Build with docker build
2. Push to registry
3. Deploy to kubernetes`,
      },
    ]);

    const entries = extractProcedures(session);
    expect(entries.length).toBe(1);
    expect(entries[0].tags).toContain("docker");
  });
});
