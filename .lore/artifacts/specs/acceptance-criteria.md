---
id: acceptance-criteria
title: Acceptance Criteria Specification
summary: >
  The shape of an acceptance-criteria specification — every behaviour as
  Given/When/Then under a citable id and a P0/P1/P2 priority, followed by the
  settled decisions, the assumptions filled in, what is out of scope, and the
  milestones the priorities imply. Read this before writing or extending a
  spec; copy the skeleton at the end.
---

# Acceptance Criteria Specification

One document holds every behaviour a product must have, written so that a
person with no access to the implementation can check each one. It is the
document a builder works from and the document finished work is audited
against.

## Rules

**Ids.** A capitalised group prefix and a two-digit number: `WS-01`, `TERM-04`,
`PLT-07`. The prefix names the group, not the section number, so sections can
be reordered without touching an id. Numbers run in order within a group and
are never reused or renumbered. A criterion inserted between two existing ones
takes a letter suffix — `TREE-05a`, `ED-12b`. The id is the citation handle:
conversation, commit messages, quests and codex documents all name it, so an id
that moves breaks every reference behind it.

**Priorities.** Each criterion carries exactly one, after its title behind a
`·`. P0 — the product does not exist without it. P1 — the product is unpleasant
without it. P2 — wanted, deliberately deferred. The priorities decide the
milestone plan in the last section; a P0 that appears in no milestone is a
mistake in one of the two.

**Given / When / Then.** Three bullets with the keyword bolded. *Given* is the
state before, with concrete paths, counts and names rather than "some files".
*When* is one action by a named actor. *Then* is what is observably true
afterwards. A second action on the same state continues as `**And when**` /
`**Then**`; a further fact about the same outcome continues as `**And**`.

**One criterion, one behaviour.** When a *Then* contains an "and also" that
could hold while the first half fails, it is two criteria.

**Observable, not prescriptive.** A criterion says what is true after the
action, not how the code gets there. The exception is a mechanism that is
itself the requirement — reading the shell's working directory from
`/proc/<pid>/cwd`, saving through a temp file and a rename — where naming it is
the point of the criterion.

**Groups.** `## N. Group name`, numbered in reading order with the
load-bearing mechanism first. A group gets one or two sentences under its
heading only when the name does not carry it.

**Constraints that fail silently are criteria too.** A wrong application id, an
unset environment variable, a version floor set too low — each is written as
Given/When/Then in its own group, because a constraint nobody can check is a
constraint nobody keeps.

**Settled decisions** is a table of every question the owner answered, the
answer in bold. It exists so no criterion has to re-argue a choice.

**Assumptions filled in** is a numbered list of every gap closed without
asking, each naming the ids it is load-bearing for and phrased so the owner can
correct it in one line. This section is what makes it safe to write the spec
before every question has an answer.

**Deliberately out of scope** records what was considered and rejected, so it
reads as a decision rather than an oversight.

**Milestones** cut the criteria into shippable sets by priority, each stating
what is true at the end of it.

**Voice.** Present tense, a named actor for every behaviour, no hedges, no
sales register, written for a reader arriving cold —
`lore artifact show codex-voice` is the full rule set.

**Where it lives.** `working/acceptance-criteria.md`, git-ignored. It is the
in-flight specification: as behaviour is built, its facts move into codex
documents, which are version controlled.

---

## Skeleton

```markdown
# {Product} — Acceptance Criteria

Status: {draft | agreed} · {greenfield | revision} · {date}

Every criterion is written as Given / When / Then, grouped by the part of the
product it defines. Each carries an id and a priority:

| Priority | Meaning |
|---|---|
| **P0** | The product does not exist without it. First milestone. |
| **P1** | The product is unpleasant without it. Second milestone. |
| **P2** | Wanted, deliberately deferred. |

Decisions already settled with the product owner are recorded in
[§{n} Settled decisions](#{n}-settled-decisions). Gaps filled in by assumption —
correct these first — are in [§{n} Assumptions](#{n}-assumptions-filled-in).

---

## 1. {Group name}

{One or two sentences on what this group covers, when the name does not carry
it. Say why it leads.}

### {PREFIX}-01 — {Short title} · P0
- **Given** {the state before, with concrete paths, counts and names}
- **When** {one action by a named actor}
- **Then** {what is observably true afterwards}

### {PREFIX}-02 — {Short title} · P1
- **Given** {state}
- **When** {action}
- **Then** {outcome}
- **And when** {a second action on the same state}
- **Then** {its outcome}

---

## 2. {Group name}

### {PREFIX2}-01 — {Short title} · P0
- **Given** {state}
- **When** {action}
- **Then** {outcome}

---

## {n}. Settled decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | {The question the owner answered} | **{The answer}** — {its consequence, one clause} |

---

## {n}. Assumptions filled in

These were not asked about. Correct any that are wrong before implementation
starts — each is load-bearing for the criteria above.

1. **{Subject}** — {the assumption, and the ids it serves ({PREFIX}-01)}.
2. **{Subject}** — {the assumption, and why this default rather than another}.

---

## {n}. Deliberately out of scope

Recording these so they are decisions rather than oversights.

- {What was considered and rejected}

---

## {n}. Proposed milestones

**M1 — {what is true at the end of it}.** §{n} ({group}), §{n} ({group}),
§{n} P0 ({group}). {One sentence on why this cut comes first.}

**M2 — {what is true at the end of it}.** §{n} ({group}), §{n} ({group}).

**M3 — the P2 tail.** {The deferred criteria, and any that are worth doing
together.}
```
