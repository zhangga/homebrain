# Adaptive Learning Profile Implementation Plan

> **Status:** Implemented, reviewed, and verified on 2026-07-16.

**Goal:** Turn topic learning into a durable coaching loop that diagnoses the learner, personalizes the route, revises future lessons from every answer, follows up on stalled lessons, and presents the plan as a polished HTML learning map.

**Architecture:** Extend `LearningPlan` with an optional topic-only learner profile, assessment questions, route revision metadata, and session follow-up state. `KnowledgeEngine` owns all model calls: initial assessment design, assessment interpretation, lesson generation, and structured feedback that returns both mastery evidence and a revised future route. `LearningPlanStore` remains the single durable state-transition boundary, while `LearningScheduler` delivers lessons and bounded follow-up nudges. The existing Hono management page renders the resulting profile, route, evidence, and history without client-side dependencies.

**Tech Stack:** Bun, TypeScript, Hono server-rendered HTML, existing local CLI-backed `LlmClient`, JSON persistence, Bun tests.

---

## File Structure

- `packages/core/src/learning.ts` — learner profile types, migration defaults, assessment completion, route revision, follow-up persistence.
- `packages/core/src/engine.ts` — assessment/profile prompts, structured validation, adaptive feedback, profile-aware lesson generation.
- `packages/orchestrator/src/learning-commands.ts` — conversational assessment flow and profile/route summaries.
- `packages/app/src/learning-scheduler.ts` — due lesson policy plus bounded stalled-lesson follow-up.
- `packages/app/src/main.ts` — Feishu delivery wiring for learning follow-ups.
- `packages/core/src/governance.ts` — portable archive parsing for new optional learning fields.
- `packages/web/src/views.ts` — editorial learning-map HTML and scoped visual design.
- `README.md` — document the diagnostic and adaptive loop.
- Existing `*.test.ts` files beside each module — behavior coverage at the public store, engine, command, scheduler, archive, and HTTP seams.

### Task 1: Persist a learner profile and assessment state

**Files:**
- Modify: `packages/core/src/learning.ts`
- Test: `packages/core/src/learning.test.ts`

- [x] **Step 1: Add a store test for an assessment-pending topic plan**

Create a topic plan with assessment questions and assert that it persists:

```ts
expect(plan.profile).toEqual(expect.objectContaining({
  status: "assessing",
  level: "unknown",
  revision: 0,
}));
expect(plan.assessmentQuestions).toEqual([
  "你已经做过哪些相关项目？",
  "请解释一个核心概念。",
]);
expect(new LearningPlanStore(dir).get(plan.id)).toEqual(plan);
```

- [x] **Step 2: Implement the profile types and safe migration defaults**

Add:

```ts
export type LearnerLevel = "unknown" | "beginner" | "intermediate" | "advanced";
export type LearningPace = "gentle" | "steady" | "intensive";

export interface LearnerProfile {
  status: "assessing" | "active";
  level: LearnerLevel;
  levelRationale: string;
  goals: string[];
  strengths: string[];
  gaps: string[];
  preferences: string[];
  pace: LearningPace;
  dailyMinutes: number;
  evidence: string[];
  revision: number;
  updatedAt: number;
}
```

Extend topic plans with `profile`, `assessmentQuestions`, `routeVersion`, and `lastRouteAdjustment`. Reading plans retain `undefined` profile fields. During load, old topic plans receive an active profile with `level: "unknown"` so existing plans continue delivering lessons.

- [x] **Step 3: Add an atomic assessment-completion transition**

Expose:

```ts
completeAssessment(
  planId: string,
  actorId: string,
  input: {
    answers: string;
    profile: Omit<LearnerProfile, "status" | "revision" | "updatedAt">;
    route: { title: string; objective: string }[];
    adjustment: string;
  },
  at?: number,
): LearningPlan | undefined
```

It must verify ownership, replace only an untouched provisional route, activate the first customized step, increment `routeVersion`, persist the assessment evidence, and set the profile status to `active`.

- [x] **Step 4: Run the store tests**

Run:

```bash
bun test packages/core/src/learning.test.ts
```

Expected: all learning store tests pass.

### Task 2: Diagnose the learner and continuously revise the route

**Files:**
- Modify: `packages/core/src/engine.ts`
- Modify: `packages/core/src/learning.ts`
- Test: `packages/core/src/learning-engine.test.ts`

- [x] **Step 1: Generate useful assessment questions with the provisional route**

Change the topic-route structured result to:

```ts
interface TopicRouteResult {
  name: string;
  assessmentQuestions: string[];
  steps: { title: string; objective: string }[];
}
```

Require 3–6 questions covering prior experience, conceptual understanding, practical ability, target outcome, available time, and preferred learning mode. Persist the plan in `profile.status === "assessing"`.

- [x] **Step 2: Add assessment interpretation**

Expose:

```ts
answerLearningAssessment(
  planId: string,
  actorId: string,
  answers: string,
  now?: number,
): Promise<LearningPlan>
```

The structured model result must contain:

```ts
{
  level: "beginner" | "intermediate" | "advanced";
  levelRationale: string;
  goals: string[];
  strengths: string[];
  gaps: string[];
  preferences: string[];
  pace: "gentle" | "steady" | "intensive";
  dailyMinutes: number;
  evidence: string[];
  adjustment: string;
  steps: { title: string; objective: string }[];
}
```

Clamp daily time to 10–90 minutes and route length to 2–12 steps before passing it to the store.

- [x] **Step 3: Make lessons profile-aware**

Include the current level, goals, strengths, gaps, preferred mode, daily time, and latest route adjustment in `topicLearningGuidePrompt`. Require the practice task to fit the daily-time budget and target the current evidence-backed gap.

- [x] **Step 4: Return profile evidence and a revised future route from every topic answer**

Extend `TopicFeedbackResult` with:

```ts
level: "beginner" | "intermediate" | "advanced";
levelRationale: string;
strengths: string[];
gaps: string[];
evidence: string[];
pace: "gentle" | "steady" | "intensive";
dailyMinutes: number;
routeAdjustment: string;
upcomingSteps: { title: string; objective: string }[];
```

When completing a topic session, preserve completed/current history and atomically replace only the pending future route. Increment profile revision and route version, deduplicate evidence, and keep the total route bounded to 12 steps.

- [x] **Step 5: Run engine tests and typecheck**

Run:

```bash
bun test packages/core/src/learning-engine.test.ts
bun run typecheck
```

Expected: both commands pass.

### Task 3: Expose the assessment conversation and stalled-lesson follow-up

**Files:**
- Modify: `packages/orchestrator/src/learning-commands.ts`
- Modify: `packages/app/src/learning-scheduler.ts`
- Modify: `packages/app/src/main.ts`
- Test: `packages/orchestrator/src/learning-commands.test.ts`
- Test: `packages/app/src/learning-scheduler.test.ts`

- [x] **Step 1: Return the diagnostic questionnaire from `/learn topic`**

The creation response must contain the numbered questions and:

```text
请按编号回复，并以“学习回答：”开头。完成诊断后，我会重做路线并开始每日学习。
```

- [x] **Step 2: Route `学习回答：` to an assessment before a lesson**

`handleLearningAnswer` first finds owned topic plans with `profile.status === "assessing"`. If exactly one exists, call `answerLearningAssessment` and return the learner level, rationale, recommended pace, daily minutes, strengths, gaps, and customized route. Existing awaiting-lesson behavior remains unchanged.

- [x] **Step 3: Persist bounded follow-up state**

Extend `LearningSession` with:

```ts
lastFollowUpAt?: number;
followUpCount?: number;
```

Add `markFollowedUp(sessionId, at)` to increment the count only after successful delivery.

- [x] **Step 4: Send one friendly follow-up per day after 24 hours**

Add a scheduler `followUp` callback. An `awaiting_reply` session becomes due for follow-up when it was delivered at least 24 hours ago, has not been followed up today, and has fewer than three follow-ups. The message must mention the current step, reassure the learner that the plan waits for them, and show the exact answer/skip commands.

- [x] **Step 5: Run command and scheduler tests**

Run:

```bash
bun test packages/orchestrator/src/learning-commands.test.ts
bun test packages/app/src/learning-scheduler.test.ts
```

Expected: all tests pass.

### Task 4: Render a polished HTML learning map

**Files:**
- Modify: `packages/web/src/views.ts`
- Test: `packages/web/src/app.test.ts`

- [x] **Step 1: Add HTTP-level assertions for the learning map**

Create an assessed topic plan and assert the detail page contains:

```ts
expect(body).toContain("学习者画像");
expect(body).toContain("当前判断");
expect(body).toContain("知识优势");
expect(body).toContain("待补齐");
expect(body).toContain("路线已迭代");
expect(body).toContain("learning-map");
```

Also assert an assessing plan shows the unanswered diagnostic questions.

- [x] **Step 2: Implement an editorial “field notebook” visual direction**

Keep Hono escaping and server rendering. Add a scoped `.learning-studio` root with warm paper colors, deep ink typography, amber/teal status accents, a conic progress dial, an asymmetric profile grid, and a vertical route trail. Use `Songti SC`/Georgia for display text and `Avenir Next`/`PingFang SC` for body text. Avoid external assets and preserve mobile responsiveness.

- [x] **Step 3: Show the complete adaptive state**

The selected topic page must show:

- assessment status or current level and rationale;
- goal, pace, daily minutes, strengths, gaps, preferences, and recent evidence;
- progress dial and route version;
- every route step with state, objective, and attempts;
- latest route adjustment and next focus;
- current lesson/follow-up state;
- recent answer feedback;
- supplied source materials;
- existing schedule, pause/resume, and delete controls.

- [x] **Step 4: Run web tests**

Run:

```bash
bun test packages/web/src/app.test.ts
```

Expected: all web tests pass.

### Task 5: Preserve archives, document behavior, and verify the repository

**Files:**
- Modify: `packages/core/src/governance.ts`
- Modify: `packages/core/src/governance.test.ts`
- Modify: `README.md`

- [x] **Step 1: Parse new optional learning fields safely**

Teach archive parsing to validate profile enums, bounded arrays, daily minutes, assessment questions, route version/adjustment, and follow-up timestamps/counts. Older archives receive the same migration defaults as local `learning.json`.

- [x] **Step 2: Document the actual loop**

Update the learning section to describe:

```text
主题创建 → 入学诊断 → 个性化路线 → 每日一课 → 回答反馈
→ 画像与后续路线迭代 → 最多三次未作答跟进
```

Keep the explicit disclosure that topic expansion does not automatically browse the web.

- [x] **Step 3: Run focused and full verification**

Run:

```bash
bun test packages/core/src/learning.test.ts packages/core/src/learning-engine.test.ts packages/core/src/governance.test.ts
bun test packages/orchestrator/src/learning-commands.test.ts packages/app/src/learning-scheduler.test.ts packages/web/src/app.test.ts
bun run typecheck
bun test
```

Expected: all commands pass.

- [x] **Step 4: Review and commit**

Review the diff for state-machine integrity, backward compatibility, prompt-injection boundaries, HTML escaping, responsive behavior, and unrelated changes. Then commit:

```bash
git add docs/superpowers/plans/2026-07-16-adaptive-learning-profile.md packages README.md
git commit -m "feat: add adaptive learner profiles"
```
