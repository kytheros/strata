"""Strata adapter for MemEval LOCOMO benchmark.

Implements the MemEval system adapter interface using the strata-memory
Python SDK. Each LOCOMO conversation gets its own Strata Pro database to
simulate real per-user deployment.

Requires strata-pro (spawns `npx strata-pro` subprocess) for the full
extraction pipeline via ingest_conversation. Community edition's
store_memory does not chunk or index for FTS5 search — see README.

Usage:
    python run_benchmark.py --num-samples 1 --skip-judge
"""

from __future__ import annotations

import asyncio
import json
import os
import re
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
from strata.types import IngestResult, SearchResult


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SYSTEM_INFO = {
    "architecture": "FTS5/BM25 + vector embeddings, knowledge extraction pipeline, "
                    "hybrid RRF ranking, entity-targeted search, multi-retrieval",
    "infrastructure": "strata-memory SDK (stdio transport), Gemini 2.5 Flash",
}

_ANSWER_MODEL = os.environ.get("STRATA_ANSWER_MODEL", "gemini-2.5-flash")
_STRATA_BASE_DIR = os.environ.get("STRATA_DATA_DIR", "")
_CACHE_DIR = Path(__file__).resolve().parent / "cache"

# ---------------------------------------------------------------------------
# Strategy-specific answer prompts
# ---------------------------------------------------------------------------

_ANSWER_PROMPT_RECALL = (
    "You are answering questions about a conversation between two people. "
    "Use ONLY the retrieved context below to answer. If the context does "
    "not contain enough information, say 'None'.\n\n"
    "Rules:\n"
    "1. Be concise but complete -- give the key fact(s) that answer the question\n"
    "2. Use EXACT words and names from the context when possible\n"
    "3. NO full sentences, NO explanations -- just the answer\n"
    "4. If the answer is truly not in the context, say 'None'\n\n"
    "## Retrieved Context\n\n{context}\n\n"
    "## Question\n\n{question}\n\n"
    "Answer:"
)

_ANSWER_PROMPT_TEMPORAL = (
    "You are answering a question about WHEN something happened in a "
    "conversation between two people. Use ONLY the retrieved context below.\n\n"
    "Rules:\n"
    "1. Each context chunk has a [Session: DATE] marker showing when that "
    "conversation happened.\n"
    "2. If the text says 'yesterday', 'last week', 'last Saturday', etc., "
    "RESOLVE it to an absolute date using the session date. For example, "
    "if session date is '5/8/2023' and text says 'yesterday', answer '7 May 2023'.\n"
    "3. Use the format 'D Month YYYY' (e.g. '7 May 2023').\n"
    "4. For 'the week before' references, use 'The week before D Month YYYY'.\n"
    "5. For approximate dates, use 'Month YYYY' or just the year.\n"
    "6. For 'how long' questions, calculate the duration from the dates.\n"
    "7. Check the EVENTS section first -- it has structured dates.\n"
    "8. If the answer is truly not in the context, say 'None'\n\n"
    "{events_section}"
    "## Retrieved Context\n\n{context}\n\n"
    "## Question\n\n{question}\n\n"
    "Answer:"
)

_ANSWER_PROMPT_ENUMERATE = (
    "You are answering a question that asks for a LIST of items from a "
    "conversation between two people. Use the retrieved context below.\n\n"
    "Rules:\n"
    "1. List ALL matching items found across the events and context -- do not "
    "stop at the first match.\n"
    "2. Check the EVENTS section first -- it contains structured facts extracted "
    "from across all conversation sessions.\n"
    "3. Then check the Retrieved Context for any additional items.\n"
    "4. Separate items with commas.\n"
    "5. Use the exact words from the context when possible.\n"
    "6. Include items even if they appear in different sessions.\n"
    "7. If the answer is truly not in the context, say 'None'\n\n"
    "{events_section}"
    "## Retrieved Context\n\n{context}\n\n"
    "## Question\n\n{question}\n\n"
    "Answer (list all matching items):"
)

_ANSWER_PROMPT_INFERENCE = (
    "You are answering a hypothetical question about a person based on their "
    "conversation history. Use the retrieved context to REASON about what is likely.\n\n"
    "Rules:\n"
    "1. Do NOT say 'None' -- instead reason from the available context.\n"
    "2. Use phrases like 'Likely yes/no because...' or 'Based on the context...'\n"
    "3. Look for relevant personality traits, stated preferences, career goals, "
    "hobbies, and life choices that inform the answer.\n"
    "4. Keep your reasoning brief -- 1-2 sentences max.\n"
    "5. If the context has very little relevant information, say "
    "'Based on limited context, likely...' with your best inference.\n\n"
    "## Retrieved Context\n\n{context}\n\n"
    "## Question\n\n{question}\n\n"
    "Answer:"
)


# ---------------------------------------------------------------------------
# Date conversion utilities
# ---------------------------------------------------------------------------

def _locomo_date_to_iso(locomo_date: str) -> str:
    """Convert LOCOMO date format to ISO 8601.

    LOCOMO format: "1:56 pm on 8 May, 2023"
    Output: "2023-05-08T13:56:00Z"
    """
    from datetime import datetime as _dt

    # Pattern: "H:MM am/pm on D Month, YYYY"
    m = re.match(
        r"(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(\w+),?\s*(\d{4})",
        locomo_date.strip(),
        re.IGNORECASE,
    )
    if not m:
        return ""

    hour = int(m.group(1))
    minute = int(m.group(2))
    ampm = m.group(3).lower()
    day = int(m.group(4))
    month_name = m.group(5)
    year = int(m.group(6))

    # Convert 12-hour to 24-hour
    if ampm == "pm" and hour != 12:
        hour += 12
    elif ampm == "am" and hour == 12:
        hour = 0

    month_map = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
    }
    month = month_map.get(month_name.lower(), 0)
    if not month:
        return ""

    try:
        dt = _dt(year, month, day, hour, minute)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return ""


# ---------------------------------------------------------------------------
# Entity-targeted search: extract speaker name from question
# ---------------------------------------------------------------------------

def _extract_target_speaker(
    question: str,
    speaker_a: str,
    speaker_b: str,
) -> tuple[str, str]:
    """Detect which speaker a question asks about and clean the query.

    LOCOMO questions name the speaker ("What did Caroline research?") but
    the speaker's own turns don't repeat their name — Caroline says
    "I've been looking into adoption agencies", not "Caroline researched
    adoption agencies." FTS5 can't match "Caroline" + "research" against
    that text.

    Returns (target_speaker, cleaned_query) where target_speaker is the
    detected name (or empty string) and cleaned_query has the name and
    possessives stripped out for better keyword matching.
    """
    target = ""
    cleaned = question

    for name in (speaker_a, speaker_b):
        if not name:
            continue
        # Check for the name or possessive forms in the question
        # e.g. "Caroline", "Caroline's", "Melanie's"
        pattern = re.compile(
            r"\b" + re.escape(name) + r"(?:'s|'s)?\b",
            re.IGNORECASE,
        )
        if pattern.search(question):
            target = name
            # Strip name/possessive from query for cleaner FTS matching
            cleaned = pattern.sub("", cleaned)
            break

    # Clean up whitespace artifacts from removal
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # Strip question marks and trailing punctuation for cleaner FTS matching
    cleaned = cleaned.rstrip("?").strip()

    return target, cleaned


# ---------------------------------------------------------------------------
# Strategy-based question classifier
# ---------------------------------------------------------------------------

def _classify_question(question: str) -> str:
    """Classify a question by retrieval/answer strategy.

    Returns one of: "date-lookup", "enumerate", "inference", "recall".
    Based on LongMemEval's category routing pattern adapted for LOCOMO.
    """
    q = question.lower().strip()

    # Inference: hypothetical/reasoning — must check before others
    # "Would Caroline...", "Could Melanie...", "Is X likely..."
    if re.match(r"^(would|could|should|might)\b", q):
        return "inference"
    if re.search(r"be considered|likely to|pursue .+ as", q):
        return "inference"

    # Temporal: date/time lookup
    if re.search(
        r"when did|when is|when was|when does|when will|"
        r"what date|what year|what month|what day|"
        r"how long ago|how long has|how long did|"
        r"how many (?:days?|weeks?|months?|years?|hours?)",
        q,
    ):
        return "date-lookup"

    # Enumerate: listing/aggregation
    if re.search(
        r"what (?:activities|events|books?|things?|types?|kind|hobbies|sports?)|"
        r"what has .+ (?:done|visited|attended|read|made|painted|participated)|"
        r"what did .+ do\b|"
        r"how many(?! (?:days?|weeks?|months?|years?|hours?))|"
        r"how often|list all|name all",
        q,
    ):
        return "enumerate"

    return "recall"


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

    def ingest(self, messages: list[dict[str, str]], *,
               agent: str = "locomo", project: str | None = None) -> IngestResult:
        """Ingest a conversation via the Pro extraction pipeline."""
        return self._run(
            self._client.ingest(messages, agent=agent, project=project)
        )

    def search(self, query: str, *, project: str | None = None,
               limit: int = 20) -> list[SearchResult]:
        """Search via the SDK's search() method (BM25/FTS5)."""
        return self._run(
            self._client.search(query, project=project, limit=limit)
        )

    def semantic_search(self, query: str, *, project: str | None = None,
                        limit: int = 15) -> list[SearchResult]:
        """Search via vector similarity (semantic_search MCP tool).

        The SDK's AsyncStrataClient doesn't expose semantic_search as a
        method, so we call the MCP tool directly via the transport.
        """
        async def _do_semantic():
            args = {"query": query, "limit": limit, "format": "detailed"}
            if project:
                args["project"] = project
            raw = await self._client._transport.call_tool("semantic_search", args)
            return _parse_semantic_results(raw)

        return self._run(_do_semantic())

    def search_events(self, query: str, *, project: str | None = None,
                      limit: int = 20) -> str:
        """Search structured SVO events via the search_events MCP tool.

        Returns raw text output — formatted events with dates.
        Used for temporal and listing questions where structured event
        data provides better coverage than keyword search.
        """
        async def _do_events():
            args: dict = {"query": query, "limit": limit}
            if project:
                args["project"] = project
            return await self._client._transport.call_tool("search_events", args)

        try:
            raw = self._run(_do_events())
            # Filter out "no results" messages
            if raw and "no " not in raw.lower()[:20]:
                return raw
            return ""
        except Exception:
            return ""


def _parse_semantic_results(text: str) -> list[SearchResult]:
    """Parse semantic_search MCP tool output into SearchResult objects."""
    # Try JSON first (detailed format)
    stripped = text.strip()
    if stripped.startswith(("{", "[")):
        try:
            data = json.loads(stripped)
            if isinstance(data, list):
                return [
                    SearchResult(**{k: v for k, v in item.items()
                                    if k in SearchResult.model_fields})
                    for item in data if isinstance(item, dict)
                ]
            if isinstance(data, dict) and "results" in data:
                return [
                    SearchResult(**{k: v for k, v in item.items()
                                    if k in SearchResult.model_fields})
                    for item in data["results"] if isinstance(item, dict)
                ]
        except json.JSONDecodeError:
            pass

    # Text fallback
    results: list[SearchResult] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        score_match = re.search(r"\[([0-9.]+)\]", line)
        score = float(score_match.group(1)) if score_match else 0.0
        results.append(SearchResult(text=line, score=score))
    return results


def _merge_results(
    bm25_results: list[SearchResult],
    semantic_results: list[SearchResult],
    top_k: int = 20,
) -> list[SearchResult]:
    """Merge BM25 and semantic search results, deduplicating by text.

    When the same text appears in both result sets, keep the higher score.
    Returns the top_k results sorted by score descending.
    """
    seen: dict[str, SearchResult] = {}

    for r in bm25_results:
        key = r.text.strip()
        if key not in seen or r.score > seen[key].score:
            seen[key] = r

    for r in semantic_results:
        key = r.text.strip()
        if key not in seen or r.score > seen[key].score:
            seen[key] = r

    merged = sorted(seen.values(), key=lambda x: x.score, reverse=True)
    return merged[:top_k]


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


def _generate_answer(question: str, context: str, prompt_template: str) -> str:
    """Generate an answer using Gemini 2.5 Flash given retrieved context.

    Uses manual string replacement instead of str.format() because the
    context and events text may contain { } characters that break format().
    """
    prompt = prompt_template
    prompt = prompt.replace("{context}", context)
    prompt = prompt.replace("{question}", question)
    prompt = prompt.replace("{events_section}", "")

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


def _build_session_date_map(conv: dict) -> dict[str, str]:
    """Build a mapping from dialogue ID prefix (e.g. 'D1') to session date.

    This lets us associate each ingested chunk with its session date
    for temporal context in answers.
    """
    date_map: dict[str, str] = {}
    conv_data = conv.get("conversation", {})

    session_nums = []
    for key in conv_data.keys():
        if key.startswith("session_") and not key.endswith("_date_time"):
            try:
                num = int(key.split("_")[1])
                session_nums.append(num)
            except (ValueError, IndexError):
                pass

    for num in sorted(session_nums):
        datetime_key = f"session_{num}_date_time"
        session_date = conv_data.get(datetime_key, "")
        # Map D{num} -> date string
        date_map[f"D{num}"] = session_date

    return date_map


def _ingest_conversation(client: _PersistentStrataClient, conv: dict) -> dict:
    """Ingest a LOCOMO conversation into Strata Pro.

    Uses ingest_conversation (Pro-only) which runs the full extraction
    pipeline: chunking, FTS5 indexing, knowledge extraction, entity
    extraction, and optional vector embeddings. Community edition's
    store_memory does not provide this — see README.

    Returns a dict with metadata needed by the answer function:
        speaker_a, speaker_b, session_date_map
    """
    dialogues = extract_dialogues(conv)
    sample_id = conv.get("sample_id", "unknown")
    sessions = _group_dialogues_by_session(dialogues)
    total_turns = 0
    total_entries = 0

    conv_data = conv.get("conversation", {})
    speaker_a = conv_data.get("speaker_a", "")
    speaker_b = conv_data.get("speaker_b", "")
    session_date_map = _build_session_date_map(conv)

    for session in sessions:
        # Format messages for Strata's ingest() method
        # Prefix each message with [Speaker: Name] so FTS can match speaker names
        # Include timestamp so chunks get proper date metadata
        messages = []
        for turn in session:
            speaker = turn.get("speaker", "")
            role = "user" if speaker == speaker_a else "assistant"
            text = turn.get("text", "")
            timestamp = turn.get("timestamp", "")
            # Prepend speaker name so it's indexed by FTS5
            prefixed_text = f"[{speaker}]: {text}"
            msg: dict = {"role": role, "text": prefixed_text}
            if timestamp:
                # Convert LOCOMO date format "1:56 pm on 8 May, 2023" to ISO
                iso_ts = _locomo_date_to_iso(timestamp)
                if iso_ts:
                    msg["timestamp"] = iso_ts
            messages.append(msg)

        if not messages:
            continue

        try:
            result = client.ingest(
                messages,
                agent="locomo",
                project=sample_id,
            )
            total_turns += len(session)
            total_entries += result.entries_extracted if result else 0
        except Exception as e:
            print(f"    Error ingesting session: {e}")

    print(f"    Ingested: {total_turns} turns across {len(sessions)} sessions ({total_entries} entries extracted)")
    return {
        "speaker_a": speaker_a,
        "speaker_b": speaker_b,
        "session_date_map": session_date_map,
    }


def _make_answer_fn(
    client: _PersistentStrataClient,
    conv: dict,
    conv_meta: dict,
    use_natural: bool = False,
) -> Callable[[str], str]:
    """Create an answer function bound to a specific conversation's Strata instance.

    Uses category-specific routing with entity-targeted search,
    multi-retrieval (BM25 + semantic), search_events for temporal/enumerate,
    and strategy-specific prompts for optimal LOCOMO scoring.
    """
    sample_id = conv.get("sample_id", "unknown")
    speaker_a = conv_meta.get("speaker_a", "")
    speaker_b = conv_meta.get("speaker_b", "")

    def answer_fn(question: str) -> str:
        # Step 1: Classify question by strategy
        strategy = _classify_question(question)

        # Step 2: Entity-targeted search — detect speaker, clean query
        target_speaker, cleaned_query = _extract_target_speaker(
            question, speaker_a, speaker_b,
        )

        # Step 3: Multi-search retrieval (BM25 + semantic)
        bm25_results: list[SearchResult] = []
        semantic_results: list[SearchResult] = []

        # BM25 search with cleaned query
        try:
            bm25_results = client.search(
                cleaned_query, project=sample_id, limit=20,
            )
        except Exception as e:
            print(f"    BM25 search error: {e}")

        # Also search with original question if different
        if cleaned_query != question:
            try:
                orig_results = client.search(
                    question, project=sample_id, limit=10,
                )
                bm25_results.extend(orig_results)
            except Exception:
                pass

        # Semantic search (vector similarity) for paraphrase matching
        try:
            semantic_results = client.semantic_search(
                question, project=sample_id, limit=15,
            )
        except Exception as e:
            print(f"    Semantic search unavailable: {e}")

        # Merge and deduplicate
        results = _merge_results(bm25_results, semantic_results, top_k=20)

        # Filter out low-quality results to reduce context noise.
        # Keep results with score > 0 (actual FTS5/vector matches).
        # "No results found" placeholder text has score 0.0.
        if results:
            quality_results = [r for r in results if r.score > 0.01]
            if quality_results:
                results = quality_results

        # Step 4: Strategy-specific search_events for temporal + enumerate
        events_context = ""
        if strategy in ("date-lookup", "enumerate"):
            events_text = client.search_events(
                cleaned_query, project=sample_id, limit=20,
            )
            if events_text:
                events_context = f"## Events (structured facts with dates)\n\n{events_text}\n\n"

        # Step 5: For inference, don't return None — always attempt an answer
        if not results and strategy != "inference":
            return "None"

        # Step 6: Format context with session dates visible
        context_parts = []
        for r in results:
            date_str = r.date if r.date else ""
            if date_str:
                context_parts.append(f"[Session: {date_str}] {r.text}")
            else:
                context_parts.append(f"{r.text}")
        context = "\n".join(context_parts) if results else "(No search results found)"

        # Add speaker context if a target was identified
        if target_speaker:
            context = (
                f"Note: This conversation is between {speaker_a} and {speaker_b}. "
                f"The question asks about {target_speaker}.\n\n"
                + context
            )

        # Step 7: Select prompt by strategy
        if strategy == "date-lookup":
            template = _ANSWER_PROMPT_TEMPORAL.replace("{events_section}", events_context)
        elif strategy == "enumerate":
            template = _ANSWER_PROMPT_ENUMERATE.replace("{events_section}", events_context)
        elif strategy == "inference":
            template = _ANSWER_PROMPT_INFERENCE
        else:
            template = _ANSWER_PROMPT_RECALL

        try:
            return _generate_answer(question, context, template)
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

    # Check ingestion cache — reuse previously ingested database
    cache_data_dir = _CACHE_DIR / sample_id / "data"
    cache_meta_file = _CACHE_DIR / sample_id / "meta.json"
    use_cache = cache_data_dir.exists() and cache_meta_file.exists()

    if use_cache:
        data_dir = cache_data_dir
        print(f"  [{sample_id}] Using cached ingestion: {data_dir}")
    else:
        if _STRATA_BASE_DIR:
            base = Path(_STRATA_BASE_DIR)
            base.mkdir(parents=True, exist_ok=True)
            data_dir = base / sample_id
        else:
            data_dir = Path(tempfile.mkdtemp(prefix="strata-locomo-"))

        if data_dir.exists():
            shutil.rmtree(data_dir, ignore_errors=True)
        data_dir.mkdir(parents=True, exist_ok=True)
        print(f"  [{sample_id}] Data dir: {data_dir}")

    try:
        # Build env for the Strata subprocess with isolated data dir.
        # Increase Node.js heap to prevent OOM on large conversations.
        # Isolate the Strata subprocess completely:
        # - STRATA_DATA_DIR: per-conversation database
        # - CLAUDE_DIR: empty dir so it doesn't index real user history
        # - STRATA_DISABLE_WATCHER: prevent real-time file watching
        empty_claude_dir = data_dir / "_claude"
        empty_claude_dir.mkdir(exist_ok=True)
        strata_env = {
            **os.environ,
            "STRATA_DATA_DIR": str(data_dir),
            "CLAUDE_DIR": str(empty_claude_dir),
            "STRATA_DISABLE_WATCHER": "1",
            "NODE_OPTIONS": os.environ.get("NODE_OPTIONS", "") + " --max-old-space-size=8192",
        }

        # Use a persistent event loop wrapper to keep the MCP transport
        # streams alive across multiple operations.
        # strata-pro is a local package (not published to npm), so we
        # run the built CLI directly via node.
        strata_pro_cli = Path(__file__).resolve().parents[3] / "strata-pro" / "dist" / "cli.js"
        if not strata_pro_cli.exists():
            raise FileNotFoundError(
                f"strata-pro CLI not found at {strata_pro_cli}. "
                "Run 'cd strata-pro && npm run build' first."
            )
        transport = StdioTransport(
            command="node",
            args=[str(strata_pro_cli)],
            env=strata_env,
        )
        client = _PersistentStrataClient(transport=transport)
        client.connect()

        try:
            # Phase 1: Ingest conversation (or load from cache)
            if use_cache:
                conv_meta = json.loads(cache_meta_file.read_text())
                print(f"    Loaded cached metadata: {conv_meta.get('speaker_a')}/{conv_meta.get('speaker_b')}")
            else:
                conv_meta = _ingest_conversation(client, conv)
                cache_dir = _CACHE_DIR / sample_id
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_meta_file.write_text(json.dumps(conv_meta))
                if data_dir != cache_data_dir:
                    if cache_data_dir.exists():
                        shutil.rmtree(cache_data_dir)
                    shutil.copytree(data_dir, cache_data_dir)
                    print(f"    Cached ingestion to: {cache_data_dir}")

            # Phase 2: Answer questions via MemEval's standard QA evaluator
            use_natural = judge_fn == "longmemeval"
            answer_fn = _make_answer_fn(
                client, conv, conv_meta, use_natural=use_natural,
            )

            return _qa_results(
                conv, answer_fn, run_judge,
                category_names=category_names, judge_fn=judge_fn,
            )
        finally:
            client.close()
    finally:
        # Cleanup temp directory if we created one (but not the cache)
        if not _STRATA_BASE_DIR and not use_cache and data_dir.exists():
            shutil.rmtree(data_dir, ignore_errors=True)
