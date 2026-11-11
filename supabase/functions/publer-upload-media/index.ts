// Supabase Edge Function: publer-upload-media
// Thin proxy for Publer's POST /media — the frontend never sees
// PUBLER_API_KEY directly, it just posts the file here and gets back
// Publer's media id + hosted URL to attach to a scheduled post later.
//
// Deploy: `supabase functions deploy publer-upload-media`
// Secrets needed: PUBLER_API_KEY, PUBLER_WORKSPACE_ID

const PUBLER_API_URL = "https://app.publer.io/api/v1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const PUBLER_API_KEY = Deno.env.get("PUBLER_API_KEY");
    const PUBLER_WORKSPACE_ID = Deno.env.get("PUBLER_WORKSPACE_ID");
    if (!PUBLER_API_KEY || !PUBLER_WORKSPACE_ID) {
      return jsonResponse({ error: "Missing PUBLER_API_KEY or PUBLER_WORKSPACE_ID secret" }, 500);
    }

    const incomingForm = await req.formData();
    const file = incomingForm.get("file");
    if (!file || !(file instanceof File)) return jsonResponse({ error: "Missing file" }, 400);

    const outgoingForm = new FormData();
    outgoingForm.append("file", file, file.name);
    outgoingForm.append("direct_upload", "true");

    const resp = await fetch(`${PUBLER_API_URL}/media`, {
      method: "POST",
      headers: { "Authorization": `Bearer-API ${PUBLER_API_KEY}`, "Publer-Workspace-Id": PUBLER_WORKSPACE_ID },
      body: outgoingForm,
    });
    const json = await resp.json();
    if (!resp.ok || json.error) return jsonResponse({ error: json.error || `Publer upload failed: ${resp.status}` }, 502);

    return jsonResponse({ id: json.id, path: json.path, thumbnail: json.thumbnail, type: json.type, validity: json.validity });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});
