// Quick test endpoint: GET /api/test
// Returns the received Authorization header and body so you can debug the Shortcut
export async function onRequestGet(context) {
  const { request, env } = context;
  return new Response(JSON.stringify({
    ok: true,
    message: "Function is reachable",
    secret_set: !!env.LOG_SMS_SECRET,
    secret_length: (env.LOG_SMS_SECRET || "").length,
  }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try { body = await request.json(); } catch {}
  const authHdr = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const bodyKey = (body.key || "").trim();
  const token   = bodyKey || authHdr;
  return new Response(JSON.stringify({
    ok: true,
    received_key_in_body: bodyKey,
    received_auth_header: authHdr,
    token_matches: token === env.LOG_SMS_SECRET,
    body_keys: Object.keys(body),
  }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
