import type { LlmProvider } from "../llm-extraction/llm-provider.js";
import { extractAtomicFacts } from "../llm-extraction/utterance-extractor.js";
import { applyHedgeFilter } from "../llm-extraction/hedge-filter.js";
import type { ExtractionQueueStore, Job } from "./queue-store.js";
import type { TenantDbResolver } from "./tenant-db-resolver.js";

export interface ExtractionWorkerOpts {
  queue: ExtractionQueueStore;
  provider: LlmProvider;
  tenantResolver: TenantDbResolver;
  logger?: (msg: string) => void;
  pollIntervalMs?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  extractTimeoutMs?: number;
  maxItems?: number;
}

const DEFAULT_POLL = 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF = [1000, 5000, 30_000];

export class ExtractionWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly backoff: number[];
  private readonly log: (msg: string) => void;
  private readonly extractTimeoutMs: number;
  private readonly maxItems: number;
  private readonly onEnqueue = (): void => { void this.tick(); };

  constructor(private opts: ExtractionWorkerOpts) {
    this.pollMs = opts.pollIntervalMs ?? DEFAULT_POLL;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.log = opts.logger ?? (() => {});
    this.extractTimeoutMs = opts.extractTimeoutMs ?? 30_000;
    this.maxItems = opts.maxItems ?? 5;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.queue.recoverOrphaned(Date.now());
    this.opts.queue.on("enqueue", this.onEnqueue);
    this.interval = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.opts.queue.off("enqueue", this.onEnqueue);
    if (this.inFlight) await this.inFlight;
  }

  async runOnce(): Promise<boolean> {
    const job = this.opts.queue.claimNext(Date.now());
    if (!job) return false;
    await this.processJob(job);
    return true;
  }

  async flushAll(): Promise<void> {
    while (await this.runOnce()) {
      // loop until queue empty
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = (async () => {
      try {
        await this.runOnce();
      } catch (err) {
        this.log(`[extraction-worker] tick error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  private async processJob(job: Job): Promise<void> {
    try {
      const rawFacts = await extractAtomicFacts(job.text, {
        provider: this.opts.provider,
        timeoutMs: this.extractTimeoutMs,
        maxItems: this.maxItems,
      });

      const hedgeFiltered = applyHedgeFilter(rawFacts, job.text);
      const finalFacts = applySelfUtteranceProvenance(hedgeFiltered, job.userTags);

      await this.opts.tenantResolver.withTenantDb(
        job.tenantId,
        job.agentId,
        async (target) => {
          // Spec 2026-04-28: read conflict-detection mode once per job.
          // "off" mode is used during ship-gate Step-1 baseline measurement.
          const { CONFIG } = await import("../../config.js");
          const conflictMode = CONFIG.extraction?.conflictDetection ?? "exact";
          const { normalizeKey } = await import("../llm-extraction/utterance-extractor.js");

          for (const f of finalFacts) {
            const tags = [
              ...job.userTags,
              "extracted",
              f.type,
              ...(f.tags ?? []),
            ];
            const dedupedTags = Array.from(new Set(tags));
            const importance = typeof f.importance === "number"
              ? f.importance
              : job.importance ?? 70;
            if (target.kind === "v2") {
              // Dynamic import to avoid top-level coupling with transports/.
              const { NpcMemoryEngine } = await import("../../transports/npc-memory-engine.js");
              const engine = new NpcMemoryEngine(target.worldDb, target.agentId);
              const subjectKey   = (f.subject   && f.subject.trim().length   > 0) ? normalizeKey(f.subject)   : null;
              const predicateKey = (f.predicate && f.predicate.trim().length > 0) ? normalizeKey(f.predicate) : null;
              const newId = engine.add({
                content: f.text, tags: dedupedTags, importance,
                subjectKey, predicateKey,
              });
              // Conflict-resolution gate. "off" path is used during Step-1
              // baseline measurement. "embedding" path delegates to exact today;
              // reserved for follow-up spec.
              if (conflictMode !== "off" && subjectKey !== null && predicateKey !== null) {
                engine.markSupersededByKey({
                  npcId: target.agentId,
                  subjectKey, predicateKey,
                  excludeId: newId,
                  supersededBy: newId,
                });
              }
            } else {
              await target.addEntry(f.text, dedupedTags, importance);
            }
          }
        },
      );
      this.opts.queue.markCompleted(job.id, Date.now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (job.attempts >= this.maxAttempts) {
        this.opts.queue.markFailed(job.id, msg, Date.now());
        this.log(`[extraction-worker] job ${job.id} failed permanently: ${msg}`);
      } else {
        const backoffIdx = Math.min(job.attempts - 1, this.backoff.length - 1);
        const delay = this.backoff[backoffIdx] ?? 0;
        this.opts.queue.markRetry(job.id, msg, Date.now() + delay);
        this.log(`[extraction-worker] job ${job.id} retry in ${delay}ms: ${msg}`);
      }
    }
  }
}

function applySelfUtteranceProvenance(
  facts: import("../llm-extraction/utterance-extractor.js").AtomicFact[],
  baseTags: string[],
): import("../llm-extraction/utterance-extractor.js").AtomicFact[] {
  // Row-level scoping: if the source row is tagged `self`, every fact
  // extracted from it gets the penalty. This matches the production
  // caller (NPCController posts self-tagged rows for `I said: "..."`);
  // if the `self` tag is ever reused for non-NPC-speech contexts, the
  // penalty will apply there too.
  if (!baseTags.includes("self")) return facts;
  const raw = Number(process.env.STRATA_SELF_UTTERANCE_MULTIPLIER);
  const multiplier = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
  return facts.map((fact) => {
    const nextTags = Array.from(new Set([...(fact.tags ?? []), "self-utterance"]));
    const baseImportance = typeof fact.importance === "number" ? fact.importance : 70;
    const nextImportance = Math.round(baseImportance * multiplier);
    return { ...fact, tags: nextTags, importance: nextImportance };
  });
}
