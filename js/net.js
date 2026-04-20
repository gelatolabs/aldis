"use strict";

// WebSocket client for online co-op/versus modes.
//
// Protocol overview
// -----------------
// Server → client (from the Lobby Durable Object):
//   {type: "queued"}                       joined the matchmaking queue
//   {type: "match", role, mode, seed,      a peer was paired; the message also
//                  topRole, isHost}        tells us our role and (for co-op)
//                                          our vertical position
//   {type: "peerLeft"}                     peer disconnected mid-match
//
// Client ↔ client (relayed verbatim by the Lobby DO once matched):
//   {type: "input", aim, beam, kind, held} per-frame lamp state of the sender
//   {type: "spawn", id, x, y, vx, ...}     host announces a new enemy
//   {type: "kill", id, points, byRole, replaceWith?}
//                                          sender killed an enemy; payload
//                                          carries the new word + vx for versus
//                                          bounce, or null to mark it dead
//   {type: "miss", id}                     host: an enemy escaped — apply HP
//   {type: "score", value}                 host: shared co-op score changed
//   {type: "hp", missed}                   host: shared co-op missed count
//   {type: "gameOver", winnerRole?}        host: end of match; winnerRole only
//                                          set in versus
//   {type: "name", role, name}             co-op: my initials for the leaderboard
//   {type: "skip", role}                   co-op: I declined to enter initials

const net = {
  ws: null,
  state: "idle",  // "idle" | "queueing" | "matched"
  mode: null,     // "coop" | "versus"
  role: -1,
  topRole: 0,     // co-op: the role that gets the top-half lamp
  isHost: false,
  seed: 0,
  status: "",     // user-facing matchmaking message
  onMatch: null,
  onPeerLeft: null,
  onPeerMessage: null,
};

function netWsUrl(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + path;
}

function netStartMatchmaking(mode) {
  netDisconnect();
  net.mode = mode;
  net.state = "queueing";
  net.status = "Connecting";

  let ws;
  try {
    ws = new WebSocket(netWsUrl("/api/ws?mode=" + encodeURIComponent(mode)));
  } catch (e) {
    net.status = "Connection failed";
    return;
  }
  net.ws = ws;

  ws.addEventListener("open", () => {
    if (net.state === "queueing") net.status = "Searching for a partner";
  });

  ws.addEventListener("message", (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "queued") {
      net.status = "Searching for a partner";
      return;
    }
    if (msg.type === "match") {
      net.role    = msg.role | 0;
      net.topRole = msg.topRole | 0;
      net.isHost  = !!msg.isHost;
      net.seed    = msg.seed | 0;
      net.state   = "matched";
      net.status  = "";
      if (typeof net.onMatch === "function") net.onMatch();
      return;
    }
    if (msg.type === "peerLeft") {
      net.status = "Partner disconnected";
      if (typeof net.onPeerLeft === "function") net.onPeerLeft("Partner disconnected");
      // The server will close the socket right after this; tear down our state.
      net.state = "idle";
      return;
    }
    if (typeof net.onPeerMessage === "function") net.onPeerMessage(msg);
  });

  ws.addEventListener("close", () => {
    if (net.state === "matched") {
      // Lost the connection mid-match — treat as peer leaving.
      if (typeof net.onPeerLeft === "function") net.onPeerLeft("Connection lost");
    }
    if (net.state === "queueing") {
      // Quietly fall back to "idle" so the user can retry.
      net.status = "Disconnected";
    }
    net.ws = null;
    net.state = "idle";
  });

  ws.addEventListener("error", () => {
    if (net.state === "queueing") net.status = "Connection error";
  });
}

function netCancelMatchmaking() {
  if (net.state === "queueing" && net.ws && net.ws.readyState === WebSocket.OPEN) {
    try { net.ws.send(JSON.stringify({ type: "cancel" })); } catch (e) {}
  }
  netDisconnect();
}

function netSend(msg) {
  if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return;
  try { net.ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
}

function netDisconnect() {
  if (net.ws) {
    try { net.ws.close(); } catch (e) {}
  }
  net.ws = null;
  net.state = "idle";
  net.role = -1;
  net.isHost = false;
  net.mode = null;
}

function netInMatch() {
  return net.state === "matched";
}
