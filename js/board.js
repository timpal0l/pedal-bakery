// ---------------------------------------------------------------------------
// The board: which pedal connects to which. Pure data — no 3D, no audio.
//
// Nodes are pedal instance ids plus the two fixed endpoints 'source' (the
// guitar / E chord) and 'amp'. Signal flows out -> in, one cable per jack.
// ---------------------------------------------------------------------------

export function createBoard() {
  const outTo = new Map(); // fromId -> toId  (fromId's OUTPUT jack cable)
  const inFrom = new Map(); // toId -> fromId (toId's INPUT jack cable)

  function connect(from, to) {
    disconnectJack(from, 'out');
    disconnectJack(to, 'in');
    outTo.set(from, to);
    inFrom.set(to, from);
  }

  function disconnectJack(id, kind) {
    if (kind === 'out') {
      const to = outTo.get(id);
      if (to != null) { outTo.delete(id); inFrom.delete(to); }
    } else {
      const from = inFrom.get(id);
      if (from != null) { inFrom.delete(id); outTo.delete(from); }
    }
  }

  function removeNode(id) {
    disconnectJack(id, 'out');
    disconnectJack(id, 'in');
  }

  function jackUsed(id, kind) {
    return kind === 'out' ? outTo.has(id) : inFrom.has(id);
  }

  // All complete signal paths: for each source id, follow the cables; a path
  // that reaches any amp id yields { source, pedals: [...] }. Anything else
  // (dangling or looping) is simply not in the result -> silence.
  function chains(sourceIds, ampIds) {
    const result = [];
    for (const src of sourceIds) {
      const pedals = [];
      const visited = new Set();
      let cur = src;
      for (;;) {
        const to = outTo.get(cur);
        if (to == null || visited.has(to)) break;
        if (ampIds.has(to)) { result.push({ source: src, pedals, amp: to }); break; }
        visited.add(to);
        pedals.push(to);
        cur = to;
      }
    }
    return result;
  }

  function connections() {
    return [...outTo.entries()].map(([from, to]) => ({ id: `${from}->${to}`, from, to }));
  }

  return { connect, disconnectJack, removeNode, jackUsed, chains, connections };
}
