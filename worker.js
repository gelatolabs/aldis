// Cloudflare backend
// KV leaderboards for survival and co-op modes.
// Durable Object matchmaking + WebSocket relay for co-op and versus modes.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/scores") {
      if (req.method === "GET")  return getScores(env, "top");
      if (req.method === "POST") return postSurvivalScore(req, env);
      return new Response("method not allowed", { status: 405 });
    }
    if (url.pathname === "/api/scores-coop") {
      if (req.method === "GET")  return getScores(env, "top_coop");
      if (req.method === "POST") return postCoopScore(req, env);
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/ws") {
      const id = env.LOBBY.idFromName("global");
      return env.LOBBY.get(id).fetch(req);
    }

    return env.ASSETS.fetch(req);
  },
};

// ---- Leaderboards ----

async function getScores(env, key) {
  const data = (await env.SCORES.get(key, { type: "json" })) || [];
  return json(data);
}

async function postSurvivalScore(req, env) {
  let body;
  try { body = await req.json(); } catch { return text("bad json", 400); }
  if (!body || typeof body !== "object") return text("bad body", 400);
  const name = String(body.name || "")
    .toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  const score = Math.max(0, Math.floor(Number(body.score) || 0));
  if (name.length !== 3) return text("bad name", 400);
  if (score <= 0)        return text("bad score", 400);
  return appendTop(env, "top", { name, score, at: Date.now() });
}

async function postCoopScore(req, env) {
  let body;
  try { body = await req.json(); } catch { return text("bad json", 400); }
  if (!body || typeof body !== "object") return text("bad body", 400);
  const name1 = sanitizeCoopName(body.name1);
  const name2 = sanitizeCoopName(body.name2);
  const score = Math.max(0, Math.floor(Number(body.score) || 0));
  if (score <= 0) return text("bad score", 400);
  return appendTop(env, "top_coop",
                   { name: name1 + "+" + name2, score, at: Date.now() });
}

function sanitizeCoopName(s) {
  let v = String(s == null ? "___" : s).toUpperCase();
  v = v.replace(/[^A-Z_]/g, "_").slice(0, 3);
  while (v.length < 3) v += "_";
  return v;
}

async function appendTop(env, key, row) {
  const existing = (await env.SCORES.get(key, { type: "json" })) || [];
  existing.push(row);
  existing.sort((a, b) => b.score - a.score || a.at - b.at);
  const top = existing.slice(0, 10);
  await env.SCORES.put(key, JSON.stringify(top));
  return json(top);
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
function text(t, s) { return new Response(t, { status: s }); }

// ---- Lobby Durable Object ----
//
// Singleton DO holding the matchmaking queues and live match relays. Each
// WebSocket joins a per-mode FIFO queue; the next arrival is paired with the
// head of the queue. Once paired, the DO acts as a dumb relay: any JSON
// message sent by one peer is forwarded verbatim to the other.

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queues = { coop: [], versus: [] };
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode");
    if (mode !== "coop" && mode !== "versus") {
      return new Response("bad mode", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.attach(server, mode);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws, mode) {
    const player = { ws, mode, status: "queued", peer: null, role: -1 };

    const queue = this.queues[mode];
    if (queue.length > 0) {
      const other = queue.shift();
      // Other might have closed in the brief moment before we got here.
      if (other.status === "queued") {
        this.pair(other, player, mode);
      } else {
        // Discard the stale entry and queue this one instead.
        this.enqueue(player, queue);
      }
    } else {
      this.enqueue(player, queue);
    }

    ws.addEventListener("message", (evt) => {
      const data = typeof evt.data === "string" ? evt.data : null;
      if (!data) return;

      if (player.status === "queued") {
        try {
          const m = JSON.parse(data);
          if (m && m.type === "cancel") {
            this.removeFromQueue(player);
            try { ws.close(1000, "cancelled"); } catch (e) {}
          }
        } catch (e) { /* ignore */ }
        return;
      }

      if (player.status === "matched" && player.peer) {
        try { player.peer.ws.send(data); } catch (e) {}
      }
    });

    ws.addEventListener("close", () => {
      if (player.status === "queued") {
        this.removeFromQueue(player);
      } else if (player.status === "matched" && player.peer) {
        const peer = player.peer;
        try {
          peer.ws.send(JSON.stringify({ type: "peerLeft" }));
          peer.ws.close(1000, "peer left");
        } catch (e) {}
        peer.peer = null;
        player.peer = null;
      }
      player.status = "closed";
    });

    ws.addEventListener("error", () => {
      try { ws.close(); } catch (e) {}
    });
  }

  enqueue(player, queue) {
    queue.push(player);
    try { player.ws.send(JSON.stringify({ type: "queued" })); } catch (e) {}
  }

  removeFromQueue(player) {
    const q = this.queues[player.mode];
    const i = q.indexOf(player);
    if (i >= 0) q.splice(i, 1);
  }

  pair(p1, p2, mode) {
    p1.status = "matched"; p2.status = "matched";
    p1.peer = p2; p2.peer = p1;
    p1.role = 0; p2.role = 1;

    const seed = Math.floor(Math.random() * 2_000_000_000);
    const topRole = Math.random() < 0.5 ? 1 : 0;

    for (const p of [p1, p2]) {
      try {
        p.ws.send(JSON.stringify({
          type: "match",
          role: p.role,
          mode,
          seed,
          topRole,
          isHost: p.role === 0,
        }));
      } catch (e) {}
    }
  }
}
