# Job Filtering Rules

## Acceptance Criteria

| Condition | Action | Priority |
|-----------|--------|----------|
| budget >= $2.00 | ACCEPT | HIGH |
| budget >= $0.50 | ACCEPT | MEDIUM |
| budget < $0.50 | DECLINE | — |
| prompt contains "illegal" OR "harm" OR "exploit" | DECLINE | — |
| prompt contains "build" OR "create" OR "design" | ACCEPT | HIGH |
| prompt contains "write" OR "tweet" OR "copy" OR "content" | ACCEPT | HIGH |
| prompt contains "vsl" OR "video sales letter" OR "sales script" OR "voiceover" | ACCEPT | HIGH |
| prompt contains "ugc" OR "ugc script" OR "creator script" OR "tiktok script" OR "ad script" | ACCEPT | HIGH |
| prompt contains "translate" OR "rewrite" OR "edit" OR "improve" | ACCEPT | HIGH |
| prompt contains "summarize" OR "summarise" OR "tldr" OR "summary" | ACCEPT | MEDIUM |
| prompt contains "plan" OR "strategy" OR "roadmap" OR "outline" | ACCEPT | MEDIUM |
| prompt contains "help" OR "how do I" OR "what is" OR "explain" | ACCEPT | MEDIUM |
| prompt contains "image" OR "generate image" OR "draw" OR "illustration" | DECLINE | Outside scope |
| prompt contains "code" OR "function" OR "algorithm" OR "debug" | ACCEPT | HIGH |
| prompt contains "website" OR "landing page" OR "app" | ACCEPT | HIGH |
| prompt contains "research" OR "analyze" OR "explain" | ACCEPT | MEDIUM |

## Decision Logic

```
IF budget >= 0.50 AND
   NOT contains_blocked_terms(prompt)
THEN accept_job()
ELSE decline_job(reason)
```

## Blocked Terms
- illegal, harm, exploit, violence, abuse, nsfw
