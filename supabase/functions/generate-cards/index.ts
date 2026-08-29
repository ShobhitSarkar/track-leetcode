// Supabase Edge Function: generate-cards
//
// Takes a note (title, topic, body) and returns a small set of flashcards
// produced by OpenAI. The client posts to this function; Supabase verifies
// the caller's JWT before the handler runs (default `--verify-jwt` behavior),
// so anonymous requests never reach the OpenAI key.
//
// Deploy:  supabase functions deploy generate-cards
// Secret:  supabase secrets set OPENAI_API_KEY=sk-...
//
// The client falls back to a client-side heuristic if this function is
// missing, unauthenticated, or errors out — see cardsFromBody() in index.html.

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

const buildPrompt = (title: string, topic: string, body: string) => `You turn a study note into 3-8 spaced-repetition flashcards.

Return STRICT JSON of the form:
{"cards":[{"front":"...","back":"...","code":null}]}

Rules:
- "front" is a natural question or prompt (10-140 chars) the user should try to answer aloud. Never reference "the note" or "above".
- "back" is the answer (1-4 sentences, up to ~400 chars). Include the specific number, tradeoff, or edge case worth remembering.
- "code" is null unless a short code snippet from the note is worth memorizing verbatim. Then it's a string; keep it under 30 lines.
- Focus on: definitions, tradeoffs, key numbers, edge cases, gotchas, and named results — the things spaced repetition actually helps with. Skip generic prose.
- Produce fewer, sharper cards over many mediocre ones. If the note is short, 3 is fine; only go past 6 for a dense multi-topic note.
- Do not include any text outside the JSON object.

Title: ${title || "(untitled)"}
Topic: ${topic || "(none)"}

Body:
${body}`;

type OpenAiCard = { front?: unknown; back?: unknown; code?: unknown };

const cleanCards = (raw: unknown) => {
  const arr = Array.isArray((raw as any)?.cards) ? (raw as any).cards as OpenAiCard[] : [];
  return arr
    .filter((c) =>
      c && typeof c.front === "string" && typeof c.back === "string" &&
      c.front.trim().length > 0 && c.back.trim().length > 0
    )
    .slice(0, 12)
    .map((c) => ({
      front: String(c.front).trim().slice(0, 500),
      back: String(c.back).trim().slice(0, 2000),
      code: (typeof c.code === "string" && c.code.trim().length > 0)
        ? String(c.code).slice(0, 2000)
        : null,
    }));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Supabase's default gateway verifies the JWT before this handler runs, so
  // we can assume the caller is authenticated. We still check for the header
  // so a self-hosted deploy without gateway verification degrades to 401
  // instead of silently accepting anonymous traffic.
  if (!req.headers.get("Authorization")) return json({ error: "unauthenticated" }, 401);

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return json({ error: "OPENAI_API_KEY not configured" }, 500);

  let payload: { title?: string; topic?: string; body?: string };
  try { payload = await req.json(); }
  catch { return json({ error: "invalid JSON body" }, 400); }

  const body = (payload.body || "").trim();
  if (body.length < 20) return json({ error: "note body too short" }, 400);
  if (body.length > 20000) return json({ error: "note body too long" }, 400);

  const title = (payload.title || "").toString().slice(0, 200);
  const topic = (payload.topic || "").toString().slice(0, 200);

  // Bound the upstream call. The client already has its own 30s ceiling; this
  // guard runs a few seconds under it so we still return a real 504 rather than
  // the client's abort message when OpenAI stalls.
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
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You produce concise spaced-repetition flashcards from study notes. Output only valid JSON matching the schema the user gives you." },
          { role: "user", content: buildPrompt(title, topic, body) },
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

  const cards = cleanCards(parsed);
  if (cards.length === 0) return json({ error: "openai returned no usable cards" }, 502);

  return json({ cards, model: MODEL });
});
