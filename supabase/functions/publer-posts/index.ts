// Supabase Edge Function: publer-posts
// Returns a model's full recent post history + analytics straight from
// Publer, for the "pick a model, see everything she's posted" view in the
// X Content Director. Read-only — this is separate from publer-sync (which
// only aggregates into buffer_daily_stats/buffer_top_posts for the
// dashboard) because that only keeps one "top post" per model; this returns
// the whole list on demand instead of persisting it anywhere.
//
// Deploy: `supabase functions deploy publer-posts`
// Secrets needed: PUBLER_API_KEY, PUBLER_WORKSPACE_ID
//
// Body: { modelName: string, platform?: "x"|"ig"|"tiktok"|"fb" (default "x"), days?: number (default 30) }

const PUBLER_API_URL = "https://app.publer.io/api/v1";
const MAX_PAGES = 50;

const NETWORK_PROVIDER = { x: "twitter", ig: "instagram", tiktok: "tiktok", fb: "facebook" };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function matchAccount(accounts, modelName) {
  const target = modelName.toLowerCase();
  return accounts.find((a) => `${a.name || ""} ${a.username || ""}`.toLowerCase().includes(target));
}

// Same quirk as publer-sync: omit &page on the first request, only append
// it for page 2+, and only when the prior page came back full (10 posts).
async function fetchAllPostInsights(apiKey, workspaceId, accountId, from, to) {
  const all = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const pageQuery = page === 1 ? "" : `&page=${page}`;
    const resp = await fetch(`${PUBLER_API_URL}/analytics/${accountId}/post_insights?from=${from}&to=${to}${pageQuery}`, {
      headers: { "Authorization": `Bearer-API ${apiKey}`, "Publer-Workspace-Id": workspaceId },
    });
    if (!resp.ok) throw new Error(`Publer post_insights failed page ${page}: ${resp.status}`);
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

// Same fix as publer-sync: video_views (Instagram's "Views") when present,
// falling back to reach for photo/text posts that don't have it.
function viewsValue(post) {
  const vv = post.analytics?.video_views?.value;
  return vv != null && vv > 0 ? vv : metricValue(post, "reach");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const PUBLER_API_KEY = Deno.env.get("PUBLER_API_KEY");
    const PUBLER_WORKSPACE_ID = Deno.env.get("PUBLER_WORKSPACE_ID");
    if (!PUBLER_API_KEY || !PUBLER_WORKSPACE_ID) return jsonResponse({ error: "Missing PUBLER_API_KEY or PUBLER_WORKSPACE_ID secret" }, 500);

    const { modelName, platform = "x", days = 30 } = await req.json();
    if (!modelName) return jsonResponse({ error: "Missing modelName" }, 400);
    const provider = NETWORK_PROVIDER[platform];
    if (!provider) return jsonResponse({ error: `Unsupported platform "${platform}"` }, 400);

    const accountsResp = await fetch(`${PUBLER_API_URL}/accounts`, {
      headers: { "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID },
    });
    const accounts = await accountsResp.json();
    // Publer returns a plain array on success, but an error object (e.g.
    // {errors: ["Please upgrade to Business..."]} on a lapsed/downgraded
    // plan) on failure - .filter() on that throws an opaque "not a function"
    // instead of surfacing what Publer actually said, which is what you
    // need to see to know it's a billing issue and not an app bug.
    if (!Array.isArray(accounts)) {
      const reason = accounts?.errors?.[0] || accounts?.message || `Publer /accounts returned ${accountsResp.status}`;
      return jsonResponse({ error: `Publer API error: ${reason}` }, 502);
    }
    const matchingAccounts = accounts.filter((a) => (a.provider || "").toLowerCase() === provider);
    const account = matchAccount(matchingAccounts, modelName);
    if (!account) return jsonResponse({ error: `No connected ${platform} account found matching "${modelName}"`, posts: [], accountMatched: null });

    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - Math.max(1, Number(days) || 30) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rawPosts = await fetchAllPostInsights(PUBLER_API_KEY, PUBLER_WORKSPACE_ID, account.id, from, to);

    const posts = rawPosts
      .map((p) => ({
        id: p.id,
        text: p.text || "",
        postLink: p.post_link || "",
        thumbnailUrl: p.media?.[0]?.thumbnail || p.media?.[0]?.path || "",
        scheduledAt: p.scheduled_at || null,
        reach: viewsValue(p),
        likes: metricValue(p, "likes"),
        comments: metricValue(p, "comments"),
        shares: metricValue(p, "shares"),
        engagementRate: metricValue(p, "engagement_rate"),
      }))
      .sort((a, b) => new Date(b.scheduledAt || 0) - new Date(a.scheduledAt || 0));

    const reaches = posts.map((p) => p.reach).filter((v) => v > 0);
    const rates = posts.map((p) => p.engagementRate).filter((v) => v != null);
    const summary = {
      postCount: posts.length,
      totalReach: reaches.reduce((a, b) => a + b, 0),
      avgEngagementRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0,
    };

    return jsonResponse({ accountMatched: account.name || account.username, posts, summary });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});
