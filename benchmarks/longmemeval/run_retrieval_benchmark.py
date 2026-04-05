#!/usr/bin/env python3
"""LongMemEval Retrieval Benchmark Runner.

Runs the Strata retrieval adapter on LongMemEval questions.

Usage:
    python run_retrieval_benchmark.py --limit 5 --skip-judge
    python run_retrieval_benchmark.py --category MS --skip-judge
    python run_retrieval_benchmark.py --ids 1,2,3 --skip-judge
    python run_retrieval_benchmark.py  # full 500Q with judge
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

# Unbuffered output
os.environ["PYTHONUNBUFFERED"] = "1"


def _load_env():
    """Load .env from strata/ root and monorepo root."""
    # Try both strata/.env and monorepo root .env
    for parents_up in [2, 3]:
        env_path = Path(__file__).resolve().parents[parents_up] / ".env"
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            m = line.strip()
            if m and not m.startswith("#") and "=" in m:
                key, _, val = m.partition("=")
                key = key.strip()
                val = val.strip()
                if key and not os.environ.get(key):
                    os.environ[key] = val


def main():
    _load_env()

    parser = argparse.ArgumentParser(description="LongMemEval Retrieval Benchmark")
    parser.add_argument("--variant", default="s", choices=["s", "m"])
    parser.add_argument("--limit", type=int, default=0, help="Max questions (0=all)")
    parser.add_argument("--skip", type=int, default=0, help="Skip first N")
    parser.add_argument("--skip-judge", action="store_true", help="Skip judging")
    parser.add_argument("--ids", type=str, help="Comma-separated question IDs")
    parser.add_argument("--category", type=str, help="Filter: IE, MS, TR, KU, ABS")
    parser.add_argument("--max-agent-steps", type=int, default=5)
    parser.add_argument("--output", type=str, help="Output JSON path")
    args = parser.parse_args()

    # Import after env is loaded
    from strata_adapter import (
        _PersistentStrataClient,
        _question_type_to_ability,
        load_dataset,
        run_question,
    )
    from strata.transport.stdio import StdioTransport

    # Load dataset
    print(f"Loading LongMemEval-{args.variant.upper()} dataset...")
    questions = load_dataset(args.variant)
    print(f"Loaded {len(questions)} questions")

    # Filter by IDs
    if args.ids:
        id_set = set(args.ids.split(","))
        questions = [q for q in questions if str(q["question_id"]) in id_set]
        print(f"Filtered to {len(questions)} questions by ID")

    # Filter by category
    category_map = {
        "IE": "information_extraction",
        "MS": "multi_session_reasoning",
        "TR": "temporal_reasoning",
        "KU": "knowledge_update",
        "ABS": "abstention",
    }
    if args.category:
        ability = category_map.get(args.category.upper())
        if not ability:
            print(f"Unknown category: {args.category}. Use: {', '.join(category_map.keys())}")
            sys.exit(1)
        questions = [q for q in questions if _question_type_to_ability(q["question_type"]) == ability]
        print(f"Filtered to {len(questions)} questions for {args.category.upper()}")

    # Apply skip/limit
    if args.skip:
        questions = questions[args.skip:]
    if args.limit:
        questions = questions[:args.limit]

    if not questions:
        print("No questions to run.")
        sys.exit(0)

    answer_model = os.environ.get("LONGMEMEVAL_ANSWER_MODEL", "gpt-4o")
    judge_model = os.environ.get("LONGMEMEVAL_JUDGE_MODEL", "gpt-4o")

    print(f"\nRunning {len(questions)} questions")
    print(f"  Answer model:    {answer_model}")
    print(f"  Judge model:     {judge_model}")
    print(f"  Skip judge:      {args.skip_judge}")
    print(f"  Max agent steps: {args.max_agent_steps}")

    # Verify API key
    if not os.environ.get("OPENAI_API_KEY"):
        print("\nERROR: OPENAI_API_KEY not set. Set in strata/.env or export.")
        sys.exit(1)

    # Use persistent data directory so ingested data survives across runs.
    # Each question uses project="lme-{qid}" for isolation within the shared DB.
    cache_dir = Path(__file__).resolve().parent / "cache" / "retrieval-adapter"
    data_dir = cache_dir / "_strata_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    empty_claude_dir = data_dir / "_claude"
    empty_claude_dir.mkdir(exist_ok=True)

    strata_env = {
        **os.environ,
        "STRATA_DATA_DIR": str(data_dir),
        "CLAUDE_DIR": str(empty_claude_dir),
        "STRATA_DISABLE_WATCHER": "1",
        "NODE_OPTIONS": os.environ.get("NODE_OPTIONS", "") + " --max-old-space-size=8192",
    }

    # Find Strata CLI (prefer strata-pro for full extraction pipeline)
    # __file__ is at strata/benchmarks/longmemeval/run_retrieval_benchmark.py
    # parents[2] = strata/, parents[3] = monorepo root
    monorepo_root = Path(__file__).resolve().parents[3]
    strata_root = Path(__file__).resolve().parents[2]
    strata_pro_cli = monorepo_root / "strata-pro" / "dist" / "cli.js"
    strata_cli = strata_root / "dist" / "cli.js"

    if strata_pro_cli.exists():
        cli_path = strata_pro_cli
        print(f"  Strata CLI:      strata-pro ({cli_path})")
    elif strata_cli.exists():
        cli_path = strata_cli
        print(f"  Strata CLI:      strata community ({cli_path})")
    else:
        print(f"\nERROR: No Strata CLI found.")
        print(f"  Tried: {strata_pro_cli}")
        print(f"  Tried: {strata_cli}")
        print(f"  Build with: cd strata-pro && npm run build")
        sys.exit(1)

    transport = StdioTransport(
        command="node",
        args=[str(cli_path)],
        env=strata_env,
    )
    client = _PersistentStrataClient(transport=transport)

    try:
        print(f"\nConnecting to Strata MCP server...")
        client.connect()
        print("Connected.\n")
        print("=" * 70)

        results: list[dict] = []
        start_time = time.time()

        for i, question in enumerate(questions):
            print(f"\n[{i + 1}/{len(questions)}] Q{question['question_id']} ({question['question_type']})")
            try:
                result = run_question(
                    client, question,
                    skip_judge=args.skip_judge,
                    max_agent_steps=args.max_agent_steps,
                )
                results.append(result)
            except Exception as e:
                print(f"  ERROR: {e}")
                import traceback
                traceback.print_exc()
                results.append({
                    "question_id": question["question_id"],
                    "question_type": question["question_type"],
                    "ability": _question_type_to_ability(question["question_type"]),
                    "error": str(e),
                    "verdict": "ERROR",
                })

        elapsed = time.time() - start_time

        # Print results
        print("\n" + "=" * 70)
        print("RESULTS")
        print("=" * 70)

        by_ability: dict[str, dict] = defaultdict(
            lambda: {"correct": 0, "total": 0, "tool_calls": 0, "errors": 0}
        )
        for r in results:
            ab = r.get("ability", "unknown")
            by_ability[ab]["total"] += 1
            if r.get("verdict") == "CORRECT":
                by_ability[ab]["correct"] += 1
            if r.get("verdict") == "ERROR":
                by_ability[ab]["errors"] += 1
            by_ability[ab]["tool_calls"] += r.get("tool_calls", 0)

        print(f"\n{'Ability':<30} {'Correct':>8} {'Total':>8} {'Accuracy':>10} {'Avg Tools':>10}")
        print("-" * 70)

        total_correct = 0
        total_questions = 0
        ability_scores: list[float] = []

        for ability_name in [
            "information_extraction", "multi_session_reasoning",
            "temporal_reasoning", "knowledge_update", "abstention",
        ]:
            stats = by_ability.get(ability_name)
            if not stats or stats["total"] == 0:
                continue
            acc = stats["correct"] / stats["total"]
            avg_tools = stats["tool_calls"] / stats["total"]
            ability_scores.append(acc)
            total_correct += stats["correct"]
            total_questions += stats["total"]
            err_str = f" ({stats['errors']} err)" if stats["errors"] else ""
            print(f"{ability_name:<30} {stats['correct']:>8} {stats['total']:>8} {acc:>9.1%} {avg_tools:>9.1f}{err_str}")

        if total_questions > 0:
            raw_acc = total_correct / total_questions
            task_avg = sum(ability_scores) / len(ability_scores) if ability_scores else 0
            print("-" * 70)
            print(f"{'Raw Accuracy':<30} {total_correct:>8} {total_questions:>8} {raw_acc:>9.1%}")
            print(f"{'Task-Averaged':<30} {'':>8} {'':>8} {task_avg:>9.1%}")
            print(f"\nElapsed: {elapsed:.1f}s ({elapsed / max(len(results), 1):.1f}s/question)")

        # Save results
        ts = int(time.time())
        output_path = args.output or str(
            Path(__file__).resolve().parent / "results" / f"retrieval-adapter-{args.variant}-{ts}.json"
        )
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump({
                "variant": args.variant,
                "answer_model": answer_model,
                "judge_model": judge_model,
                "max_agent_steps": args.max_agent_steps,
                "skip_judge": args.skip_judge,
                "num_questions": len(results),
                "elapsed_seconds": elapsed,
                "results": results,
            }, f, indent=2)
        print(f"\nResults saved to: {output_path}")

    finally:
        client.close()


if __name__ == "__main__":
    main()
