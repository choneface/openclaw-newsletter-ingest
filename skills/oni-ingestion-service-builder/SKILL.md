---
name: oni-ingestion-service-builder
description: Guide a user question-by-question to gather the purpose, Gmail newsletter sources, polling freshness, downstream usage, parsing goals, and schema fields needed to create an ONI namespace spec. Use before writing an ONI spec.yaml, prompt.md, schema.yaml, or sources.yaml when requirements are still conversational or incomplete.
---

# ONI Ingestion Service Builder

Use this skill before creating or updating an ONI namespace spec. The goal is to turn a user's rough idea into a complete, spec-ready brief for `oni init`.

Ask one question at a time. Keep the interview short, adapt follow-ups to the user's answers, and avoid asking for fields already implied by prior answers.

## Discovery Flow

1. Ask for the namespace purpose.
   - Capture the human label, such as "AI News", "Medical Journals", or "Things to Do in My City".
   - Propose a lowercase slug, such as `ai-news`, `medical-journals`, or `city-events`.
   - Decide whether the idea should be one namespace or several. Split namespaces when newsletters need different prompts or output schemas.

2. Ask how the data will be used.
   - Identify the downstream user or agent.
   - Capture the main jobs: alerts, daily briefings, semantic search, exact filtered queries, trend tracking, personal recommendations, research triage, CRM enrichment, or another workflow.
   - Ask what a good answer from the database should look like.

3. Ask what records should be extracted from each email.
   - Determine the record type: article, event, deal, paper, product update, funding round, job, task, recommendation, etc.
   - List the must-have fields and useful filters.
   - Prefer fields that agents will query, filter, sort, or summarize later.

4. Ask about newsletter sources.
   - For each source, gather a poller name, sender email or domain, newsletter description, and any identifying subject text.
   - Convert source clues into Gmail search queries using `from:`, `subject:`, `label:`, `to:`, exclusions, or multiple OR queries when needed.
   - Ask whether old matching emails should be backfilled or whether only new mail matters.

5. Ask freshness requirements.
   - Translate the user's need into `interval_minutes`.
   - Use 10-15 minutes for time-sensitive alerts, 30-60 minutes for active monitoring, and 1440 minutes for daily digests.
   - Ask about quiet hours or business-hour expectations only if the user mentions notification timing or operational load.

6. Ask for runtime details if missing and needed for the final spec.
   - `openclaw_env` dotenv path.
   - Preferred analyzer model/provider only if the user has a constraint.
   - Semantic search preference only if the downstream use case does or does not need meaning-based retrieval.

## Schema Guidance

Build the schema from the use case, not from the email layout.

Always consider:
- `title` or `name` as required text.
- `summary` as text when agents will brief humans.
- `url` or `link` as text when source follow-up matters.
- `published_at`, `event_date`, `deadline`, or `expires_on` as indexed text when time filtering matters.
- `source_name`, `author`, `organization`, `location`, `category`, `tags`, or `priority` when users will filter or group results.
- `metadata` as json for useful details that should not become first-class query fields yet.

Use `text`, `integer`, `number`, `boolean`, or `json`. Mark a field `required: true` only when a record without it is not useful. Add `index: true` for fields likely to appear in `oni query --where`, `--from`, `--to`, or sorting workflows.

## Prompt Guidance

The parsing prompt should describe:
- The record type and namespace purpose.
- What to include and exclude.
- How to handle uncertainty, missing fields, duplicates, and multiple records in one email.
- Any ranking or relevance rules from the user.
- Source-neutral instructions if multiple newsletters share the namespace.

Do not write a prompt that depends on one newsletter's layout unless the namespace has only that source.

## Final Brief

When the interview is complete, provide a concise handoff with:

```yaml
namespace_purpose: ""
namespace_slug: ""
interval_minutes:
openclaw_env: ""
downstream_use: ""
record_type: ""
pollers:
  - name: ""
    description: ""
    gmail_queries: []
schema_plan:
  record_name: ""
  table: ""
  root_key: ""
  columns: []
prompt_notes: []
semantic_search: true
backfill_notes: ""
unresolved_questions: []
```

If enough information is available, include a draft `spec.yaml`. If anything material is missing, list only the missing items instead of inventing values that could create the wrong Gmail query or schema.
