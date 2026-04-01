"""Strata adapter for MemEval LOCOMO benchmark.

Implements the MemEval system adapter interface using the strata-memory
Python SDK. Each LOCOMO conversation gets its own Strata database to
simulate real per-user deployment.

Usage:
    Copy this file to MemEval's src/agents_memory/systems/strata.py,
    or use run.sh which does this automatically.

    GEMINI_API_KEY=xxx python -m agents_memory.scripts.run_full_benchmark \
        --systems strata --num-samples 1 --skip-judge
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Callable

from google import genai

from agents_memory.evaluation import compute_f1, evaluate_with_judge, evaluate_longmemeval
from agents_memory.locomo import CATEGORY_NAMES as DEFAULT_CATEGORIES
from agents_memory.locomo import extract_dialogues

from strata import StrataClient


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SYSTEM_INFO = {
    "architecture": "FTS5/BM25 + vector embeddings, knowledge extraction pipeline, "
                    "hybrid RRF ranking",
    "infrastructure": "strata-memory SDK (stdio transport), Gemini 2.5 Flash",
}

_ANSWER_MODEL = os.environ.get("STRATA_ANSWER_MODEL", "gemini-2.5-flash")
_STRATA_BASE_DIR = os.environ.get("STRATA_DATA_DIR", "")

# Short-answer prompt optimized for F1 scoring (token overlap with ground truth)
_ANSWER_PROMPT_SHORT = (
    "You are answering questions about a person's conversation history. "
    "Use ONLY the retrieved context below to answer. If the context does "
    "not contain enough information, say 'None'.\n\n"
    "Rules:\n"
    "1. Give the SHORTEST answer possible -- just the key fact (1-5 words max)\n"
    "2. Use EXACT words from the context when possible\n"
    "3. NO full sentences, NO explanations\n"
    "4. For dates, use the format from the context\n"
    "5. If the answer is truly not in the context, say 'None'\n\n"
    "## Retrieved Context\n\n{context}\n\n"
    "## Question\n\n{question}\n\n"
    "Answer:"
)

# Natural-answer prompt for LongMemEval-style judge evaluation
_ANSWER_PROMPT_NATURAL = (
    "You are answering questions about a person's conversation history. "
    "Use ONLY the retrieved context below to answer. If the context does "
    "not contain enough information, say so.\n\n"
    "## Retrieved Context\n\n{context}\n\n"
    "## Question\n\n{question}\n\n"
    "Answer concisely with direct facts. Do not use full sentences -- "
    "list facts separated by commas when appropriate."
)


# ---------------------------------------------------------------------------
# Answer generation via Gemini
# ---------------------------------------------------------------------------

_genai_client: genai.Client | None = None


def _get_genai_client() -> genai.Client:
    """Get or create a singleton Gemini client."""
    global _genai_client
    if _genai_client is None:
        _genai_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _genai_client


def _generate_answer(question: str, context: str, use_natural: bool = False) -> str:
    """Generate an answer using Gemini 2.5 Flash given retrieved context."""
    template = _ANSWER_PROMPT_NATURAL if use_natural else _ANSWER_PROMPT_SHORT
    prompt = template.format(context=context, question=question)

    client = _get_genai_client()
    response = client.models.generate_content(
        model=_ANSWER_MODEL,
        contents=prompt,
    )
    return response.text.strip()


# ---------------------------------------------------------------------------
# Per-conversation Strata lifecycle
# ---------------------------------------------------------------------------

def _group_dialogues_by_session(dialogues: list[dict]) -> list[list[dict]]:
    """Group flat dialogue turns into sessions based on timestamp.

    extract_dialogues() returns a flat list of turns, each with a
    'timestamp' field (the session date). We group consecutive turns
    with the same timestamp into sessions for batch ingestion.
    """
    if not dialogues:
        return []

    sessions: list[list[dict]] = []
    current_session: list[dict] = []
    current_timestamp = None

    for turn in dialogues:
        ts = turn.get("timestamp", "")
        if ts != current_timestamp and current_session:
            sessions.append(current_session)
            current_session = []
        current_timestamp = ts
        current_session.append(turn)

    if current_session:
        sessions.append(current_session)

    return sessions


def _ingest_conversation(client: StrataClient, conv: dict) -> None:
    """Ingest a LOCOMO conversation into Strata via the SDK.

    Extracts dialogue turns, groups them by session, and calls
    client.ingest() for each session. This runs Strata's full
    extraction pipeline (chunking, knowledge extraction, entity
    extraction, embedding).
    """
    dialogues = extract_dialogues(conv)
    sessions = _group_dialogues_by_session(dialogues)
    sample_id = conv.get("sample_id", "unknown")
    conv_data = conv.get("conversation", {})
    speaker_a = conv_data.get("speaker_a", "")

    total_turns = 0
    for session in sessions:
        # Format messages for Strata's ingest() method
        # Map speaker_a -> "user", speaker_b -> "assistant"
        messages = []
        for turn in session:
            speaker = turn.get("speaker", "")
            role = "user" if speaker == speaker_a else "assistant"
            timestamp = turn.get("timestamp", "")
            text = turn.get("text", "")

            # Include speaker name and timestamp in the text for context
            # This helps Strata's extraction pipeline preserve speaker identity
            content = f"[{speaker}] ({timestamp}): {text}" if timestamp else f"[{speaker}]: {text}"
            messages.append({
                "role": role,
                "content": content,
            })

        if messages:
            try:
                client.ingest(
                    messages,
                    agent="locomo",
                    project=sample_id,
                )
                total_turns += len(messages)
            except Exception as e:
                print(f"    Error ingesting session: {e}")

    print(f"    Ingested: {total_turns} turns across {len(sessions)} sessions")


def _make_answer_fn(
    client: StrataClient,
    conv: dict,
    use_natural: bool = False,
) -> Callable[[str], str]:
    """Create an answer function bound to a specific conversation's Strata instance."""
    sample_id = conv.get("sample_id", "unknown")

    def answer_fn(question: str) -> str:
        # Retrieve context from Strata
        try:
            results = client.search(question, project=sample_id, limit=20)
        except Exception as e:
            print(f"    Search error: {e}")
            return "None"

        if not results:
            return "None"

        # Format retrieved context
        context_parts = []
        for r in results:
            date_prefix = f"[{r.date}] " if r.date else ""
            context_parts.append(f"- {date_prefix}{r.text}")
        context = "\n".join(context_parts)

        try:
            return _generate_answer(question, context, use_natural=use_natural)
        except Exception as e:
            print(f"    Gemini error: {e}")
            return "None"

    return answer_fn


# ---------------------------------------------------------------------------
# MemEval adapter entry point
# ---------------------------------------------------------------------------

def run(
    conv: dict,
    llm_model: str,
    run_judge: bool,
    category_names: dict | None = None,
    judge_fn: str | None = None,
) -> list[dict]:
    """MemEval adapter for Strata.

    Creates a fresh Strata database per conversation (simulating real
    per-user deployment), ingests the conversation, then answers all
    QA pairs using Strata's retrieval + Gemini 2.5 Flash.

    Parameters
    ----------
    conv : dict
        LOCOMO conversation with 'sample_id', 'conversation', and 'qa'.
    llm_model : str
        Model name from MemEval runner (not used -- we use Gemini).
    run_judge : bool
        Whether to run LLM judge evaluation.
    category_names : dict, optional
        Category ID -> name mapping.
    judge_fn : str, optional
        Judge function name (e.g. "longmemeval").
    """
    sample_id = conv.get("sample_id", "unknown")

    # Create isolated data directory for this conversation
    if _STRATA_BASE_DIR:
        base = Path(_STRATA_BASE_DIR)
        base.mkdir(parents=True, exist_ok=True)
        data_dir = base / sample_id
    else:
        data_dir = Path(tempfile.mkdtemp(prefix="strata-locomo-"))

    # Clean any previous run data
    if data_dir.exists():
        shutil.rmtree(data_dir, ignore_errors=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    print(f"  [{sample_id}] Data dir: {data_dir}")

    try:
        # Build env for the Strata subprocess with isolated data dir
        strata_env = {**os.environ, "STRATA_DATA_DIR": str(data_dir)}

        # Connect to Strata via stdio transport (spawns npx strata-mcp)
        # Pass env to the transport so the subprocess uses the right data dir
        from strata.transport.stdio import StdioTransport

        transport = StdioTransport(
            command="npx",
            args=["strata-mcp"],
            env=strata_env,
        )
        client = StrataClient(transport=transport)
        client.connect()

        try:
            # Phase 1: Ingest conversation
            _ingest_conversation(client, conv)

            # Phase 2: Answer questions
            # We implement the QA loop directly instead of using _qa_results
            # to avoid nested asyncio.run() issues (StrataClient uses asyncio
            # internally, and _qa_results wraps its async version with asyncio.run).
            use_natural = judge_fn == "longmemeval"
            answer_fn = _make_answer_fn(client, conv, use_natural=use_natural)
            cats = category_names or DEFAULT_CATEGORIES
            qa_pairs = conv.get("qa", [])
            results = []

            for i, qa in enumerate(qa_pairs, 1):
                question = qa.get("question", "")
                ground_truth = qa.get("answer", "")
                category = qa.get("category", 0)
                question_id = qa.get("question_id", "")

                try:
                    predicted = answer_fn(question)
                except Exception as err:
                    print(f"    Error on Q{i}: {err}")
                    predicted = ""

                f1 = compute_f1(predicted, ground_truth)

                row = {
                    "sample_id": sample_id,
                    "question": question,
                    "ground_truth": ground_truth,
                    "predicted": predicted,
                    "category": category,
                    "category_name": cats.get(category, str(category)),
                    "f1": f1,
                }

                if run_judge:
                    if judge_fn == "longmemeval":
                        row.update(evaluate_longmemeval(
                            question, ground_truth, predicted,
                            category=str(category),
                            question_id=question_id,
                        ))
                    else:
                        row.update(evaluate_with_judge(
                            question, ground_truth, predicted,
                        ))

                results.append(row)

                if i % 20 == 0:
                    print(f"    QA {i}/{len(qa_pairs)} - F1={f1:.3f}")

            return results
        finally:
            client.close()
    finally:
        # Cleanup temp directory if we created one
        if not _STRATA_BASE_DIR and data_dir.exists():
            shutil.rmtree(data_dir, ignore_errors=True)
