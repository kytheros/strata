"""Strata adapter for MemEval LOCOMO benchmark.

Implements the MemEval system adapter interface using the strata-memory
Python SDK. Each LOCOMO conversation gets its own Strata database to
simulate real per-user deployment.

Usage:
    python run_benchmark.py --num-samples 1 --skip-judge
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Callable

from google import genai

from agents_memory.locomo import extract_dialogues
from agents_memory.systems._helpers import _qa_results

from strata.async_client import AsyncStrataClient
from strata.transport.stdio import StdioTransport
from strata.types import SearchResult


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
# Persistent event loop wrapper for AsyncStrataClient
# ---------------------------------------------------------------------------

class _PersistentStrataClient:
    """Wraps AsyncStrataClient with a persistent background event loop.

    The MCP stdio transport uses anyio streams that are bound to the event
    loop where they were created. Using asyncio.run() for each operation
    (as the sync StrataClient does) creates and destroys loops, breaking
    the stream bindings. This wrapper keeps a single event loop alive for
    the entire session.
    """

    def __init__(self, transport: StdioTransport) -> None:
        self._client = AsyncStrataClient(transport=transport)
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever,
            daemon=True,
            name="strata-locomo-loop",
        )
        self._thread.start()

    def _run(self, coro):
        """Run a coroutine on the persistent event loop."""
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=300)

    def connect(self) -> None:
        self._run(self._client.connect())

    def close(self) -> None:
        try:
            self._run(self._client.close())
        except Exception:
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        self._loop.close()

    def add(self, text: str, *, type: str = "episodic",
            tags: list[str] | None = None, project: str | None = None):
        """Store a memory via the SDK's add() method."""
        return self._run(
            self._client.add(text, type=type, tags=tags, project=project)
        )

    def search(self, query: str, *, project: str | None = None,
               limit: int = 20) -> list[SearchResult]:
        """Search via the SDK's search() method."""
        return self._run(
            self._client.search(query, project=project, limit=limit)
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
    """Group flat dialogue turns into sessions based on dia_id prefix.

    extract_dialogues() returns a flat list of turns, each with a
    'dia_id' field like 'D1:1', 'D1:2', 'D2:1'. We group turns by
    their dialogue ID prefix (e.g., 'D1', 'D2') into sessions for
    batch ingestion.
    """
    if not dialogues:
        return []

    sessions: list[list[dict]] = []
    current_session: list[dict] = []
    current_dia_prefix = None

    for turn in dialogues:
        dia_id = turn.get("dia_id", "")
        # Extract prefix before the colon: "D1:3" -> "D1"
        prefix = dia_id.split(":")[0] if ":" in dia_id else dia_id
        if prefix != current_dia_prefix and current_session:
            sessions.append(current_session)
            current_session = []
        current_dia_prefix = prefix
        current_session.append(turn)

    if current_session:
        sessions.append(current_session)

    return sessions


def _ingest_conversation(client: _PersistentStrataClient, conv: dict) -> None:
    """Ingest a LOCOMO conversation into Strata.

    Stores each dialogue session as individual episodic memories via
    store_memory. Each session becomes a searchable knowledge entry
    indexed via FTS5 (BM25 keyword search) and optionally vector
    embeddings (if GEMINI_API_KEY is set for the Strata subprocess).
    """
    dialogues = extract_dialogues(conv)
    sample_id = conv.get("sample_id", "unknown")
    sessions = _group_dialogues_by_session(dialogues)
    total_turns = 0

    for session in sessions:
        # Format session as a single text block
        lines = []
        session_date = session[0].get("timestamp", "") if session else ""
        for turn in session:
            speaker = turn.get("speaker", "")
            text = turn.get("text", "")
            lines.append(f"[{speaker}]: {text}")

        session_text = "\n".join(lines)
        if not session_text.strip():
            continue

        # Prefix with date for temporal context
        if session_date:
            session_text = f"Date: {session_date}\n\n{session_text}"

        try:
            client.add(
                session_text,
                type="episodic",
                tags=["locomo", "conversation", f"session-{session_date}"],
                project=sample_id,
            )
            total_turns += len(session)
        except Exception as e:
            print(f"    Error storing session: {e}")

    print(f"    Ingested: {total_turns} turns across {len(sessions)} sessions")


def _make_answer_fn(
    client: _PersistentStrataClient,
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
        # Build env for the Strata subprocess with isolated data dir.
        # Increase Node.js heap to prevent OOM on large conversations.
        strata_env = {
            **os.environ,
            "STRATA_DATA_DIR": str(data_dir),
            "NODE_OPTIONS": os.environ.get("NODE_OPTIONS", "") + " --max-old-space-size=8192",
        }

        # Use a persistent event loop wrapper to keep the MCP transport
        # streams alive across multiple operations.
        transport = StdioTransport(
            command="npx",
            args=["strata-mcp"],
            env=strata_env,
        )
        client = _PersistentStrataClient(transport=transport)
        client.connect()

        try:
            # Phase 1: Ingest conversation
            _ingest_conversation(client, conv)

            # Phase 2: Answer questions via MemEval's standard QA evaluator
            use_natural = judge_fn == "longmemeval"
            answer_fn = _make_answer_fn(client, conv, use_natural=use_natural)

            return _qa_results(
                conv, answer_fn, run_judge,
                category_names=category_names, judge_fn=judge_fn,
            )
        finally:
            client.close()
    finally:
        # Cleanup temp directory if we created one
        if not _STRATA_BASE_DIR and data_dir.exists():
            shutil.rmtree(data_dir, ignore_errors=True)
