// Supabase Edge Function: publer-schedule
// Schedules a post to a model's connected social account via Publer, given
// a model name (matched to a Publer account the same way publer-sync does),
// caption text, and an already-uploaded media id (from publer-upload-media).
//
// Deploy: `supabase functions deploy publer-schedule`
// Secrets needed: PUBLER_API_KEY, PUBLER_WORKSPACE_ID
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected.
//
// Body: {
//   modelName: string,       required — matched against Publer account name/username
//   platform: "x"|"ig"|"tiktok"|"fb" (default "x"),
//   text: string,            caption
//   mediaId: string,         optional — id from publer-upload-media
//   mediaType: "photo"|"video" (default "photo", only used if mediaId set),
//   scheduledAt: string,     optional ISO timestamp; omit to schedule ASAP (+2 min)
//   state: "scheduled"|"draft_private"  (default "scheduled")
// }

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

const NETWORK_KEY = { x: "twitter", ig: "instagram", tiktok: "tiktok", fb: "facebook" };

function matchModel(accounts, modelName) {
  const target = modelName.toLowerCase();
  return accounts.find((a) => `${a.name || ""} ${a.username || ""}`.toLowerCase().includes(target));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const PUBLER_API_KEY = Deno.env.get("PUBLER_API_KEY");
    const PUBLER_WORKSPACE_ID = Deno.env.get("PUBLER_WORKSPACE_ID");
    if (!PUBLER_API_KEY || !PUBLER_WORKSPACE_ID) return jsonResponse({ error: "Missing PUBLER_API_KEY or PUBLER_WORKSPACE_ID secret" }, 500);

    const {
      modelName, platform = "x", text = "", mediaId, mediaType = "photo",
      scheduledAt, state = "scheduled",
    } = await req.json();
    if (!modelName) return jsonResponse({ error: "Missing modelName" }, 400);
    if (!text && !mediaId) return jsonResponse({ error: "Post needs text or media" }, 400);

    const networkKey = NETWORK_KEY[platform];
    if (!networkKey) return jsonResponse({ error: `Unsupported platform "${platform}"` }, 400);

    const accountsResp = await fetch(`${PUBLER_API_URL}/accounts`, {
      headers: { "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID },
    });
    const accounts = await accountsResp.json();
    const matchingAccounts = accounts.filter((a) => (a.provider || "").toLowerCase() === networkKey);
    const account = matchModel(matchingAccounts, modelName);
    if (!account) return jsonResponse({ error: `No connected ${platform} account found matching "${modelName}"` }, 404);

    const network = { type: mediaId ? "photo" : "status", text };
    if (mediaId) network.media = [{ id: mediaId, type: mediaType }];

    const accountEntry = { id: account.id };
    // Publer requires scheduled_at at least 1 minute in the future for state
    // "scheduled" — default to +2 minutes if the caller didn't pass one.
    if (state === "scheduled") {
      accountEntry.scheduled_at = scheduledAt || new Date(Date.now() + 2 * 60 * 1000).toISOString();
    }

    const payload = {
      bulk: {
        state,
        posts: [{ networks: { [networkKey]: network }, accounts: [accountEntry] }],
      },
    };

    const resp = await fetch(`${PUBLER_API_URL}/posts/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID },
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    if (!resp.ok || json.error) return jsonResponse({ error: json.error || `Publer schedule failed: ${resp.status}` }, 502);

    return jsonResponse({ jobId: json.job_id, accountMatched: account.name || account.username });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});
