// Supabase Edge Function: suggest-problems
//
// Takes a summary of the user's LeetCode practice (patterns tried, comfort
// tier, recent solves, problems they've already logged or explicitly skipped)
// and asks OpenAI for a small set of fresh problem recommendations. This is
// the "why do I keep seeing the same suggestions?" fix — the built-in engine
// only picks from a curated ~150-problem catalog, so once you've cleared or
// skipped most of it there's nothing fresh left. The LLM draws from the full
// LeetCode surface area and can propose problems the catalog doesn't know
// about at all.
//
// Deploy:  supabase functions deploy suggest-problems
// Secret:  supabase secrets set OPENAI_API_KEY=sk-...
//
// The client (Discover view in index.html) shows a "Fresh from AI" section
// at the top of the picks when this returns; it silently omits the section
// on any failure so the deterministic engine still carries the view.

// deno-lint-ignore-file no-explicit-any
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

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

type PatternStat = { pattern: string; count: number; avgRating: number; strongCount: number; struggling?: boolean };
type Payload = {
  solved?: string[];
  skipped?: string[];
  recent?: string[];
  patternStats?: PatternStat[];
  comfort?: "Easy" | "Medium" | "Hard";
  count?: number;
};

const clampList = (arr: unknown, max: number): string[] => {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 120))
    .slice(0, max);
};

const clampPatternStats = (arr: unknown): PatternStat[] => {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof (x as any).pattern === "string")
    .slice(0, 30)
    .map((x: any) => ({
      pattern: String(x.pattern).slice(0, 60),
      count: Number.isFinite(x.count) ? Math.max(0, Math.min(999, Math.floor(x.count))) : 0,
      avgRating: Number.isFinite(x.avgRating) ? Math.max(1, Math.min(4, Number(x.avgRating))) : 3,
      strongCount: Number.isFinite(x.strongCount) ? Math.max(0, Math.min(999, Math.floor(x.strongCount))) : 0,
      struggling: !!x.struggling,
    }));
};

const buildPrompt = (p: Required<Pick<Payload, "solved" | "skipped" | "recent" | "patternStats" | "comfort" | "count">>) => {
  const patternLines = p.patternStats.length === 0
    ? "  (none yet — the user hasn't logged any patterns)"
    : p.patternStats
        .map((s) => {
          const strength = s.avgRating <= 2 ? "strong" : s.avgRating <= 3 ? "building" : "struggling";
          const flag = s.struggling ? " (last attempt: Struggled hard)" : "";
          return `  - ${s.pattern}: ${s.count} logged, avg rating ${s.avgRating.toFixed(2)}/4, ${s.strongCount} strong solves, ${strength}${flag}`;
        })
        .join("\n");

  return `You are a LeetCode interview coach recommending FRESH problems this specific user hasn't tried yet.

User snapshot
-------------
Overall comfort tier: ${p.comfort}
Per-pattern practice:
${patternLines}

Recent solves (most recent first, up to 15):
${p.recent.length ? p.recent.map((n) => `  - ${n}`).join("\n") : "  (none)"}

Already logged (do NOT suggest any of these — the user has already tracked them):
${p.solved.length ? p.solved.map((n) => `  - ${n}`).join("\n") : "  (none)"}

Explicitly skipped (do NOT suggest any of these — the user asked to hide them):
${p.skipped.length ? p.skipped.map((n) => `  - ${n}`).join("\n") : "  (none)"}

Your task
---------
Suggest exactly ${p.count} LeetCode problems that:
1. Are NOT in the logged or skipped lists above.
2. Are real problems on leetcode.com. Use the exact problem title as it appears on the site (e.g. "Kth Smallest Element in a BST", not "K-th Smallest Element in a Binary Search Tree").
3. Together give the user variety — mix at least 2 patterns, and don't all sit at the same difficulty.
4. Are tuned to the user's snapshot: reinforce a struggling pattern with something easier, push a strong pattern one tier up, and if breadth is thin introduce one canonical problem from a pattern they haven't touched.
5. Lean toward problems that come up in real interview loops (FAANG, Blind 75, NeetCode 150 style) over obscure contest problems.

Return STRICT JSON of the form:
{"picks":[{"name":"Problem Title","difficulty":"Easy|Medium|Hard","patterns":["Pattern","..."],"reason":"one short sentence tied to the user's snapshot"}]}

Rules for each pick:
- "name": exact leetcode.com title, case-preserved.
- "difficulty": one of Easy, Medium, Hard.
- "patterns": 1-3 short pattern labels drawn from this vocabulary when possible: Two Pointers, Sliding Window, Hash Map, Binary Search, BFS, DFS, DP, Backtracking, Greedy, Monotonic Stack, Prefix Sum, Heap, Union Find, Trie, Linked List, Tree, Graph, Bit Manipulation, Stack, Intervals, Math. Use a specific label outside this list only if none of these fit.
- "reason": one sentence (10-140 chars). Refer to the user's specific signal ("You're strong in DP", "reinforces the Greedy you struggled with", "widens breadth into Union Find"). Never say "the user".
- No text outside the JSON object.`;
};

type RawPick = { name?: unknown; difficulty?: unknown; patterns?: unknown; reason?: unknown };

const cleanPicks = (raw: unknown, blocklist: Set<string>) => {
  const arr = Array.isArray((raw as any)?.picks) ? (raw as any).picks as RawPick[] : [];
  const okDifficulty = new Set(["Easy", "Medium", "Hard"]);
  const out: { name: string; difficulty: string; patterns: string[]; reason: string }[] = [];
  const seen = new Set<string>();
  for (const p of arr) {
    if (!p || typeof p.name !== "string") continue;
    const name = p.name.trim().slice(0, 140);
    if (!name) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug || seen.has(slug) || blocklist.has(slug)) continue;
    seen.add(slug);
    const difficulty = typeof p.difficulty === "string" && okDifficulty.has(p.difficulty) ? p.difficulty : "Medium";
    const patterns = Array.isArray(p.patterns)
      ? p.patterns.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim().slice(0, 40))
          .slice(0, 3)
      : [];
    const reason = typeof p.reason === "string" ? p.reason.trim().slice(0, 200) : "";
    out.push({ name, difficulty, patterns, reason });
    if (out.length >= 12) break;
  }
  return out;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Same auth posture as generate-cards: Supabase's gateway verifies the JWT
  // by default, but we still refuse anonymous traffic explicitly so a
  // self-hosted deploy without gateway verification doesn't leak the key.
  if (!req.headers.get("Authorization")) return json({ error: "unauthenticated" }, 401);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "OPENAI_API_KEY not configured" }, 500);

  let payload: Payload;
  try { payload = await req.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const solved = clampList(payload.solved, 200);
  const skipped = clampList(payload.skipped, 200);
  const recent = clampList(payload.recent, 15);
  const patternStats = clampPatternStats(payload.patternStats);
  const comfort = (payload.comfort === "Easy" || payload.comfort === "Medium" || payload.comfort === "Hard")
    ? payload.comfort
    : "Medium";
  const count = Math.max(3, Math.min(6, Number.isFinite(payload.count) ? Math.floor(payload.count as number) : 5));

  const prompt = buildPrompt({ solved, skipped, recent, patternStats, comfort, count });

  // Slug blocklist so the model never re-suggests something the user already
  // tracks or has hidden, even when it forgets its own instructions.
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const blocklist = new Set<string>();
  for (const n of solved) blocklist.add(slugify(n));
  for (const n of skipped) blocklist.add(slugify(n));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let oai: Response;
  try {
    oai = await fetch(OPENAI_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        // A touch of variety so re-running "Refresh" gives a different mix
        // instead of returning the same five picks every time.
        temperature: 0.8,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You recommend fresh LeetCode problems for a specific user. Output only valid JSON matching the schema the user gives you." },
          { role: "user", content: prompt },
        ],
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as any)?.name === "AbortError";
    return json({ error: aborted ? "openai request timed out" : "openai request failed" }, aborted ? 504 : 502);
  }
  clearTimeout(timer);

  if (!oai.ok) {
    const detail = await oai.text().catch(() => "");
    return json({ error: `openai ${oai.status}`, detail: detail.slice(0, 500) }, 502);
  }

  let data: any;
  try { data = await oai.json(); }
  catch { return json({ error: "openai returned non-JSON envelope" }, 502); }

  const raw = data?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") return json({ error: "openai returned no content" }, 502);

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return json({ error: "openai content was not JSON" }, 502); }

  const picks = cleanPicks(parsed, blocklist);
  if (picks.length === 0) return json({ error: "openai returned no usable picks" }, 502);

  return json({ picks, model: MODEL });
});
