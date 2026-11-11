// Supabase Edge Function: publer-sync
// Replaces sync-buffer-stats as the source for buffer_daily_stats /
// buffer_top_posts — same two tables, same row shapes, just pulled from
// Publer's post_insights endpoint instead of Buffer's GraphQL API (Buffer
// was migrated away from; Publer is the posting tool now). Nothing on the
// frontend needed to change since it already just reads these two tables
// generically, regardless of where the numbers come from.
//
// Deploy: paste into a new Edge Function named "publer-sync" and deploy,
// or run `supabase functions deploy publer-sync`.
// Secrets needed (Supabase Dashboard -> Edge Functions -> Secrets):
//   PUBLER_API_KEY, PUBLER_WORKSPACE_ID
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected.
//
// Run once a day (Supabase Cron) with no query params to sync "yesterday".
// ?date=YYYY-MM-DD overrides the target day (for backfills/testing).
// ?days=N syncs the last N days in one call (e.g. ?days=90 for a backfill).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS: this originally only ran server-side via cron, so it never needed
// these — added once the Model Manager's "Sync now" button started calling
// it directly from the browser, which needs a preflight OPTIONS response
// and Access-Control-Allow-Origin on every response or the browser silently
// blocks it before this code even runs ("Failed to send a request").
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PUBLER_API_URL = "https://app.publer.io/api/v1";
const MAX_PAGES = 50; // 10 posts/page — 500 posts/account/request is far more than any account posts in one window

const AGENCY_TIMEZONE = "Europe/Prague";
function agencyToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: AGENCY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function agencyYesterday() {
  const todayUTC = new Date(`${agencyToday()}T00:00:00Z`);
  todayUTC.setUTCDate(todayUTC.getUTCDate() - 1);
  return todayUTC.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date(`${agencyToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function normalizePlatform(provider) {
  const p = (provider || "").toLowerCase();
  if (p.includes("instagram")) return "ig";
  if (p.includes("twitter") || p === "x") return "x";
  if (p.includes("tiktok")) return "tiktok";
  if (p.includes("facebook")) return "fb";
  return p || "unknown";
}

// Same fallback-by-name-substring matching sync-buffer-stats used for Buffer
// channels — no explicit publer_account_id_* mapping exists in Model Manager
// yet, so this is what maps a Publer account to a model row for now.
function matchModel(account, modelNames) {
  const label = `${account.name || ""} ${account.username || ""}`.toLowerCase();
  const match = modelNames.find((n) => label.includes(n.toLowerCase()));
  return match || account.name || account.id;
}

async function fetchAccounts(apiKey, workspaceId) {
  const resp = await fetch(`${PUBLER_API_URL}/accounts`, {
    headers: { "Authorization": `Bearer-API ${apiKey}`, "Publer-Workspace-Id": workspaceId },
  });
  if (!resp.ok) {
    // Surface Publer's actual message (e.g. a lapsed/downgraded plan says
    // {"errors":["Please upgrade to Business to access our API."]}) instead
    // of just the status code, since that's what tells you whether this is
    // a Publer billing issue vs. an actual outage.
    const body = await resp.json().catch(() => null);
    const reason = body?.errors?.[0] || body?.message || resp.status;
    throw new Error(`Publer /accounts failed: ${reason}`);
  }
  return resp.json();
}

// post_insights only accepts {from, to} plus a bare `page` — adding any
// other param (sort_by alongside page, per_page, limit, etc.) makes the
// endpoint 500. It also has a quirk: passing &page=1 (or any page param at
// all) on a range whose *total* fits on one page makes it come back with
// posts:[] even though total is still reported correctly. So: always fetch
// page 1 by omitting the page param entirely, and only start appending
// &page=N for page 2 onward, when the first page came back full (10 posts)
// and there's more to get.
async function fetchAllPostInsights(apiKey, workspaceId, accountId, from, to) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const pageQuery = page === 1 ? "" : `&page=${page}`;
    const resp = await fetch(`${PUBLER_API_URL}/analytics/${accountId}/post_insights?from=${from}&to=${to}${pageQuery}`, {
      headers: { "Authorization": `Bearer-API ${apiKey}`, "Publer-Workspace-Id": workspaceId },
    });
    if (!resp.ok) throw new Error(`Publer post_insights failed for ${accountId} page ${page}: ${resp.status}`);
    const json = await resp.json();
    const posts = json.posts || [];
    all.push(...posts);
    if (posts.length < 10 || all.length >= (json.total || 0)) break;
    page++;
  }
  return all;
}

function metricValue(post, key) {
  return post.analytics?.[key]?.value ?? 0;
}

// Instagram's own app now shows "Views" as the headline post metric, not
// reach — and Views is far higher for video/reel posts (replays count) than
// reach (unique accounts) ever does. Publer's video_views field is the
// closest match to that; photo/text posts don't have it, so fall back to
// reach for those. Using reach alone for everything was undercounting IG
// reel-heavy accounts by roughly 5-8x against Instagram's own dashboard.
function viewsValue(post) {
  const vv = post.analytics?.video_views?.value;
  return vv != null && vv > 0 ? vv : metricValue(post, "reach");
}

// Top N posts (by views), not just #1 — the dashboard's "Top posts" table
// wants a small leaderboard per account, not a single row.
function pickTopPosts(posts, n = 5) {
  if (!posts.length) return [];
  return [...posts]
    .sort((a, b) => viewsValue(b) - viewsValue(a))
    .slice(0, n)
    .map((post) => {
      const media = post.media?.[0];
      return {
        postId: post.id,
        text: post.text || "",
        thumbnailUrl: media?.thumbnail || media?.path || "",
        sourceUrl: media?.path || "",
        externalLink: post.post_link || "",
        impressions: viewsValue(post),
        reactions: metricValue(post, "likes"),
        comments: metricValue(post, "comments"),
        reposts: metricValue(post, "shares"),
        sentAt: post.scheduled_at || null,
      };
    });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const dateOverride = url.searchParams.get("date");
    const daysParam = url.searchParams.get("days");

    const PUBLER_API_KEY = Deno.env.get("PUBLER_API_KEY");
    const PUBLER_WORKSPACE_ID = Deno.env.get("PUBLER_WORKSPACE_ID");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!PUBLER_API_KEY || !PUBLER_WORKSPACE_ID) {
      return new Response(JSON.stringify({ error: "Missing PUBLER_API_KEY or PUBLER_WORKSPACE_ID secret" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: models, error: modelsError } = await supabase.from("models").select("name, ig_handle, x_handle, tiktok_handle");
    if (modelsError) throw modelsError;
    const modelNames = (models || []).map((m) => m.name);
    const modelByName = Object.fromEntries((models || []).map((m) => [m.name, m]));

    const accounts = await fetchAccounts(PUBLER_API_KEY, PUBLER_WORKSPACE_ID);
    const targets = accounts.map((a) => ({
      model: matchModel(a, modelNames),
      platform: normalizePlatform(a.provider),
      accountId: a.id,
      accountName: a.name || a.username || a.id,
      username: a.username || null,
    }));

    // Backfill the model's ig/x/tiktok handle field straight from the
    // matched Publer account's username whenever it's still empty — that
    // field used to be purely manual (Model Manager's edit form was the
    // only way to set it, and nothing ever prompted anyone to), so most
    // models showed "no handle set" even on platforms that were already
    // fully connected and syncing real stats. Never overwrites a value
    // that's already there, in case it was deliberately set to something
    // else.
    const HANDLE_COLUMN = { ig: "ig_handle", x: "x_handle", tiktok: "tiktok_handle" };
    for (const t of targets) {
      const col = HANDLE_COLUMN[t.platform];
      if (!col || !t.username) continue;
      const modelRow = modelByName[t.model];
      if (!modelRow || modelRow[col]) continue; // no matching model, or already has a handle set
      const { error: handleErr } = await supabase.from("models").update({ [col]: t.username }).eq("name", t.model);
      if (!handleErr) modelRow[col] = t.username; // avoid a duplicate write if two accounts somehow match the same model+platform
    }

    // Routine (no query params) runs used to sync ONLY "yesterday", and each
    // date only ever got written once — Publer's own post_insights for a
    // given day isn't always fully populated the moment that day's sync
    // runs (confirmed live: a single-day query for a date that synced as
    // all-zero two days ago now correctly returns the real post — Publer's
    // analytics were still catching up when the original write happened).
    // buffer_top_posts never had this problem because it recomputes a
    // fresh rolling 7-day window on every run instead of writing a date
    // once and never touching it again; daily stats need the same
    // "re-check recent days every time" treatment, or a day whose data
    // was still settling at write time is stuck at zero forever. Routine
    // runs now re-sync the trailing week (today back through 6 days ago)
    // every single time — upsert just overwrites the same rows with
    // whatever's accurate now.
    const ROUTINE_TRAILING_DAYS = 7;
    const targetDates = dateOverride
      ? [dateOverride]
      : daysParam
      ? Array.from({ length: Math.max(1, parseInt(daysParam, 10)) }, (_, i) => daysAgo(i + 1))
      : [agencyToday(), ...Array.from({ length: ROUTINE_TRAILING_DAYS }, (_, i) => daysAgo(i + 1))];

    const results = [];

    for (const t of targets) {
      // Top post is a rolling last-7-days thing — only worth computing once per
      // account per run, not once per (date x account) in a backfill loop.
      let topPostSaved = false;
      try {
        const recentPosts = await fetchAllPostInsights(PUBLER_API_KEY, PUBLER_WORKSPACE_ID, t.accountId, daysAgo(7), agencyToday());
        const tops = pickTopPosts(recentPosts, 5);
        if (tops.length) {
          // Old top-5 rows for this account are cleared first so a post that
          // falls out of the top 5 this run doesn't linger forever — same
          // "replace this account's slice" pattern as the daily stats delete
          // in weekly-trends-scrape, just scoped by model+platform here.
          await supabase.from("buffer_top_posts").delete().eq("model", t.model).eq("platform", t.platform);
          const { error: topPostError } = await supabase.from("buffer_top_posts").upsert(
            tops.map((top) => ({
              id: `${t.model}-${t.platform}-${top.postId}`,
              model: t.model,
              platform: t.platform,
              channel_id: t.accountId,
              text: top.text,
              thumbnail_url: top.thumbnailUrl,
              source_url: top.sourceUrl,
              external_link: top.externalLink,
              impressions: top.impressions,
              reactions: top.reactions,
              comments: top.comments,
              reposts: top.reposts,
              sent_at: top.sentAt,
              synced_at: new Date().toISOString(),
            }))
          );
          topPostSaved = !topPostError;
        }
      } catch (e) {
        results.push({ model: t.model, platform: t.platform, stage: "topPost", error: e.message });
      }

      for (const dateStr of targetDates) {
        try {
          const dayPosts = await fetchAllPostInsights(PUBLER_API_KEY, PUBLER_WORKSPACE_ID, t.accountId, dateStr, dateStr);
          const postCount = dayPosts.length;
          const sum = (key) => dayPosts.reduce((a, p) => a + metricValue(p, key), 0);
          const engagementRates = dayPosts.map((p) => metricValue(p, "engagement_rate")).filter((v) => v != null);
          const avgEngagement = engagementRates.length ? engagementRates.reduce((a, b) => a + b, 0) / engagementRates.length : 0;

          const row = {
            id: `${t.model}-${t.platform}-${dateStr}`,
            model: t.model,
            platform: t.platform,
            channel_id: t.accountId,
            stat_date: dateStr,
            post_count: postCount,
            reactions: sum("likes"),
            comments: sum("comments"),
            reposts: sum("shares"),
            impressions: dayPosts.reduce((a, p) => a + viewsValue(p), 0),
            engagement_rate: avgEngagement,
            synced_at: new Date().toISOString(),
          };
          const { error: upsertError } = await supabase.from("buffer_daily_stats").upsert(row);
          if (upsertError) throw upsertError;
          results.push({ model: t.model, platform: t.platform, date: dateStr, ok: true, postCount, impressions: row.impressions, topPostSaved });
        } catch (e) {
          results.push({ model: t.model, platform: t.platform, date: dateStr, error: e.message });
        }
      }
    }

    return new Response(JSON.stringify({ accountsFound: accounts.length, datesSynced: targetDates.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
