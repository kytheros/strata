"""Strata retrieval adapter for LongMemEval benchmark.

Turn-level retrieval with GPT-4o agent loop via Strata MCP tools.
Mirrors the LOCOMO adapter architecture but adapted for LongMemEval's
dataset format and 5-category routing.

Design spec: specs/2026-04-05-longmemeval-retrieval-adapter-design.md

Usage:
    python run_retrieval_benchmark.py --limit 5 --skip-judge
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

import openai

from strata.async_client import AsyncStrataClient
from strata.transport.stdio import StdioTransport
from strata.types import IngestResult, SearchResult


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_ANSWER_MODEL = os.environ.get("LONGMEMEVAL_ANSWER_MODEL", "gpt-4o")
_JUDGE_MODEL = os.environ.get("LONGMEMEVAL_JUDGE_MODEL", "gpt-4o")
_MAX_AGENT_STEPS = int(os.environ.get("LONGMEMEVAL_MAX_AGENT_STEPS", "5"))
_CACHE_DIR = Path(__file__).resolve().parent / "cache" / "retrieval-adapter"
_DATA_DIR = Path(__file__).resolve().parent / "data"


# ---------------------------------------------------------------------------
# Persistent event loop wrapper for AsyncStrataClient
# (Reused from LOCOMO adapter -- MCP stdio transport requires persistent loop)
# ---------------------------------------------------------------------------

class _PersistentStrataClient:
    """Wraps AsyncStrataClient with a persistent background event loop.

    The MCP stdio transport uses anyio streams bound to the creating loop.
    asyncio.run() creates/destroys loops, breaking stream bindings.
    This wrapper keeps a single loop alive for the entire session.
    """

    def __init__(self, transport: StdioTransport) -> None:
        self._client = AsyncStrataClient(transport=transport)
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever,
            daemon=True,
            name="strata-longmemeval-loop",
        )
        self._thread.start()

    def _run(self, coro):
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
               agent: str = "longmemeval", project: str | None = None) -> IngestResult:
        return self._run(
            self._client.ingest(messages, agent=agent, project=project)
        )

    def search(self, query: str, *, project: str | None = None,
               limit: int = 20) -> list[SearchResult]:
        return self._run(
            self._client.search(query, project=project, limit=limit)
        )

    def semantic_search(self, query: str, *, project: str | None = None,
                        limit: int = 15) -> list[SearchResult]:
        async def _do_semantic():
            args: dict[str, Any] = {"query": query, "limit": limit, "format": "detailed"}
            if project:
                args["project"] = project
            raw = await self._client._transport.call_tool("semantic_search", args)
            return _parse_semantic_results(raw)
        return self._run(_do_semantic())

    def search_events(self, query: str, *, project: str | None = None,
                      limit: int = 20) -> str:
        async def _do_events():
            args: dict[str, Any] = {"query": query, "limit": limit}
            if project:
                args["project"] = project
            return await self._client._transport.call_tool("search_events", args)
        try:
            raw = self._run(_do_events())
            if raw and "no " not in raw.lower()[:20]:
                return raw
            return ""
        except Exception:
            return ""


# ---------------------------------------------------------------------------
# Search result parsing and merging
# ---------------------------------------------------------------------------

def _parse_semantic_results(text: str) -> list[SearchResult]:
    """Parse semantic_search MCP tool output into SearchResult objects."""
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
    *result_lists: list[SearchResult],
    top_k: int = 20,
) -> list[SearchResult]:
    """Merge multiple search result lists, deduplicating by text."""
    seen: dict[str, SearchResult] = {}
    for results in result_lists:
        for r in results:
            key = r.text.strip()
            if key not in seen or r.score > seen[key].score:
                seen[key] = r
    merged = sorted(seen.values(), key=lambda x: x.score, reverse=True)
    return merged[:top_k]


# ---------------------------------------------------------------------------
# Dataset loading
# ---------------------------------------------------------------------------

def load_dataset(variant: str = "s") -> list[dict]:
    """Load LongMemEval dataset from JSON."""
    filename = f"longmemeval_{variant}_cleaned.json"
    filepath = _DATA_DIR / filename
    if not filepath.exists():
        raise FileNotFoundError(
            f"Dataset not found: {filepath}\n"
            f"Run: npx tsx benchmarks/longmemeval/download-dataset.ts --variant={variant}"
        )
    with open(filepath, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Turn-level ingestion
# ---------------------------------------------------------------------------

def _parse_longmemeval_date(date_str: str) -> str:
    """Convert LongMemEval date format to ISO 8601.

    Input: "2023/05/20 (Sat) 02:21"
    Output: "2023-05-20T02:21:00Z"
    """
    m = re.match(r"(\d{4})/(\d{2})/(\d{2})\s*\(\w+\)\s*(\d{2}):(\d{2})", date_str.strip())
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}T{m.group(4)}:{m.group(5)}:00Z"
    # Fallback: just date part
    m2 = re.match(r"(\d{4})/(\d{2})/(\d{2})", date_str.strip())
    if m2:
        return f"{m2.group(1)}-{m2.group(2)}-{m2.group(3)}T00:00:00Z"
    return ""


def _get_cache_path(question_id: str) -> Path:
    return _CACHE_DIR / question_id


def _is_cached(question_id: str) -> bool:
    cache = _get_cache_path(question_id)
    return (cache / "done").exists()


def ingest_question(
    client: _PersistentStrataClient,
    question: dict,
    project: str,
    batch_size: int = 5,
) -> dict:
    """Ingest a LongMemEval question's haystack sessions.

    Batches multiple sessions per ingest_conversation call to reduce
    MCP transport overhead and Gemini API calls. Each batch of sessions
    is sent as one message list with session boundaries preserved via
    timestamps.

    Returns metadata dict with turn count and session info.
    """
    sessions = question["haystack_sessions"]
    session_ids = question["haystack_session_ids"]
    session_dates = question["haystack_dates"]

    total_turns = 0
    total_entries = 0
    num_sessions = len(sessions)

    # Batch sessions to reduce per-call overhead
    for batch_start in range(0, num_sessions, batch_size):
        batch_end = min(batch_start + batch_size, num_sessions)
        batch_messages: list[dict[str, str]] = []

        for idx in range(batch_start, batch_end):
            session = sessions[idx]
            date_str = session_dates[idx]
            iso_ts = _parse_longmemeval_date(date_str)

            for turn in session:
                msg: dict[str, str] = {
                    "role": turn["role"],
                    "text": turn["content"],
                }
                if iso_ts:
                    msg["timestamp"] = iso_ts
                batch_messages.append(msg)

            total_turns += len(session)

        if not batch_messages:
            continue

        try:
            result = client.ingest(
                batch_messages, agent="longmemeval", project=project,
            )
            total_entries += result.entries_extracted if result else 0
        except Exception as e:
            print(f"    Error ingesting batch {batch_start}-{batch_end}: {e}")

        print(f"    [{batch_end}/{num_sessions}] sessions ingested...", flush=True)

    meta = {
        "total_turns": total_turns,
        "total_sessions": num_sessions,
        "total_entries": total_entries,
        "session_ids": session_ids,
    }

    # Mark as cached
    cache = _get_cache_path(question["question_id"])
    cache.mkdir(parents=True, exist_ok=True)
    (cache / "meta.json").write_text(json.dumps(meta))
    (cache / "done").touch()

    return meta


# ---------------------------------------------------------------------------
# Question classification
# ---------------------------------------------------------------------------

_QUESTION_TYPE_TO_STRATEGY: dict[str, str] = {
    "single-session-user": "recall",
    "single-session-assistant": "recall",
    "single-session-preference": "preference",
    "multi-session": "enumerate",
    "temporal-reasoning": "date-lookup",
    "knowledge-update": "recall",
    "unanswerable": "recall",
}


def _classify_question(question_type: str) -> str:
    """Map LongMemEval question_type to retrieval strategy."""
    return _QUESTION_TYPE_TO_STRATEGY.get(question_type, "recall")


# ---------------------------------------------------------------------------
# Search utilities
# ---------------------------------------------------------------------------

_STOP_WORDS = frozenset({
    "a", "an", "the", "is", "am", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "shall", "should", "may", "might", "can", "could", "must",
    "i", "me", "my", "mine", "we", "us", "our", "you", "your",
    "he", "him", "his", "she", "her", "it", "its", "they", "them", "their",
    "this", "that", "these", "those",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after",
    "and", "but", "or", "not", "no", "so", "if", "then",
    "than", "too", "very", "just", "about", "also",
    "how", "what", "when", "where", "which", "who", "whom", "why",
    "all", "each", "every", "both", "few", "more", "most", "other",
    "some", "such", "any", "only", "own", "same",
    "here", "there", "again", "once", "get", "got",
    "new", "used", "like", "many",
})


def _extract_content_words(text: str) -> list[str]:
    words = re.findall(r"[a-zA-Z]+", text.lower())
    return [w for w in words if w not in _STOP_WORDS and len(w) > 1]


# ---------------------------------------------------------------------------
# Agent loop -- GPT-4o with search tool access
# ---------------------------------------------------------------------------

_AGENT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_history",
            "description": (
                "Search conversation turns by keywords and semantic meaning. "
                "Returns the most relevant turns with dates and content. "
                "Try DIFFERENT vocabulary if first search misses -- "
                "the same topic often uses different words."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query. Natural language or key phrases.",
                    },
                    "limit": {
                        "type": "number",
                        "description": "Max results to return (default 20).",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "semantic_search",
            "description": (
                "Search by meaning/paraphrase -- finds turns that discuss "
                "the same topic even with completely different words. "
                "Complements search_history for vocabulary mismatches."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query.",
                    },
                    "limit": {
                        "type": "number",
                        "description": "Max results to return (default 15).",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_events",
            "description": (
                "Search structured calendar of events extracted from conversations. "
                "Returns dated entries -- activities, purchases, experiences. "
                "Use to locate time periods and for counting questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keywords for event search. Short phrases work best.",
                    },
                    "limit": {
                        "type": "number",
                        "description": "Max events to return (default 20).",
                    },
                },
                "required": ["query"],
            },
        },
    },
]

_AGENT_SYSTEM_PROMPTS: dict[str, str] = {
    "recall": (
        "You are answering a question about a user's conversation history. "
        "Search for the specific fact, then answer concisely. "
        "Use EXACT words from the conversations. Say 'None' only if the information "
        "truly cannot be found after searching."
    ),
    "enumerate": (
        "You are answering a COUNTING or LISTING question about a user's conversation history. "
        "You MUST search broadly -- use multiple queries with different vocabulary. "
        "List ALL matching items you find across all conversations. "
        "Search events first for structured data, then search_history for raw turns. "
        "Count carefully after listing everything."
    ),
    "date-lookup": (
        "You are answering a TEMPORAL question about when something happened. "
        "Search events first -- they have structured dates. "
        "Then search conversations for context. "
        "Resolve relative dates (yesterday, last week) using session dates. "
        "Use format 'D Month YYYY' (e.g. '7 May 2023'). "
        "For duration questions, calculate from the dates."
    ),
    "preference": (
        "You are providing a PERSONALIZED RECOMMENDATION or response that must "
        "reflect the user's known preferences, tools, habits, and personal context. "
        "This is NOT a fact-lookup question -- you must search for the user's "
        "background on the topic, then synthesize a tailored response. "
        "\n\n"
        "Required steps: "
        "(1) Search broadly for the user's preferences, tools, opinions, or habits "
        "related to the topic. Try search_history with topic keywords AND "
        "semantic_search with phrases like 'user prefers X', 'user uses X', "
        "'user dislikes X'. "
        "(2) Look for specific brands, products, software, or methods the user "
        "has mentioned positively. "
        "(3) Generate a personalized response that explicitly references the "
        "user's preferences. For example, if they use Adobe Premiere Pro, "
        "recommend Premiere-specific resources, not generic ones. "
        "\n\n"
        "NEVER answer 'None' for a preference question -- always provide a "
        "recommendation that reflects what you found about the user. If the "
        "search returns little, infer from the user's general interests and "
        "context, but always personalize."
    ),
}


def _execute_tool(
    client: _PersistentStrataClient,
    project: str,
    tool_name: str,
    args: dict,
) -> str:
    """Execute a search tool and return results as text."""
    query = args.get("query", "")
    limit = args.get("limit", 20)

    if tool_name == "search_history":
        results = client.search(query, project=project, limit=int(limit))
        if not results:
            return "(No results found)"
        parts = []
        for r in results:
            date_str = f" [{r.date}]" if r.date else ""
            parts.append(f"[score={r.score:.3f}{date_str}] {r.text}")
        return "\n".join(parts)

    elif tool_name == "semantic_search":
        results = client.semantic_search(query, project=project, limit=int(limit))
        if not results:
            return "(No results found)"
        parts = []
        for r in results:
            date_str = f" [{r.date}]" if r.date else ""
            parts.append(f"[score={r.score:.3f}{date_str}] {r.text}")
        return "\n".join(parts)

    elif tool_name == "search_events":
        text = client.search_events(query, project=project, limit=int(limit))
        return text if text else "(No events found)"

    return f"(Unknown tool: {tool_name})"


def run_agent_loop(
    client: _PersistentStrataClient,
    project: str,
    question_text: str,
    question_type: str,
    question_date: str,
    max_steps: int = _MAX_AGENT_STEPS,
) -> dict:
    """Run GPT-4o agent loop with search tool access.

    Returns dict with: answer, tool_calls, tool_log, latency_ms
    """
    strategy = _classify_question(question_type)
    system_prompt = _AGENT_SYSTEM_PROMPTS.get(strategy, _AGENT_SYSTEM_PROMPTS["recall"])

    if question_date:
        system_prompt += f"\n\nThe question is being asked on: {question_date}"

    messages: list[dict] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": question_text},
    ]

    oai = openai.OpenAI()
    tool_log: list[dict] = []
    start = time.time()

    for step in range(max_steps):
        # Force final answer on last iteration
        tool_choice = "auto" if step < max_steps - 1 else "none"

        response = oai.chat.completions.create(
            model=_ANSWER_MODEL,
            messages=messages,
            tools=_AGENT_TOOLS,
            tool_choice=tool_choice,
            temperature=0,
            max_tokens=2048,
        )

        msg = response.choices[0].message

        if msg.tool_calls:
            # Build assistant message with tool calls
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "content": msg.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in msg.tool_calls
                ],
            }
            messages.append(assistant_msg)

            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}

                result_text = _execute_tool(client, project, tc.function.name, args)
                tool_log.append({
                    "tool": tc.function.name,
                    "args": args,
                    "result_length": len(result_text),
                })

                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result_text,
                })
        else:
            # Agent produced final answer
            answer = (msg.content or "None").strip()
            return {
                "answer": answer,
                "tool_calls": len(tool_log),
                "tool_log": tool_log,
                "latency_ms": int((time.time() - start) * 1000),
            }

    # Exhausted iterations -- force final answer
    if messages and messages[-1].get("role") == "tool":
        response = oai.chat.completions.create(
            model=_ANSWER_MODEL,
            messages=messages,
            tool_choice="none",
            temperature=0,
            max_tokens=2048,
        )
        answer = (response.choices[0].message.content or "None").strip()
    else:
        answer = "None"

    return {
        "answer": answer,
        "tool_calls": len(tool_log),
        "tool_log": tool_log,
        "latency_ms": int((time.time() - start) * 1000),
    }


# ---------------------------------------------------------------------------
# Judge -- ports official LongMemEval eval prompts (GPT-4o)
# ---------------------------------------------------------------------------

_EVAL_CRITERIA: dict[str, str] = {
    "standard": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. "
        "If the response only contains a subset of the information required by the answer, answer no."
    ),
    "temporal-reasoning": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response is equivalent to the correct answer or contains all the intermediate "
        "steps to get the correct answer, you should also answer yes. "
        "If the response only contains a subset of the information required by the answer, answer no. "
        "In addition, do not penalize off-by-one errors for the number of days. "
        "If the question asks for the number of days/weeks/months, etc., and the model makes "
        "off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's "
        "response is still correct."
    ),
    "knowledge-update": (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
        "If the response contains some previous information along with an updated answer, "
        "the response should be considered as correct as long as the updated answer is the "
        "required answer."
    ),
    "single-session-preference": (
        "I will give you a question, a rubric for desired personalized response, and a response "
        "from a model. Please answer yes if the response satisfies the desired response. "
        "Otherwise, answer no. The model does not need to reflect all the points in the rubric. "
        "The response is correct as long as it recalls and utilizes the user's personal "
        "information correctly."
    ),
    "unanswerable": (
        "I will give you an unanswerable question, an explanation, and a response from a model. "
        "Please answer yes if the model correctly identifies the question as unanswerable. "
        "The model could say that the information is incomplete, "
        "or some other information is given but the asked information is not."
    ),
}


def _get_criteria(question_type: str, question_id: str) -> str:
    if "_abs" in str(question_id) or question_type == "unanswerable":
        return _EVAL_CRITERIA["unanswerable"]
    return _EVAL_CRITERIA.get(question_type, _EVAL_CRITERIA["standard"])


def judge_answer(
    question_type: str,
    question_id: str,
    question_text: str,
    gold_answer: str,
    predicted_answer: str,
) -> dict:
    """Judge using GPT-4o with official LongMemEval prompts."""
    criteria = _get_criteria(question_type, question_id)

    if question_type == "single-session-preference":
        answer_label = "Rubric"
    elif question_type == "unanswerable":
        answer_label = "Explanation"
    else:
        answer_label = "Correct Answer"

    evidence = (
        f"Question: {question_text}\n\n"
        f"{answer_label}: {gold_answer}\n\n"
        f"Model Response: {predicted_answer}"
    )

    verdict_question = (
        "Does the model correctly identify the question as unanswerable? Answer yes or no only."
        if question_type == "unanswerable"
        else "Is the model response correct? Answer yes or no only."
    )
    prompt = f"{criteria}\n\n{evidence}\n\n{verdict_question}"

    oai = openai.OpenAI()
    start = time.time()

    response = oai.chat.completions.create(
        model=_JUDGE_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=16,
    )

    raw = (response.choices[0].message.content or "").strip().lower()
    verdict = "CORRECT" if raw.startswith("yes") else "INCORRECT"

    return {
        "verdict": verdict,
        "raw_response": raw,
        "latency_ms": int((time.time() - start) * 1000),
    }


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def _question_type_to_ability(qt: str) -> str:
    mapping = {
        "single-session-user": "information_extraction",
        "single-session-assistant": "information_extraction",
        "single-session-preference": "information_extraction",
        "multi-session": "multi_session_reasoning",
        "temporal-reasoning": "temporal_reasoning",
        "knowledge-update": "knowledge_update",
        "unanswerable": "abstention",
    }
    return mapping.get(qt, "information_extraction")


def run_question(
    client: _PersistentStrataClient,
    question: dict,
    *,
    skip_judge: bool = False,
    max_agent_steps: int = _MAX_AGENT_STEPS,
) -> dict:
    """Run a single LongMemEval question: ingest -> agent loop -> judge."""
    qid = question["question_id"]
    qtype = question["question_type"]
    qtext = question["question"]
    qdate = question.get("question_date", "")
    gold = question["answer"]
    gold_sessions = question.get("answer_session_ids", [])
    ability = _question_type_to_ability(qtype)
    project = f"lme-{qid}"

    # Phase 1: Ingest (with caching)
    if _is_cached(qid):
        print(f"  [Q{qid}] Using cached ingestion")
    else:
        print(f"  [Q{qid}] Ingesting...", end=" ", flush=True)
        meta = ingest_question(client, question, project)
        print(f"{meta['total_turns']} turns, {meta['total_sessions']} sessions, {meta['total_entries']} entries")

    # Phase 2: Agent loop (search + answer)
    agent_result = run_agent_loop(
        client, project, qtext, qtype, qdate, max_steps=max_agent_steps,
    )

    tool_seq = " -> ".join(
        tc["tool"].replace("search_", "s_").replace("history", "hist")
        for tc in agent_result["tool_log"]
    )
    answer_preview = agent_result["answer"][:100].replace("\n", " ")
    print(f"  [Q{qid}] ({qtype}) {agent_result['tool_calls']} calls [{tool_seq}]")
    print(f"  [Q{qid}] Answer: {answer_preview}")

    result: dict[str, Any] = {
        "question_id": qid,
        "question_type": qtype,
        "ability": ability,
        "question": qtext,
        "gold_answer": gold,
        "gold_session_ids": gold_sessions,
        "predicted_answer": agent_result["answer"],
        "tool_calls": agent_result["tool_calls"],
        "tool_log": agent_result["tool_log"],
        "answer_latency_ms": agent_result["latency_ms"],
        "answer_model": _ANSWER_MODEL,
    }

    # Phase 3: Judge (optional)
    if not skip_judge:
        judge_result = judge_answer(qtype, qid, qtext, gold, agent_result["answer"])
        result["verdict"] = judge_result["verdict"]
        result["judge_raw"] = judge_result["raw_response"]
        result["judge_latency_ms"] = judge_result["latency_ms"]
        result["judge_model"] = _JUDGE_MODEL
        symbol = "+" if judge_result["verdict"] == "CORRECT" else "-"
        print(f"  [Q{qid}] Judge: {judge_result['verdict']} ({symbol})")
    else:
        result["verdict"] = "SKIPPED"

    return result
