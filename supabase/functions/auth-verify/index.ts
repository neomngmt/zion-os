// Supabase Edge Function: auth-verify
// Server-side login verification for both login modes (team PIN, creator
// name+password) so the actual PIN/password values never have to be
// fetched into the browser to be compared — the frontend used to load the
// whole `models`/`settings` tables (including the real plaintext
// pin/admin_pin columns) via the anon key just to compare client-side,
// which meant literally anyone with the app's public anon key could read
// every creator's password directly from Supabase's REST API, no login
// required. This function uses the service role key (server-side only) to
// do the real lookup+compare, and returns nothing but a yes/no + the
// minimal session info the app needs.
//
// Deploy: supabase functions deploy auth-verify
// No extra secrets needed beyond the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// every Edge Function already gets automatically.
//
// Body shapes:
//   { type: "team", agency: "CZ"|"US", pin: string }
//     -> { ok: true } | { ok: false, reason: "wrong" }
//   { type: "creator-status", name: string }
//     -> { exists: boolean, hasPassword: boolean }
//     (existence/registration-state only — never returns the password itself)
//   { type: "creator-login", name: string, password: string }
//     -> { ok: true, agency, registered?: true } | { ok: false, reason: "not-found"|"needs-password"|"wrong" }
//     When the matched model has no password set yet, this ALSO sets it
//     (first-login registration) server-side rather than requiring a
//     separate client-side write of the plaintext value.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    const body = await req.json().catch(() => ({}));
    const type = body?.type;

    if (type === "team") {
      const agency = body.agency === "US" ? "US" : "CZ";
      const pin = String(body.pin ?? "");
      const { data, error } = await supabase.from("settings").select("admin_pin_cz, admin_pin_us").eq("id", 1).maybeSingle();
      if (error) throw error;
      const required = (agency === "US" ? data?.admin_pin_us : data?.admin_pin_cz) || "";
      // No PIN configured for this agency is treated as "login blocked", not
      // "anyone gets in" — the opposite of the old client-side bug, where an
      // empty required-PIN string skipped the check entirely.
      if (!required || pin !== required) return jsonResponse({ ok: false, reason: "wrong" });
      return jsonResponse({ ok: true });
    }

    if (type === "creator-status") {
      const name = String(body.name || "").trim().toLowerCase();
      if (!name) return jsonResponse({ exists: false, hasPassword: false });
      const { data, error } = await supabase.from("models").select("name, pin").ilike("name", name);
      if (error) throw error;
      const m = (data || []).find((r) => r.name.trim().toLowerCase() === name);
      return jsonResponse({ exists: !!m, hasPassword: !!(m && m.pin) });
    }

    if (type === "creator-login") {
      const name = String(body.name || "").trim();
      const password = String(body.password ?? "");
      const { data: models, error } = await supabase.from("models").select("name, pin, agency").ilike("name", name);
      if (error) throw error;
      const m = (models || []).find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!m) return jsonResponse({ ok: false, reason: "not-found" });

      if (!m.pin) {
        if (!password) return jsonResponse({ ok: false, reason: "needs-password" });
        const { error: updateErr } = await supabase.from("models").update({ pin: password }).eq("name", m.name);
        if (updateErr) throw updateErr;
        return jsonResponse({ ok: true, agency: m.agency || "CZ", registered: true });
      }

      if (password !== m.pin) return jsonResponse({ ok: false, reason: "wrong" });
      return jsonResponse({ ok: true, agency: m.agency || "CZ" });
    }

    return jsonResponse({ error: "Unknown or missing type" }, 400);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});
