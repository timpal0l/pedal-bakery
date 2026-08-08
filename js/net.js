// ---------------------------------------------------------------------------
// The wire. One WebSocket to the bakery server: board ops out, board ops in,
// presence both ways. Knows nothing about 3D or audio — main.js hands it ops
// and reacts to the ones that arrive.
//
// Reconnects transparently: on every (re)welcome the server snapshot is the
// truth and main.js rebuilds the world from it, so a dropped connection can
// never leave two players seeing different boards. Every socket carries a
// generation number; events from a superseded socket are ignored, so switching
// rooms or double-connecting can never leak a live connection or start a
// reconnect loop against the wrong room.
// ---------------------------------------------------------------------------

const OP_THROTTLE_MS = 40;   // continuous ops (knob drags, pedal moves)
const POS_THROTTLE_MS = 80;  // camera/cursor presence stream
const HEARTBEAT_MS = 20000;

function mintIdentity() {
  const id = 'u' + Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem('playerId', id);
  return id;
}

export function playerIdentity() {
  // per-tab, so two tabs on one machine are two players in the room
  return sessionStorage.getItem('playerId') || mintIdentity();
}

export function createNet(handlers) {
  let ws = null;
  let code = null;
  let name = 'player';
  let you = null;
  let closing = false;
  let welcomed = false;
  let retryMs = 1000;
  let heartbeat = null;
  let gen = 0; // socket generation — events from superseded sockets are ignored

  const pendingOps = new Map();   // throttle key -> op (trailing edge)
  const opTimers = new Map();     // throttle key -> timeout id
  let pendingPos = null;
  let posTimer = null;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ code, player: playerIdentity(), name });
    return `${proto}://${location.host}/ws?${q}`;
  }

  function push(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Drop the current socket and everything scheduled around it. Bumping gen
  // orphans the old socket's onclose/onmessage and any pending reconnect
  // timer, so nothing fires on behalf of a connection we abandoned.
  function teardown() {
    gen += 1;
    clearInterval(heartbeat);
    heartbeat = null;
    for (const t of opTimers.values()) clearTimeout(t);
    opTimers.clear();
    pendingOps.clear();
    if (posTimer) { clearTimeout(posTimer); posTimer = null; }
    pendingPos = null;
    welcomed = false;
    if (ws) { try { ws.close(); } catch { /* already dead */ } ws = null; }
  }

  function connect(roomCode, playerName) {
    teardown(); // switching rooms / double-connect must never leak a socket
    code = roomCode;
    name = playerName || name;
    closing = false;
    const myGen = gen;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = new WebSocket(wsUrl());
      ws = sock;
      sock.onopen = () => {
        if (gen !== myGen) return;
        heartbeat = setInterval(() => push({ t: 'hb' }), HEARTBEAT_MS);
      };
      sock.onmessage = (e) => {
        if (gen !== myGen) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === 'error') {
          if (!settled) {
            settled = true;
            closing = true;
            reject(new Error(msg.error || 'connection refused'));
          } else if (/taken over/i.test(msg.error || '')) {
            // a duplicated tab inherited our sessionStorage id and evicted
            // us — become a fresh player instead of evicting them back
            mintIdentity();
            connect(code, name).catch(() => {});
          } else {
            closing = true;
            handlers.onStatus?.('refused', msg.error || 'kicked');
          }
          return;
        }
        if (msg.t === 'welcome') {
          you = msg.you;
          welcomed = true;
          retryMs = 1000;
          if (!settled) { settled = true; resolve(msg); }
        }
        if (!welcomed && msg.t === 'op') return; // never mutate a pre-snapshot world
        dispatch(msg);
      };
      sock.onclose = () => {
        if (gen !== myGen) return; // superseded socket — not our problem
        clearInterval(heartbeat);
        heartbeat = null;
        welcomed = false;
        if (closing) return;
        if (!settled) {
          settled = true;
          reject(new Error('bakery unreachable — is the server running?'));
          return;
        }
        handlers.onStatus?.('reconnecting');
        setTimeout(() => {
          if (gen === myGen && !closing) connect(code, name).catch(() => {});
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 10000);
      };
    });
  }

  function dispatch(msg) {
    switch (msg.t) {
      case 'welcome': handlers.onWelcome?.(msg); break;
      case 'op': handlers.onOp?.(msg.op, msg.from); break;
      case 'pos': handlers.onPos?.(msg); break;
      case 'join': handlers.onJoin?.(msg.player); break;
      case 'leave': handlers.onLeave?.(msg.player); break;
      case 'shelf': handlers.onShelf?.(); break;
    }
  }

  function leave() {
    closing = true;
    teardown();
  }

  /* ops: discrete ones go straight out; continuous ones (knob, move) are
     throttled per key so a drag streams at a sane rate, with flush() on
     pointerup so the final value always lands */

  function sendOp(op) {
    push({ t: 'op', op });
  }

  function sendOpThrottled(key, op) {
    pendingOps.set(key, op);
    if (opTimers.has(key)) return;
    opTimers.set(key, setTimeout(() => {
      opTimers.delete(key);
      const queued = pendingOps.get(key);
      pendingOps.delete(key);
      if (queued) sendOp(queued);
    }, OP_THROTTLE_MS));
  }

  function flushOps() {
    for (const [key, timer] of opTimers) { clearTimeout(timer); opTimers.delete(key); }
    for (const [, op] of pendingOps) sendOp(op);
    pendingOps.clear();
  }

  function sendPos(x, z, cx, cz) {
    pendingPos = { t: 'pos', x, z, cx, cz };
    if (posTimer) return;
    posTimer = setTimeout(() => {
      posTimer = null;
      if (pendingPos) { push(pendingPos); pendingPos = null; }
    }, POS_THROTTLE_MS);
  }

  function sendShelf() { push({ t: 'shelf' }); }

  return {
    connect, leave, sendOp, sendOpThrottled, flushOps, sendPos, sendShelf,
    connected: () => !!ws && ws.readyState === WebSocket.OPEN && welcomed,
    you: () => you,
    code: () => code,
  };
}

/* ------------------------------------------------- saved bakery sessions -- */

const SESSIONS_KEY = 'bakeries';

export function savedBakeries() {
  try {
    const list = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function rememberBakery(code, role) {
  const list = savedBakeries().filter((b) => b.code !== code);
  list.unshift({ code, role, ts: Date.now() });
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, 12)));
}

export function forgetBakery(code) {
  localStorage.setItem(SESSIONS_KEY,
    JSON.stringify(savedBakeries().filter((b) => b.code !== code)));
}
