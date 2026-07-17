# Quality Feedback Workbench Implementation Plan

**Goal:** Turn durable answer feedback into an operational, local-first quality review loop before expanding the fixed evaluation dataset.

**Architecture:** Keep the existing FTS + LLM routing and bounded `quality.json` store. Join negative feedback with its answer trace, persist review state and human-curated evaluation candidates atomically, and expose the workflow through the authenticated management backend. Never auto-learn from negative feedback or write private runtime questions into the repository evaluation fixture.

## Requirements

- [x] List open `unhelpful` and `citation_error` feedback with question, observed answer, spaces, latency, feedback note, and citations.
- [x] Link citations to the existing knowledge-page correction workflow.
- [x] Promote a negative feedback item once into a durable, bounded evaluation candidate containing the observed answer, citations, feedback context, and curator note.
- [x] Reject helpful feedback and duplicate promotion attempts.
- [x] Mark an item resolved with a human resolution note and retain it in a resolved-history view.
- [x] Export local evaluation candidates as versioned JSON for later manual calibration into the fixed evaluation suite.
- [x] Keep health snapshots aggregate-only and keep all question/answer/candidate content on the user's machine.
- [x] Preserve the project's no-embedding architecture and do not change retrieval or answer behavior.

## Public test seams

- `QualityStore` / `KnowledgeEngine`: durable review listing, promotion, resolution, restart behavior, validation, and bounded candidate access.
- Management HTTP interface: workbench rendering, citation links, promotion, resolution history, duplicate rejection, and JSON export.

## Verification

- [x] Focused core and web tests.
- [x] TypeScript type check.
- [x] Full repository test suite and fixed AI quality evaluation.
- [x] Two-axis code review and final commit.
