// Supabase Edge Function: x-caption-generate
// Called from the X Week Planner (Content Director -> X tab -> pick a model
// -> Week Planner -> Generate captions). Pulls that model's persona
// (bio/note from Model Manager) and her last 30 days of X performance from
// buffer_daily_stats, then sends her actual queued photos to Claude as
// vision input and asks for one caption PER PHOTO that matches what's
// actually in it — not a blind pool of generic captions cycled across
// however many photos happen to be queued.
//
// Deploy: `supabase functions deploy x-caption-generate` (or paste into the
// Supabase dashboard's Edge Functions editor and click "Deploy updates").
//
// Secrets needed (Supabase Dashboard -> Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY — Claude Sonnet 5, chosen over Groq/llama for both
//   noticeably better CZ/SK caption quality and because llama-3.3-70b on
//   Groq has no vision support at all.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
// Supabase runtime, no need to set those yourself.
//
// Body: { modelName: string, images: [{ mediaType: string, data: string (base64, no data: prefix) }] }
// images is capped at 20 — one Claude call covers the whole batch, so this
// keeps a single request from ballooning into an enormous multi-image
// payload. Falls back to the old blind/no-photo mode (a `count`-sized pool
// of generic captions) only if `images` is omitted entirely, so nothing
// that still calls the old shape breaks.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Real examples from the old buffer_bulk_upload.py caption lists, used as a
// style anchor (few-shot) — generic instructions alone produce flat,
// corporate-sounding captions. These are shown to the model, never
// reproduced verbatim in the output.
const STYLE_EXAMPLES = [
  "Sleduj mě, ať ti nic neuteče 🖤",
  "Follow before I change my mind 😏",
  "Notifikace zapnuté? Měly by být 👀",
  "New stuff drops soon, don't miss it 🔥",
  "I don't repeat myself, follow so you don't miss it 😈",
  "@grok rate this, then go follow for more 😅",
  "This is your sign to hit follow 💋",
  "Nechci abys tohle propásl/a, sleduj mě 🎀",
  "Comments are wild, follow to see what's next 👀",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) return jsonResponse({ error: "Missing ANTHROPIC_API_KEY secret" }, 500);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "Missing Supabase service credentials" }, 500);
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { modelName, count, images: rawImages } = await req.json();
    if (!modelName || typeof modelName !== "string") {
      return jsonResponse({ error: "Missing modelName" }, 400);
    }
    const images = Array.isArray(rawImages) ? rawImages.slice(0, 20) : null;
    const n = images ? images.length : Math.min(Math.max(Number(count) || 8, 1), 20);
    if (n < 1) return jsonResponse({ error: "Nothing to caption" }, 400);

    const { data: modelRow, error: modelErr } = await supabase
      .from("models").select("name, bio, note, x_handle, agency")
      .eq("name", modelName).maybeSingle();
    if (modelErr) return jsonResponse({ error: modelErr.message }, 500);
    if (!modelRow) return jsonResponse({ error: `Model "${modelName}" not found` }, 404);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: statsRows, error: statsErr } = await supabase
      .from("buffer_daily_stats").select("*")
      .eq("model", modelName).eq("platform", "x")
      .gte("stat_date", thirtyDaysAgo).order("stat_date", { ascending: true });
    if (statsErr) return jsonResponse({ error: statsErr.message }, 500);

    const rows = statsRows || [];
    const totalPosts = rows.reduce((a, r) => a + (r.post_count || 0), 0);
    const avgEngagement = rows.length ? rows.reduce((a, r) => a + (Number(r.engagement_rate) || 0), 0) / rows.length : null;

    let trend = "not enough data yet";
    if (rows.length >= 4) {
      const mid = Math.floor(rows.length / 2);
      const firstAvg = rows.slice(0, mid).reduce((a, r) => a + (Number(r.engagement_rate) || 0), 0) / mid;
      const secondAvg = rows.slice(mid).reduce((a, r) => a + (Number(r.engagement_rate) || 0), 0) / (rows.length - mid);
      if (secondAvg > firstAvg * 1.05) trend = "trending up recently";
      else if (secondAvg < firstAvg * 0.95) trend = "trending down recently";
      else trend = "holding steady";
    }

    const sums = Array(7).fill(0), counts = Array(7).fill(0);
    rows.forEach((r) => {
      if (!r.stat_date) return;
      const dow = new Date(r.stat_date + "T00:00:00").getDay();
      sums[dow] += Number(r.engagement_rate) || 0; counts[dow]++;
    });
    const avgByDow = sums.map((s, i) => (counts[i] ? s / counts[i] : null));
    let bestDowLabel = "not enough data yet";
    const known = avgByDow.map((v, i) => ({ v, i })).filter((x) => x.v != null);
    if (known.length) {
      known.sort((a, b) => b.v - a.v);
      bestDowLabel = DOW_NAMES[known[0].i];
    }

    // Real past captions that actually had reach, last 30 days — reuses the
    // already-deployed publer-posts function (same one the Week Planner's
    // post-history list calls) instead of re-implementing the Publer fetch
    // here. These get shown to the model as concrete "what's worked before"
    // examples alongside the generic style anchor, so new captions can echo
    // a proven hook/structure instead of guessing blind.
    let pastWinners = [];
    try {
      const winnersResp = await fetch(`${SUPABASE_URL}/functions/v1/publer-posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ modelName, platform: "x", days: 30 }),
      });
      const winnersJson = await winnersResp.json();
      pastWinners = (winnersJson.posts || [])
        .filter((p) => p.text && p.reach > 0)
        .sort((a, b) => b.reach - a.reach)
        .slice(0, 6);
    } catch (e) {
      pastWinners = []; // best-effort - a caption batch is still useful without this
    }
    const pastWinnersBlock = pastWinners.length
      ? `\nHER REAL TOP-PERFORMING CAPTIONS FROM THE LAST 30 DAYS (highest reach first — study what hook/structure/tone worked, don't reuse these lines verbatim):\n${pastWinners.map((p) => `- "${p.text}" (${p.reach.toLocaleString()} reach)`).join("\n")}\n`
      : "";

    const statsSummary = `Last 30 days on X for ${modelName}:
- Total posts synced: ${totalPosts}
- Avg engagement rate: ${avgEngagement != null ? avgEngagement.toFixed(2) + "%" : "no data yet"}
- Trend: ${trend}
- Best day of week historically: ${bestDowLabel}`;

    const persona = [modelRow.bio, modelRow.note].filter(Boolean).join(" | ") || "No persona notes set yet in Model Manager — keep it generic, casual, a little flirty.";

    // Agency determines the caption language, not a "mix it in" suggestion —
    // a CZ-roster model's followers are Czech, an all-English caption reads
    // as obviously wrong to them. US models get English. This was previously
    // just "a mix is natural," which in practice meant the model defaulted
    // to English almost every time regardless of who the audience was.
    const isCZ = (modelRow.agency || "CZ") === "CZ";
    const languageRule = isCZ
      ? `- Write in CZECH. This model's audience is Czech. Natural colloquial Czech, not stiff/formal, not a literal translation from English — occasional English words/phrases mixed in are fine (that's normal texting style), but the caption as a whole must read as Czech, not English.`
      : `- Write in ENGLISH. This model's audience is English-speaking.`;

    const sharedRules = `You write short X (Twitter) captions that sit next to a photo or video, promoting an OnlyFans creator and nudging people to follow / check new content. You write like a real person quickly texting her followers, NOT like a marketer or an assistant. Never explicit, never graphic, no hashtags.

STYLE ANCHOR — here are real examples of the tone/energy you're matching (do not reuse these lines, they're just the vibe):
${STYLE_EXAMPLES.map((c) => `- ${c}`).join("\n")}

Rules:
- Each caption is ONE short line, under 15 words. Shorter and punchier beats long and explainy.
${languageRule}
- Include exactly one emoji in almost every caption (rarely two, rarely zero), picked from: 🖤 😏 👀 🔥 💋 😈 🎀 🌙 — placed at the end or woven in, never awkwardly bolted on.
- No corporate phrasing. Ban words/phrases: "check out", "don't miss out on", "exciting", "exclusive content", "click the link below", "engage", "elevate". If you catch yourself writing something a brand social media manager would write, rewrite it.
- Vary sentence openings across the set — don't start three captions the same way ("Follow...", "Follow...", "Follow..."). Mix imperative, question, teaser, and casual-statement openings.
- Vary which emoji you use — don't repeat the same one back-to-back.

Persona: ${persona}

${statsSummary}
${pastWinnersBlock}
Lean into what's been working (e.g. if engagement is trending up, keep similar energy to recent posts; if flat or down, try a fresher angle) — but never mention stats or performance in the captions themselves.`;

    let requestBody;
    if (images && images.length) {
      // Vision path: every photo goes into one message so the model sees the
      // whole batch at once (helps it vary captions across similar-looking
      // photos instead of writing near-duplicates), each one clearly
      // numbered so the response can be matched back up by index.
      const content = [
        {
          type: "text",
          text: `${sharedRules}\n\nBelow are ${images.length} photos, numbered in order. Write ONE caption for EACH photo that actually fits what's happening in it (pose, setting, mood, outfit, expression) — not a generic caption that could sit next to any photo. Return ONLY a JSON array of exactly ${images.length} strings, in the same order as the photos (index 0 = photo 1, etc). No markdown, no code fences, no numbering, no commentary — just the array.`,
        },
      ];
      images.forEach((img, i) => {
        content.push({ type: "text", text: `Photo ${i + 1}:` });
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.data },
        });
      });
      requestBody = {
        model: "claude-sonnet-5",
        max_tokens: 1200,
        temperature: 1,
        messages: [{ role: "user", content }],
      };
    } else {
      // Blind fallback (no photos sent) — a pool of generic captions, same
      // as before vision support existed.
      requestBody = {
        model: "claude-sonnet-5",
        max_tokens: 900,
        temperature: 1,
        system: sharedRules,
        messages: [{ role: "user", content: `Return ONLY a JSON array of ${n} caption strings. No markdown, no code fences, no numbering, no commentary — just the array.` }],
      };
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

    const json = await resp.json();
    if (json.error) return jsonResponse({ error: json.error.message || "Anthropic API error" }, 500);

    // Claude Sonnet 5 can return a "thinking" content block ahead of the
    // actual answer (extended thinking), so the real text is whichever
    // block has type "text" - not necessarily content[0]. Grabbing
    // content[0].text blindly silently returned "" whenever a thinking
    // block came first, which then failed to parse as JSON.
    const textBlock = (json.content || []).find((b) => b.type === "text");
    const raw = (textBlock?.text || "").trim();
    let captions;
    try {
      const cleaned = raw.replace(/^```(json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      captions = JSON.parse(cleaned);
      if (!Array.isArray(captions)) throw new Error("not an array");
    } catch (e) {
      // Salvage a JSON array even if the model wrapped it in a stray line of
      // prose despite being told not to (e.g. a one-line caveat).
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try { captions = JSON.parse(match[0]); } catch (e2) { captions = null; }
      }
      if (!Array.isArray(captions)) {
        return jsonResponse({ error: `Model returned something unparseable: ${raw.slice(0, 300)}` }, 500);
      }
    }
    captions = captions.map((c) => (typeof c === "string" ? c.trim() : ""));
    if (!captions.some(Boolean)) return jsonResponse({ error: "No usable captions came back" }, 500);
    // Pad/truncate to exactly n so the frontend can zip 1:1 with photos even
    // if the model returned a slightly short/long array.
    while (captions.length < n) captions.push(captions[captions.length - 1] || "");
    captions = captions.slice(0, n);

    return jsonResponse({ captions, statsSummary });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});
