// Supabase Edge Function: publer-scheduled
// Lists what's actually queued up in Publer (state: scheduled) - the
// upcoming posts that haven't gone out yet, as opposed to publer-posts
// (past posts with real analytics). Separate endpoint on Publer's side
// (/posts?state=scheduled, not /analytics/.../post_insights), so this is
// its own function rather than a mode on publer-posts.
//
// Deploy: `supabase functions deploy publer-scheduled`
// Secrets needed: PUBLER_API_KEY, PUBLER_WORKSPACE_ID
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected (used just to
// look up the model roster, same account->model matching publer-sync uses).
//
// Body: { platform?: "x"|"ig"|"tiktok"|"fb", modelName?: string }
// Both filters are optional - omit platform for all networks, omit
// modelName for every connected account's queue at once.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PUBLER_API_URL = "https://app.publer.io/api/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function normalizePlatform(provider) {
  const p = (provider || "").toLowerCase();
  if (p.includes("instagram")) return "ig";
  if (p.includes("twitter") || p === "x") return "x";
  if (p.includes("tiktok")) return "tiktok";
  if (p.includes("facebook")) return "fb";
  return p || "unknown";
}

// Same fallback-by-name-substring matching publer-sync uses to attribute a
// Publer account to a model.
function matchModel(account, modelNames) {
  const label = `${account.name || ""} ${account.username || ""}`.toLowerCase();
  return modelNames.find((n) => label.includes(n.toLowerCase())) || account.name || account.username || "unknown";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const PUBLER_API_KEY = Deno.env.get("PUBLER_API_KEY");
    const PUBLER_WORKSPACE_ID = Deno.env.get("PUBLER_WORKSPACE_ID");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!PUBLER_API_KEY || !PUBLER_WORKSPACE_ID) return jsonResponse({ error: "Missing PUBLER_API_KEY or PUBLER_WORKSPACE_ID secret" }, 500);

    const { platform, modelName } = await req.json().catch(() => ({}));
    const headers = { "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID };

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: models } = await supabase.from("models").select("name");
    const modelNames = (models || []).map((m) => m.name);

    const [accountsResp, postsResp] = await Promise.all([
      fetch(`${PUBLER_API_URL}/accounts`, { headers }),
      fetch(`${PUBLER_API_URL}/posts?state=scheduled`, { headers }),
    ]);

    const accounts = await accountsResp.json();
    if (!Array.isArray(accounts)) {
      const reason = accounts?.errors?.[0] || accounts?.message || `Publer /accounts returned ${accountsResp.status}`;
      return jsonResponse({ error: `Publer API error: ${reason}` }, 502);
    }
    const postsJson = await postsResp.json();
    if (!postsResp.ok || !Array.isArray(postsJson?.posts)) {
      const reason = postsJson?.errors?.[0] || postsJson?.message || `Publer /posts returned ${postsResp.status}`;
      return jsonResponse({ error: `Publer API error: ${reason}` }, 502);
    }

    const accountsById = Object.fromEntries(accounts.map((a) => [a.id, { ...a, model: matchModel(a, modelNames), platform: normalizePlatform(a.provider) }]));

    let scheduled = postsJson.posts
      .filter((p) => p.state === "scheduled")
      .map((p) => {
        const acct = accountsById[p.account_id];
        return {
          id: p.id,
          model: acct?.model || "unknown",
          platform: acct?.platform || "unknown",
          text: p.text || "",
          thumbnailUrl: p.media?.[0]?.thumbnail || p.media?.[0]?.path || "",
          scheduledAt: p.scheduled_at || null,
        };
      });

    if (platform) scheduled = scheduled.filter((p) => p.platform === platform);
    if (modelName) scheduled = scheduled.filter((p) => p.model.toLowerCase() === modelName.toLowerCase());

    scheduled.sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));

    return jsonResponse({ scheduled });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});
