#!/usr/bin/env python3
"""Run the LOCOMO benchmark for Strata via MemEval.

This script downloads the LOCOMO dataset, runs the Strata adapter against
all conversations, computes F1 scores, and optionally runs LLM judge
evaluation. Results are saved as JSON.

Usage:
    python run_benchmark.py [OPTIONS]

Options:
    --num-samples N     Number of conversations to process (default: 10, max: 10)
    --skip-judge        Skip LLM judge evaluation (saves cost)
    --judge-model MODEL Override judge model (default: gpt-5.2)
    --judge-fn FN       Judge function: "default" or "longmemeval"
    --output PATH       Output JSON path (default: results/run-{timestamp}.json)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

# Ensure the adapter can be imported from this directory
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main() -> None:
    parser = argparse.ArgumentParser(description="Run LOCOMO benchmark for Strata")
    parser.add_argument(
        "--num-samples", type=int, default=10,
        help="Number of conversations (max 10, default 10)",
    )
    parser.add_argument(
        "--skip-judge", action="store_true",
        help="Skip LLM judge evaluation",
    )
    parser.add_argument(
        "--judge-model", type=str, default=None,
        help="Override judge model (default: gpt-5.2)",
    )
    parser.add_argument(
        "--judge-fn", type=str, default=None,
        choices=["default", "longmemeval"],
        help="Judge function to use",
    )
    parser.add_argument(
        "--parallel", type=int, default=2,
        help="Max conversations to process in parallel (default: 2)",
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Output JSON path",
    )
    args = parser.parse_args()

    # Validate environment
    if "GEMINI_API_KEY" not in os.environ:
        print("Error: GEMINI_API_KEY environment variable is required", file=sys.stderr)
        sys.exit(1)

    if not args.skip_judge and "OPENAI_API_KEY" not in os.environ:
        print(
            "Warning: OPENAI_API_KEY not set. Judge evaluation will fail.",
            file=sys.stderr,
        )

    if args.judge_model:
        os.environ["JUDGE_MODEL"] = args.judge_model

    # Import MemEval components
    from agents_memory.benchmarks.locomo import download, BENCHMARK_INFO
    from agents_memory.locomo import CATEGORY_NAMES

    # Import our adapter
    import strata_adapter

    # Download LOCOMO dataset
    print(f"\n{'='*60}")
    print("LOCOMO Benchmark for Strata")
    print(f"{'='*60}")
    print(f"Conversations: {args.num_samples}")
    print(f"Judge: {'skip' if args.skip_judge else (args.judge_model or 'gpt-5.2')}")
    print(f"Answer model: {strata_adapter._ANSWER_MODEL}")
    print(f"{'='*60}\n")

    conversations = download(num_samples=args.num_samples)
    print(f"Loaded {len(conversations)} conversations\n")

    # Run adapter for each conversation (2 in parallel)
    all_results: list[dict] = []
    run_judge = not args.skip_judge
    judge_fn = args.judge_fn if args.judge_fn != "default" else None
    max_parallel = args.parallel
    start_time = time.time()

    def _process_conv(i: int, conv: dict) -> tuple[str, list[dict], float]:
        sample_id = conv.get("sample_id", f"conv-{i}")
        qa_count = len(conv.get("qa", []))
        print(f"\n--- Conversation {i}/{len(conversations)}: {sample_id} ({qa_count} QA pairs) ---", flush=True)

        conv_start = time.time()
        results = strata_adapter.run(
            conv=conv,
            llm_model="gemini-2.5-flash",
            run_judge=run_judge,
            category_names=CATEGORY_NAMES,
            judge_fn=judge_fn,
        )
        conv_time = time.time() - conv_start
        conv_f1 = sum(r["f1"] for r in results) / len(results) if results else 0
        print(f"  [{sample_id}] Completed in {conv_time:.1f}s - Avg F1: {conv_f1:.3f}", flush=True)
        return sample_id, results, conv_time

    with ThreadPoolExecutor(max_workers=max_parallel) as pool:
        futures = {
            pool.submit(_process_conv, i, conv): conv
            for i, conv in enumerate(conversations, 1)
        }
        for future in as_completed(futures):
            try:
                sample_id, results, conv_time = future.result()
                all_results.extend(results)
            except Exception as e:
                conv = futures[future]
                sample_id = conv.get("sample_id", "?")
                print(f"  ERROR processing {sample_id}: {e}")
                import traceback
                traceback.print_exc()

    total_time = time.time() - start_time

    # Compute aggregate scores
    print(f"\n{'='*60}")
    print("RESULTS")
    print(f"{'='*60}\n")

    if not all_results:
        print("No results collected.")
        sys.exit(1)

    # Overall F1
    overall_f1 = sum(r["f1"] for r in all_results) / len(all_results)
    print(f"Overall F1: {overall_f1:.3f} ({len(all_results)} questions)")

    # Per-category F1
    category_scores: dict[str, list[float]] = {}
    for r in all_results:
        cat_name = r.get("category_name", str(r.get("category", "?")))
        category_scores.setdefault(cat_name, []).append(r["f1"])

    print(f"\n{'Category':<20} {'F1':>8} {'Count':>8}")
    print("-" * 38)
    for cat_name, scores in sorted(category_scores.items()):
        avg = sum(scores) / len(scores)
        print(f"{cat_name:<20} {avg:>8.3f} {len(scores):>8}")

    # Non-adversarial score
    non_adv = [r for r in all_results if r.get("category_name") != "Adversarial"]
    if non_adv:
        non_adv_f1 = sum(r["f1"] for r in non_adv) / len(non_adv)
        print(f"\nNon-adversarial F1: {non_adv_f1:.3f} ({len(non_adv)} questions)")

    # Judge scores if available
    if run_judge and "judge_relevant" in all_results[0]:
        judge_keys = ["judge_relevant", "judge_complete", "judge_accurate"]
        print(f"\n{'Dimension':<20} {'Pass Rate':>10}")
        print("-" * 32)
        for key in judge_keys:
            vals = [r.get(key, 0) for r in all_results]
            rate = sum(vals) / len(vals)
            print(f"{key:<20} {rate:>10.3f}")

    print(f"\nTotal time: {total_time:.1f}s")

    # Save results
    output_path = args.output
    if not output_path:
        results_dir = Path(__file__).resolve().parent / "results"
        results_dir.mkdir(exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        output_path = str(results_dir / f"run-{ts}.json")

    output_data = {
        "benchmark": "locomo",
        "system": "strata",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "config": {
            "num_samples": args.num_samples,
            "answer_model": strata_adapter._ANSWER_MODEL,
            "judge_model": args.judge_model or os.environ.get("JUDGE_MODEL", "gpt-5.2"),
            "judge_fn": args.judge_fn,
            "run_judge": run_judge,
        },
        "scores": {
            "overall_f1": overall_f1,
            "non_adversarial_f1": non_adv_f1 if non_adv else None,
            "per_category": {
                cat: sum(scores) / len(scores)
                for cat, scores in sorted(category_scores.items())
            },
            "total_questions": len(all_results),
        },
        "results": all_results,
        "total_time_seconds": total_time,
    }

    with open(output_path, "w") as f:
        json.dump(output_data, f, indent=2, default=str)

    print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
