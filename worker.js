export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/scores") {
      if (req.method === "GET")  return handleGet(env);
      if (req.method === "POST") return handlePost(req, env);
      return new Response("method not allowed", { status: 405 });
    }
    return env.ASSETS.fetch(req);
  },
};

async function handleGet(env) {
  const data = (await env.SCORES.get("top", { type: "json" })) || [];
  return json(data);
}

async function handlePost(req, env) {
  let body;
  try { body = await req.json(); } catch { return text("bad json", 400); }
  if (!body || typeof body !== "object") return text("bad body", 400);

  const name = String(body.name || "")
    .toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  const score = Math.max(0, Math.floor(Number(body.score) || 0));
  if (name.length !== 3) return text("bad name", 400);
  if (score <= 0)        return text("bad score", 400);

  const existing = (await env.SCORES.get("top", { type: "json" })) || [];
  existing.push({ name, score, at: Date.now() });
  existing.sort((a, b) => b.score - a.score);
  const top = existing.slice(0, 10);
  await env.SCORES.put("top", JSON.stringify(top));
  return json(top);
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function text(t, s) {
  return new Response(t, { status: s });
}
