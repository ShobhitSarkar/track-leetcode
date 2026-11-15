// Supabase Edge Function: drills
//
// Backs the Drills tab: whiteboard-style interview practice that isn't about
// recall. Every drill is generated fresh so the user meets an unfamiliar
// problem cold, works it under a soft time limit, and gets graded.
//
// One function, three actions (POST JSON with an `action` field):
//
//   generate   { kind, difficulty?, focus?, avoid?[] }      -> { exercise }
//   followups  { kind: 'system_design', exercise, response } -> { questions }
//   grade      { kind, exercise, response, followups?, duration_sec? } -> { grade }
//
// kinds: 'pr_review' | 'debugging' | 'system_design'. All code is Python.
//
// The exercise carries its own answer key (planted PR issues, the real root
// cause, system-design key points). The client stores it with the attempt and
// hands it back at grading time, so this function stays stateless.
//
// Deploy:  supabase functions deploy drills   (CI does this on merge to main)
// Secrets: supabase secrets set OPENAI_API_KEY=sk-...
//          supabase secrets set DRILLS_MODEL=gpt-5.6-sol            (optional; this is the default)
//          supabase secrets set DRILLS_REASONING_EFFORT=medium      (optional; omitted unless set)
//
// DRILLS_MODEL is separate from OPENAI_MODEL on purpose: flashcards and
// suggestions are cheap, high-volume calls that a small model handles fine,
// while writing a believable buggy codebase and grading a design doc are
// where a larger model earns its cost.

// deno-lint-ignore-file no-explicit-any
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = Deno.env.get("DRILLS_MODEL") || "gpt-5.6-sol";
const EFFORT = Deno.env.get("DRILLS_REASONING_EFFORT") || "";
// Supabase caps an Edge Function's wall clock at 150s on the free plan, so the
// upstream call has to give up a little before that to return a clean error.
const UPSTREAM_TIMEOUT_MS = 140_000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

class HttpError extends Error {
  constructor(public status: number, message: string, public detail = "") { super(message); }
}

type Kind = "pr_review" | "debugging" | "system_design";
const KINDS = new Set<Kind>(["pr_review", "debugging", "system_design"]);
const LEVELS = ["Junior", "Mid", "Senior"] as const;

// ---------------------------------------------------------------------------
// Small sanitisers. Everything that came from the client or the model is
// clamped before it is used, so a malformed payload can't blow up the prompt
// or the response.
// ---------------------------------------------------------------------------
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const strList = (v: unknown, maxItems: number, maxLen: number) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim().slice(0, maxLen)).slice(0, maxItems)
    : [];
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof v === "string" && (allowed as readonly string[]).includes(v) ? v as T : fallback);
const intIn = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

const level = (v: unknown) => oneOf(v, LEVELS, "Mid");

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------
async function callModel(system: string, user: string): Promise<any> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new HttpError(500, "OPENAI_API_KEY not configured");

  // No temperature or max-token knobs: current reasoning models reject custom
  // temperature, and the token parameter name has changed across generations.
  const body: Record<string, unknown> = {
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (EFFORT) body.reasoning_effort = EFFORT;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(OPENAI_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const aborted = (e as any)?.name === "AbortError";
    throw new HttpError(aborted ? 504 : 502, aborted ? "model request timed out" : "model request failed");
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new HttpError(502, `openai ${resp.status}`, detail.slice(0, 500));
  }
  let data: any;
  try { data = await resp.json(); } catch { throw new HttpError(502, "openai returned non-JSON envelope"); }
  const raw = data?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") throw new HttpError(502, "openai returned no content");
  try { return JSON.parse(raw); } catch { throw new HttpError(502, "openai content was not JSON"); }
}

const SYSTEM_AUTHOR =
  "You write realistic software-engineering interview exercises for a senior engineer practising on their own. " +
  "All code is idiomatic, modern Python (3.11+). Exercises read like real work from a real codebase, never like a textbook. " +
  "Output only a single JSON object matching the schema the user gives you, with no prose outside it.";

const SYSTEM_GRADER =
  "You are a demanding but fair interviewer at a top software company, grading a practice attempt. " +
  "Calibrate to the stated level. Be specific: quote or reference the candidate's own words, name what was missed, and say what a strong answer would have done instead. " +
  "Never invent things the candidate said. Output only a single JSON object matching the schema the user gives you.";

const avoidBlock = (avoid: string[]) =>
  avoid.length ? `\nDo not repeat or closely resemble these recent exercises:\n${avoid.map((t) => `- ${t}`).join("\n")}\n` : "";

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------
function prReviewPrompt(lvl: string, focus: string, avoid: string[]) {
  const issueCount = lvl === "Junior" ? "3-4" : lvl === "Mid" ? "4-5" : "5-7";
  return `Create a pull-request review exercise.

Level: ${lvl}
Focus: ${focus || "your choice — vary it"}
${avoidBlock(avoid)}
Requirements
- The PR is a believable change to an existing codebase (a service, library, CLI, data job, etc.): 1-3 files touched, each file at most 150 lines, with roughly 40-160 changed lines in total.
- The PR description is written by the author, who believes the change is ready to merge. 3-8 lines of plain text: what and why, maybe a note on testing.
- Plant ${issueCount} issues a strong reviewer should catch, with mixed severity. Draw from: correctness bugs, unhandled edge cases, concurrency/race conditions, security (injection, authz, secrets, unsafe deserialisation), performance (N+1, quadratic loops, unbounded memory), error handling, breaking API/contract changes, missing or wrong tests, maintainability. At most one may be purely stylistic.${lvl === "Senior" ? " Include at least one subtle issue that only shows up when you think about production behaviour (concurrency, partial failure, data migration, backwards compatibility)." : ""}
- Every issue must be findable from the diff and the surrounding file content alone.
- Do NOT leave comments, TODOs or names in the code that hint at the issues.
- "before" and "after" are COMPLETE file contents and must be identical except for the PR's changes. Use "" for "before" when the PR adds a new file.

Return JSON:
{
  "title": "PR title as the author wrote it",
  "description": "PR description",
  "topic": "2-4 word focus label, e.g. 'Caching layer' or 'Auth middleware'",
  "files": [{ "path": "src/payments/refunds.py", "before": "...", "after": "..." }],
  "issues": [{
    "id": "i1",
    "file": "path exactly as in files",
    "snippet": "ONE line copied verbatim (whitespace included) from that file's 'after' content, where the issue is",
    "severity": "blocker | major | minor",
    "category": "correctness | security | performance | concurrency | error-handling | api-design | testing | maintainability",
    "title": "short name of the issue",
    "explanation": "why it matters and what the reviewer should ask for"
  }]
}`;
}

function debuggingPrompt(lvl: string, focus: string, avoid: string[]) {
  return `Create a debugging exercise.

Level: ${lvl}
Bug class to lean towards: ${focus || "your choice — vary it"}
${avoidBlock(avoid)}
What the candidate sees
- A bug report written by a teammate, a support ticket or an on-call alert: the symptom, expected vs actual behaviour, and how often or when it happens. It describes symptoms only and never names the cause.
- An optional excerpt of logs or a traceback (use "" if the report alone is more realistic). If you include a traceback, it must match the code exactly, including line numbers.
- 1-3 source files from a small realistic codebase, 80-240 lines in total.

Requirements
- Exactly ONE root cause (it may show up in more than one place). It must be findable by careful reading of the files and the report; no hidden files or external knowledge.
- Include 1-2 red herrings: code that looks suspicious but is correct.
- Realistic bug classes: shared mutable state, mutable default arguments, off-by-one or boundary handling, timezone/naive datetime handling, float or rounding errors with money, iterator exhaustion, late-binding closures, async/await mistakes (missing await, blocking call in the event loop), caching that keys on the wrong thing, incorrect exception handling that swallows errors, encoding issues, race conditions, wrong SQL or ORM semantics, integer/str type confusion from parsed input.
- ${lvl === "Junior" ? "The bug is in one function and the symptom points fairly directly at it." : lvl === "Mid" ? "The symptom shows up away from where the bug lives; tracing data across at least two functions is needed." : "The symptom is intermittent or shows up far from the cause; tracing across files and reasoning about runtime behaviour (state, ordering, concurrency, data shape) is needed."}
- Do NOT leave comments or names in the code that hint at the bug.

Return JSON:
{
  "title": "short ticket-style title describing the symptom (not the cause)",
  "topic": "2-4 word label for the bug class",
  "bug_report": "the report text",
  "logs": "log or traceback excerpt, or empty string",
  "files": [{ "path": "app/billing/invoice.py", "content": "..." }],
  "answer": {
    "file": "path of the file containing the root cause",
    "snippet": "ONE line copied verbatim from that file where the bug is",
    "root_cause": "precise explanation of the root cause and how it produces the symptom",
    "fix": "what to change and why",
    "patch": "the corrected version of the affected function(s)",
    "red_herrings": ["what looked suspicious but is fine, and why"],
    "verify": "how to prove the fix: a pytest test or reproduction steps"
  }
}`;
}

function systemDesignPrompt(lvl: string, focus: string, avoid: string[]) {
  return `Create a system design interview question.

Level: ${lvl}
Area: ${focus || "your choice — something that comes up in real interview loops but is not one of the most overdone classics"}
${avoidBlock(avoid)}
Return JSON:
{
  "title": "Design ...",
  "prompt": "the question as an interviewer would pose it: 2-5 sentences, leaving room for the candidate to ask clarifying questions",
  "scale": "the scale and constraints the interviewer reveals when asked, e.g. users, QPS, data size, latency targets",
  "tags": ["3-5 short concept tags"],
  "key_points": ["6-9 things a strong ${lvl} candidate should cover or decide, each one sentence and specific to this problem"]
}`;
}

type PrFile = { path: string; before: string; after: string };
function cleanPrExercise(raw: any, lvl: string) {
  const files: PrFile[] = (Array.isArray(raw?.files) ? raw.files : [])
    .filter((f: any) => f && typeof f.path === "string" && typeof f.after === "string")
    .slice(0, 4)
    .map((f: any) => ({ path: str(f.path, 200), before: str(f.before, 20000), after: str(f.after, 20000) }));
  if (!files.length) throw new HttpError(502, "model returned a PR with no files");
  const paths = new Set(files.map((f) => f.path));
  const issues = (Array.isArray(raw?.issues) ? raw.issues : [])
    .filter((i: any) => i && typeof i.title === "string")
    .slice(0, 10)
    .map((i: any, idx: number) => ({
      id: str(i.id, 20) || `i${idx + 1}`,
      file: paths.has(i.file) ? i.file : files[0].path,
      snippet: str(i.snippet, 400),
      severity: oneOf(i.severity, ["blocker", "major", "minor"] as const, "major"),
      category: str(i.category, 40) || "correctness",
      title: str(i.title, 160),
      explanation: str(i.explanation, 1500),
    }));
  if (!issues.length) throw new HttpError(502, "model returned a PR with no planted issues");
  return {
    kind: "pr_review",
    title: str(raw?.title, 160) || "Untitled PR",
    description: str(raw?.description, 3000),
    topic: str(raw?.topic, 60),
    difficulty: lvl,
    files,
    issues,
  };
}

function cleanDebugExercise(raw: any, lvl: string) {
  const files = (Array.isArray(raw?.files) ? raw.files : [])
    .filter((f: any) => f && typeof f.path === "string" && typeof f.content === "string")
    .slice(0, 4)
    .map((f: any) => ({ path: str(f.path, 200), content: str(f.content, 20000) }));
  if (!files.length) throw new HttpError(502, "model returned a debugging drill with no files");
  const a = raw?.answer || {};
  const answer = {
    file: files.some((f: any) => f.path === a.file) ? a.file : files[0].path,
    snippet: str(a.snippet, 400),
    root_cause: str(a.root_cause, 2500),
    fix: str(a.fix, 2500),
    patch: str(a.patch, 6000),
    red_herrings: strList(a.red_herrings, 4, 600),
    verify: str(a.verify, 3000),
  };
  if (!answer.root_cause) throw new HttpError(502, "model returned a debugging drill with no answer");
  return {
    kind: "debugging",
    title: str(raw?.title, 160) || "Untitled bug",
    topic: str(raw?.topic, 60),
    difficulty: lvl,
    bug_report: str(raw?.bug_report, 4000),
    logs: str(raw?.logs, 6000),
    files,
    answer,
  };
}

function cleanDesignExercise(raw: any, lvl: string) {
  const prompt = str(raw?.prompt, 3000);
  const key_points = strList(raw?.key_points, 12, 400);
  if (!prompt || !key_points.length) throw new HttpError(502, "model returned an incomplete design question");
  return {
    kind: "system_design",
    title: str(raw?.title, 160) || "Design a system",
    prompt,
    scale: str(raw?.scale, 2000),
    tags: strList(raw?.tags, 6, 40),
    key_points,
    difficulty: lvl,
    topic: strList(raw?.tags, 1, 40)[0] || "",
    source: "ai",
  };
}

async function generate(kind: Kind, payload: any) {
  const lvl = level(payload.difficulty);
  const focus = str(payload.focus, 120).trim();
  const avoid = strList(payload.avoid, 25, 160);
  if (kind === "pr_review") return cleanPrExercise(await callModel(SYSTEM_AUTHOR, prReviewPrompt(lvl, focus, avoid)), lvl);
  if (kind === "debugging") return cleanDebugExercise(await callModel(SYSTEM_AUTHOR, debuggingPrompt(lvl, focus, avoid)), lvl);
  return cleanDesignExercise(await callModel(SYSTEM_AUTHOR, systemDesignPrompt(lvl, focus, avoid)), lvl);
}

// ---------------------------------------------------------------------------
// followups (system design)
// ---------------------------------------------------------------------------
const PHASE_LABELS: Record<string, string> = {
  requirements: "Requirements",
  estimates: "Capacity estimates",
  api: "API",
  data_model: "Data model",
  high_level: "High-level design",
  deep_dive: "Deep dive",
  tradeoffs: "Tradeoffs & failure modes",
  diagram: "Diagram (ASCII / Mermaid)",
};

const designAnswerBlock = (response: any) =>
  Object.keys(PHASE_LABELS)
    .map((k) => `### ${PHASE_LABELS[k]}\n${str(response?.[k], 6000).trim() || "(left blank)"}`)
    .join("\n\n");

const designQuestionBlock = (ex: any) =>
  `Question: ${str(ex?.title, 160)}\n${str(ex?.prompt, 3000)}\n\nScale and constraints (revealed on request): ${str(ex?.scale, 2000) || "(none given)"}`;

async function followups(exercise: any, response: any) {
  const lvl = level(exercise?.difficulty);
  const prompt = `You are interviewing a ${lvl} candidate. They just walked you through their design.

${designQuestionBlock(exercise)}

Their design
------------
${designAnswerBlock(response)}

Ask exactly 3 follow-up questions, the way a sharp interviewer would in the last 10 minutes: probe the weakest or most hand-waved part of THIS design, a failure mode or scaling cliff it hasn't handled, and one tradeoff they should be able to defend. Each question is at most 2 sentences, refers to their specific design, and does not give away the answer.

Return JSON: { "questions": ["...", "...", "..."] }`;
  const raw = await callModel(SYSTEM_GRADER, prompt);
  const questions = strList(raw?.questions, 4, 500);
  if (!questions.length) throw new HttpError(502, "model returned no follow-up questions");
  return questions;
}

// ---------------------------------------------------------------------------
// grade
// ---------------------------------------------------------------------------
const GRADE_COMMON = `"score": 0-100 overall,
  "verdict": "Strong hire | Hire | Lean hire | Lean no hire | No hire",
  "summary": "2-4 sentences: the headline of how it went",
  "dimensions": [{ "name": "...", "score": 1-4 (1 weak, 2 below bar, 3 at bar, 4 strong), "comment": "one or two specific sentences" }],
  "strengths": ["specific things done well"],
  "improvements": ["specific, actionable things to do differently next time"]`;

const minutes = (sec: number) => (sec > 0 ? `${Math.round(sec / 60)} min` : "unknown");

function gradePrPrompt(ex: any, response: any, durationSec: number) {
  const files = (Array.isArray(ex?.files) ? ex.files : []).slice(0, 4);
  const fileBlock = files
    .map((f: any) => `--- ${str(f.path, 200)} (after the change) ---\n${str(f.after, 20000)}`)
    .join("\n\n");
  const issues = (Array.isArray(ex?.issues) ? ex.issues : []).slice(0, 10);
  const issueBlock = issues
    .map((i: any) => `- [${str(i.id, 20)}] (${str(i.severity, 10)}, ${str(i.category, 40)}) ${str(i.file, 200)}: ${str(i.title, 160)} — anchored at: ${str(i.snippet, 400)}\n  ${str(i.explanation, 1500)}`)
    .join("\n");
  const comments = (Array.isArray(response?.comments) ? response.comments : []).slice(0, 60);
  const commentBlock = comments.length
    ? comments
        .map((c: any) => `- [${str(c.id, 40)}] ${str(c.path, 200)} line ${intIn(c.line, 0, 100000, 0)} (${str(c.side, 4) || "new"}): \`${str(c.code, 300)}\`\n  ${str(c.body, 2000)}`)
        .join("\n")
    : "(no line comments)";
  return `Grade this pull-request review. Level: ${level(ex?.difficulty)}. Time taken: ${minutes(durationSec)}.

PR: ${str(ex?.title, 160)}
${str(ex?.description, 3000)}

Changed files
${fileBlock}

Answer key — issues planted in the PR (the candidate never saw this list)
${issueBlock}

The candidate's review
Decision: ${str(response?.decision, 40) || "(none)"}
Summary comment: ${str(response?.summary, 4000) || "(none)"}
Line comments:
${commentBlock}

How to grade
- An issue counts as caught ("yes") if any comment, or the summary, identifies the actual problem, even on a nearby line or in different words. "partial" if they noticed something off there but misdiagnosed it or missed why it matters.
- Judge every line comment: "matched" if it identifies a planted issue, "valid_extra" if it is a legitimate concern not in the key, "noise" if it is wrong, trivial nitpicking, or would waste the author's time.
- Weigh blockers and majors far above minors. Missing a blocker should cap the score at roughly 60. Approving a PR with an uncaught blocker is a serious miss.
- Also judge how the comments are written: specific, actionable, explaining why, suggesting a fix, appropriately prioritised, and respectful.

Use exactly these dimensions: "Issue detection", "Severity judgement", "Communication", "Review decision".

Return JSON:
{
  ${GRADE_COMMON},
  "issues": [{ "id": "issue id from the key", "caught": "yes | partial | no", "note": "one sentence" }],
  "comments": [{ "id": "comment id", "verdict": "matched | valid_extra | noise", "issue_id": "the matched issue id or null", "note": "one short sentence" }]
}`;
}

function gradeDebugPrompt(ex: any, response: any, durationSec: number) {
  const files = (Array.isArray(ex?.files) ? ex.files : []).slice(0, 4);
  const fileBlock = files.map((f: any) => `--- ${str(f.path, 200)} ---\n${str(f.content, 20000)}`).join("\n\n");
  const a = ex?.answer || {};
  return `Grade this debugging attempt. Level: ${level(ex?.difficulty)}. Time taken: ${minutes(durationSec)}.

Bug report
${str(ex?.bug_report, 4000)}

Logs
${str(ex?.logs, 6000) || "(none)"}

Source
${fileBlock}

Answer key (the candidate never saw this)
- Location: ${str(a.file, 200)}: ${str(a.snippet, 400)}
- Root cause: ${str(a.root_cause, 2500)}
- Fix: ${str(a.fix, 2500)}
- Red herrings: ${strList(a.red_herrings, 4, 600).join(" | ") || "(none)"}
- Verification: ${str(a.verify, 3000)}

The candidate's answer
Where the bug is: ${str(response?.location, 1000) || "(blank)"}
Root cause: ${str(response?.root_cause, 4000) || "(blank)"}
Fix: ${str(response?.fix, 6000) || "(blank)"}
How they'd verify it: ${str(response?.verify, 3000) || "(blank)"}
Investigation notes: ${str(response?.notes, 4000) || "(blank)"}

How to grade
- A fix that patches the symptom without addressing the root cause is at most "partial".
- Blaming a red herring is a real miss, but credit sound reasoning that eliminated suspects.
- Wrong root cause should cap the score at roughly 40, however polished the rest is.

Use exactly these dimensions: "Localisation", "Root cause", "Fix quality", "Verification".

Return JSON:
{
  ${GRADE_COMMON},
  "root_cause_found": "yes | partial | no"
}`;
}

function gradeDesignPrompt(ex: any, response: any, fu: any, durationSec: number) {
  const keyPoints = strList(ex?.key_points, 12, 400);
  const qa = (Array.isArray(fu) ? fu : []).slice(0, 4)
    .map((x: any, i: number) => `Q${i + 1}: ${str(x?.q, 500)}\nA${i + 1}: ${str(x?.a, 3000).trim() || "(no answer)"}`)
    .join("\n\n");
  return `Grade this system design attempt. Level: ${level(ex?.difficulty)}. Time taken: ${minutes(durationSec)} (a real round gives about 45 minutes).

${designQuestionBlock(ex)}

Key points a strong answer covers (the candidate never saw this list; use it as a guide, not a checklist to punish reasonable alternatives)
${keyPoints.map((k) => `- ${k}`).join("\n")}

The candidate's design
${designAnswerBlock(response)}

Interviewer follow-ups
${qa || "(skipped)"}

How to grade
- Reward clear requirement scoping, numbers that drive decisions, explicit tradeoffs, and depth on the hard part of THIS problem. Penalise generic boilerplate ("add a load balancer and a cache") that isn't tied to the requirements.
- A different but well-justified design is fine. Mark a key point "yes" if the design addresses its substance some other way.
- Factor the follow-up answers into depth and tradeoffs.

Use exactly these dimensions: "Requirements & scope", "Estimation", "API & data model", "Architecture", "Depth", "Tradeoffs & communication".

Return JSON:
{
  ${GRADE_COMMON},
  "key_points": [{ "point": "the key point", "covered": "yes | partial | no", "note": "one short sentence" }],
  "model_outline": "a compact outline of a strong answer for THIS question, 8-15 short lines separated by newlines"
}`;
}

function cleanGrade(kind: Kind, raw: any) {
  const dimensions = (Array.isArray(raw?.dimensions) ? raw.dimensions : [])
    .filter((d: any) => d && typeof d.name === "string")
    .slice(0, 8)
    .map((d: any) => ({ name: str(d.name, 60), score: intIn(d.score, 1, 4, 2), comment: str(d.comment, 800) }));
  const out: Record<string, unknown> = {
    score: intIn(raw?.score, 0, 100, 0),
    verdict: oneOf(raw?.verdict, ["Strong hire", "Hire", "Lean hire", "Lean no hire", "No hire"] as const, "Lean no hire"),
    summary: str(raw?.summary, 2000),
    dimensions,
    strengths: strList(raw?.strengths, 8, 600),
    improvements: strList(raw?.improvements, 8, 600),
    model: MODEL,
  };
  if (kind === "pr_review") {
    out.issues = (Array.isArray(raw?.issues) ? raw.issues : []).slice(0, 12).map((i: any) => ({
      id: str(i?.id, 20),
      caught: oneOf(i?.caught, ["yes", "partial", "no"] as const, "no"),
      note: str(i?.note, 500),
    }));
    out.comments = (Array.isArray(raw?.comments) ? raw.comments : []).slice(0, 80).map((c: any) => ({
      id: str(c?.id, 40),
      verdict: oneOf(c?.verdict, ["matched", "valid_extra", "noise"] as const, "valid_extra"),
      issue_id: typeof c?.issue_id === "string" ? c.issue_id.slice(0, 20) : null,
      note: str(c?.note, 400),
    }));
  } else if (kind === "debugging") {
    out.root_cause_found = oneOf(raw?.root_cause_found, ["yes", "partial", "no"] as const, "no");
  } else {
    out.key_points = (Array.isArray(raw?.key_points) ? raw.key_points : []).slice(0, 12).map((k: any) => ({
      point: str(k?.point, 400),
      covered: oneOf(k?.covered, ["yes", "partial", "no"] as const, "no"),
      note: str(k?.note, 400),
    }));
    out.model_outline = str(raw?.model_outline, 4000);
  }
  if (!out.summary && dimensions.length === 0) throw new HttpError(502, "model returned an empty grade");
  return out;
}

async function grade(kind: Kind, payload: any) {
  const ex = payload.exercise || {};
  const response = payload.response || {};
  const durationSec = intIn(payload.duration_sec, 0, 6 * 3600, 0);
  const prompt = kind === "pr_review"
    ? gradePrPrompt(ex, response, durationSec)
    : kind === "debugging"
    ? gradeDebugPrompt(ex, response, durationSec)
    : gradeDesignPrompt(ex, response, payload.followups, durationSec);
  return cleanGrade(kind, await callModel(SYSTEM_GRADER, prompt));
}

// ---------------------------------------------------------------------------
// The gateway's JWT check also accepts the project's public anon key (it is a
// valid project JWT, and it ships in index.html), so on its own it can't tell
// a signed-in user from anyone on the internet. Ask Auth who the token
// belongs to before spending OpenAI credits on the request.
async function isSignedInUser(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL");
  if (!auth || !url) return false;
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
    if (!r.ok) return false;
    const u = await r.json();
    return typeof u?.id === "string" && u.id.length > 0;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // Signed-in users only: see isSignedInUser for why the gateway isn't enough.
  if (!(await isSignedInUser(req))) return json({ error: "unauthenticated" }, 401);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const kind = payload?.kind as Kind;
  if (!KINDS.has(kind)) return json({ error: "unknown kind" }, 400);

  try {
    switch (payload?.action) {
      case "generate":
        return json({ exercise: await generate(kind, payload), model: MODEL });
      case "followups":
        if (kind !== "system_design") return json({ error: "followups are only for system_design" }, 400);
        return json({ questions: await followups(payload.exercise || {}, payload.response || {}), model: MODEL });
      case "grade":
        return json({ grade: await grade(kind, payload), model: MODEL });
      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, detail: e.detail }, e.status);
    console.error("[drills] unexpected", e);
    return json({ error: "internal error" }, 500);
  }
});
