// Supabase Edge Function: publer-demographics
// Audience demographics (age range, top countries) for the IG/X dashboards'
// "Age range" and "Impressions worldwide" cards. Separate from post_insights
// — this hits Publer's account-level chart_data endpoint, which needs a
// Business-tier Publer plan and only accumulates data going forward from
// whenever that plan kicked in (not retroactive), so this can legitimately
// come back empty for a while on a freshly-upgraded workspace.
//
// Deploy: `supabase functions deploy publer-demographics`
// Secrets needed: PUBLER_API_KEY, PUBLER_WORKSPACE_ID
//
// Body: { modelName: string, platform?: "x"|"ig"|"tiktok"|"fb" (default "ig"), days?: number (default 7) }

const PUBLER_API_URL = "https://app.publer.io/api/v1";
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

// Country codes come back as ISO-3166 alpha-2 (e.g. "US") — mapped to a flag
// emoji client-side is easy (regional indicator math), so we just pass the
// code straight through rather than hardcoding a name/flag table here.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const PUBLER_API_KEY = Deno.env.get("PUBLER_API_KEY");
    const PUBLER_WORKSPACE_ID = Deno.env.get("PUBLER_WORKSPACE_ID");
    if (!PUBLER_API_KEY || !PUBLER_WORKSPACE_ID) return jsonResponse({ error: "Missing PUBLER_API_KEY or PUBLER_WORKSPACE_ID secret" }, 500);

    const { modelName, platform = "ig", days = 7 } = await req.json();
    if (!modelName) return jsonResponse({ error: "Missing modelName" }, 400);
    const provider = NETWORK_PROVIDER[platform];
    if (!provider) return jsonResponse({ error: `Unsupported platform "${platform}"` }, 400);

    const accountsResp = await fetch(`${PUBLER_API_URL}/accounts`, {
      headers: { "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID },
    });
    const accounts = await accountsResp.json();
    const matchingAccounts = accounts.filter((a) => (a.provider || "").toLowerCase() === provider);
    const account = matchAccount(matchingAccounts, modelName);
    if (!account) return jsonResponse({ error: `No connected ${platform} account found matching "${modelName}"`, ages: [], countries: [] });

    const chartIds = ["ages", "countries", "cities", "followers"].map((id) => `chart_ids[]=${id}`).join("&");
    const resp = await fetch(`${PUBLER_API_URL}/analytics/${account.id}/chart_data?${chartIds}`, {
      headers: { "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID },
    });
    if (!resp.ok) return jsonResponse({ error: `Publer chart_data failed: ${resp.status}` }, 502);
    const json = await resp.json();
    const current = json.current || {};

    // link_clicks is fetched separately with an explicit from/to matching
    // the requested window — chart_data buckets by week instead of by day
    // once the range gets wide, so this keeps it daily for 7d and lets it
    // fall back to whatever granularity Publer picks for 30d.
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (Math.max(1, Number(days) || 7) - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const linkResp = await fetch(`${PUBLER_API_URL}/analytics/${account.id}/chart_data?chart_ids[]=link_clicks&from=${from}&to=${to}`, {
      headers: { "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID },
    });
    const linkJson = linkResp.ok ? await linkResp.json() : { current: {} };
    const linkSeries = Array.isArray(linkJson.current?.link_clicks) ? linkJson.current.link_clicks : [];
    const linkClicks = {
      series: linkSeries.map((p) => ({ date: p.date, label: p.label, value: Number(p.value) || 0 })),
      total: linkSeries.reduce((s, p) => s + (Number(p.value) || 0), 0),
    };

    // "ages" comes back as { data: { "18-24": n, "25-34": n, ... } } (or empty
    // {} until Publer has accumulated anything) — normalize to a flat array.
    const ageData = current.ages?.data || {};
    const ages = Object.entries(ageData)
      .map(([label, value]) => ({ label, value: Number(value) || 0 }))
      .filter((a) => a.value > 0)
      .sort((a, b) => b.value - a.value);
    const ageTotal = ages.reduce((s, a) => s + a.value, 0);
    const agesPct = ages.map((a) => ({ ...a, pct: ageTotal > 0 ? Math.round((a.value / ageTotal) * 100) : 0 }));

    // "countries" comes back as an array of {date,...} time-series points
    // when there's history, or a flat breakdown depending on range — handle
    // both shapes defensively and just take whatever the latest point is.
    const rawCountries = Array.isArray(current.countries) ? current.countries : [];
    const latestCountries = rawCountries.length ? (rawCountries[rawCountries.length - 1].breakdown || rawCountries[rawCountries.length - 1].data || {}) : {};
    const countries = Object.entries(latestCountries)
      .map(([code, value]) => ({ code, value: Number(value) || 0 }))
      .filter((c) => c.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
    const totalImpressions = countries.reduce((s, c) => s + c.value, 0);

    return jsonResponse({ accountMatched: account.name || account.username, ages: agesPct, countries, totalImpressions, linkClicks, raw: current });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});
