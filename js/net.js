// ---------------------------------------------------------------------------
// The wire. One WebSocket to the bakery server: board ops out, board ops in,
// presence both ways. Knows nothing about 3D or audio — main.js hands it ops
// and reacts to the ones that arrive.
//
// Reconnects transparently: on every (re)welcome the server snapshot is the
// truth and main.js rebuilds the world from it, so a dropped connection can
// never leave two players seeing different boards.
// ---------------------------------------------------------------------------

const OP_THROTTLE_MS = 40;   // continuous ops (knob drags, pedal moves)
const POS_THROTTLE_MS = 80;  // camera/cursor presence stream
const HEARTBEAT_MS = 20000;

export function playerIdentity() {
  // per-tab, so two tabs on one machine are two players in the room
  let id = sessionStorage.getItem('playerId');
  if (!id) {
    id = 'u' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('playerId', id);
  }
  return id;
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

  function connect(roomCode, playerName) {
    code = roomCode;
    name = playerName || name;
    closing = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      ws = new WebSocket(wsUrl());
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === 'error' && !settled) {
          settled = true;
          closing = true;
          reject(new Error(msg.error || 'connection refused'));
          return;
        }
        if (msg.t === 'welcome') {
          you = msg.you;
          welcomed = true;
          retryMs = 1000;
          if (!settled) { settled = true; resolve(msg); }
        }
        dispatch(msg);
      };
      ws.onclose = () => {
        clearInterval(heartbeat);
        heartbeat = null;
        if (closing) return;
        if (!settled) {
          settled = true;
          reject(new Error('bakery unreachable — is the server running?'));
          return;
        }
        handlers.onStatus?.('reconnecting');
        setTimeout(() => {
          if (!closing) connect(code, name).catch(() => {});
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 10000);
      };
      ws.onopen = () => {
        heartbeat = setInterval(() => push({ t: 'hb' }), HEARTBEAT_MS);
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
    clearInterval(heartbeat);
    ws?.close();
    ws = null;
    welcomed = false;
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
