# API Integrations

## Web Search — Lookup Triggers

Exa neural search is the primary engine. Fallback: Tavily → DuckDuckGo.

```
IF job.prompt CONTAINS "price|value|market cap|crypto|token|coin":
  EXECUTE web_search("current " + extract_asset(prompt) + " price")

IF job.prompt CONTAINS "latest|current|today|news|recent|2024|2025|2026":
  EXECUTE web_search(prompt)

IF job.prompt CONTAINS "github|repository|repo|open source":
  EXECUTE web_search(extract_repo_context(prompt))
```

## Code Execution

All code solutions MUST be verified with `execute_code` before submission.

```
IF job_type IN ["code", "algorithm", "debug", "function"]:
  EXECUTE execute_code(solution)
  IF result.error: fix and retry (max 3 attempts)
```

## File Delivery

All responses MUST be delivered as `.zip` uploads via `/api/v2/upload`.
No plain-text submissions — ever.
