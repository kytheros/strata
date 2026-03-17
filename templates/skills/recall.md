# Recall

context: fork

Search Strata memory for past conversations, decisions, solutions, and knowledge.

## Instructions

You are performing a multi-step search across the user's AI coding conversation history using Strata MCP tools.

### Process

1. **Broad search**: Use `search_history` with the user's query to find initial results
2. **Solution check**: If the query relates to an error or problem, also call `find_solutions` with the error text
3. **Refine**: Based on initial results, identify key projects or terms and run a narrower search
4. **Context**: Use `get_session_summary` on the most relevant session for full context
5. **Synthesize**: Combine findings into a concise answer with session references

### Output Format

Provide:
- **Answer** (3-5 sentences) synthesizing what Strata found
- **Key findings** with session IDs as citations
- **Confidence** (high/medium/low) based on result quality and relevance

If nothing is found, say so clearly and suggest what the user could `store_memory` to fill the gap.
