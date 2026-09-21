# JeetOS Agent System — Architecture

This is the multi-agent coaching layer for JeetOS. Instead of one generic
AI responding to everything, each domain has a specialized agent with its
own personality, scope, and rules — all sharing ONE brain (`memory.md`) so
nothing gets forgotten or contradicted between them.

## The Core Idea

> "Everything is psychological" — every missed task routes through the
> psychologist agent FIRST, before any domain coach, before any penalty.
> Root cause before solution, always.

## Files in This Folder

| File | Role |
|---|---|
| `memory.md` | Central shared brain. Every agent reads from and writes to this. Schema for user profile, excuse log, pattern index, stake ledger. |
| `psychologist.md` | First responder for every miss. Stateful — remembers prior solutions offered, distinguishes a first-time excuse from an unresolved repeat. |
| `stake-manager.md` | Handles financial stakes. Only acts on psychologist's verdict — never makes its own waive/charge call. |
| `insight-analyst.md` | Weekly cross-domain report. Finds correlations no single coach can see (e.g. sleep miss → next-day gym miss). |
| `fitness-coach.md` | Gym/training domain — PPL split, progressive overload, form. |
| `skincare-coach.md` | Skincare/haircare domain — AM/PM routines, tretinoin protocol. |
| `nutrition-coach.md` | Diet/supplement domain — macros, meal timing, stack management. |
| `sleep-coach.md` | Sleep domain — circadian consistency, wind-down protocol. |

## How a Missed Task Flows Through the System

```
Task missed
    │
    ▼
psychologist.md checks memory.md's excuse_log
    │
    ├── First time this reason appears
    │     → listens, offers ONE solution, logs it, WAIVES any stake
    │
    └── Same reason has appeared before
          │
          ├── Solution was tried, still didn't work
          │     → not avoidable, WAIVE again, offer a different fix
          │
          └── Solution was never actually tried
                → names it plainly, verdict: AVOIDABLE
                → stake-manager.md CHARGES (only if task is staked)
    │
    ▼
Domain coach (fitness/skincare/nutrition/sleep) only engages AFTER
psychologist has triaged — handles the practical "how to fix it" layer
    │
    ▼
Everything gets written back to memory.md
    │
    ▼
insight-analyst.md aggregates weekly → Telegram report with wins,
weak links, unresolved patterns, and one experiment for next week
```

## Why Memory Is Central (Not Per-Agent)

Before this design, an AI coach would ask "why did you miss this" every
single time, forever, with no memory of what was already discussed. That's
exhausting and eventually gets ignored — which is part of why the original
JeetOS reminders sat 168 days overdue.

With `memory.md` as the shared brain:
- psychologist.md never re-asks something it already has an answer to
- stake-manager.md never charges based on a guess — only a confirmed,
  memory-backed pattern
- insight-analyst.md can see across ALL domains at once, which is the
  one thing no single coach agent is positioned to do

## Design Principles (Keep These When Adding New Agents)

1. **Psychologist is always first-in on a miss.** No coach agent
   short-circuits this, ever.
2. **No agent invents its own memory.** Everything lives in `memory.md`.
   Read the relevant section, write back after every meaningful
   interaction.
3. **Charges are rare and evidence-based.** The only path to a stake
   charge is: same excuse category, a solution was already offered,
   confirmed not attempted. Never charge on a first miss. Never charge
   on a guess.
4. **No agent nags.** Coaches respond to direct questions or post-triage
   handoffs — they don't independently fire reminders outside their lane.
5. **Weekly, not daily, for the big picture.** insight-analyst.md is the
   only place cross-domain pattern data surfaces in aggregate — keeps
   daily interactions light and keeps the weekly report meaningful
   instead of repetitive.

## Adding a New Agent (Template)

```markdown
---
name: [agent-name]
role: [one line — what domain, what it does NOT do]
tone: [personality]
data_access: [memory.md sections it reads]
---

## Scope
## Core Knowledge
## Behavior Rules
## Handoff Rules (must reference psychologist.md for any miss)
```

Every new agent must specify what it does NOT handle as clearly as what
it does — scope creep between agents is exactly what memory.md and this
architecture are designed to prevent.
