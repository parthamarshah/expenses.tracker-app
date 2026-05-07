// Cloudflare Worker function: GET /api/health
// Cheap, no-auth status endpoint. Reports whether the Worker's required
// runtime env vars are present. Does NOT round-trip to Supabase — checking
// "config is present" catches the failure mode this endpoint exists for
// (deploys where SUPABASE_URL / SUPABASE_SERVICE_KEY were never set in the
// Cloudflare dashboard) without adding latency or transient flakiness.
const cors = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

export async function onRequestGet({ env }) {
  const missing = [];
  if (!env.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!env.SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");

  if (missing.length) {
    return new Response(
      JSON.stringify({ ok: false, error: "missing env", missing }),
      { status: 500, headers: cors }
    );
  }

  return new Response(
    JSON.stringify({ ok: true, time: new Date().toISOString() }),
    { status: 200, headers: cors }
  );
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
