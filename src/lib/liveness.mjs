// Single source of truth for "is participant @X actually polling right now?"
//
// Last-seen is touched by the daemon on every register / say / poll RETURN.
// Poll timeouts are 30 s for most agents, 60 s for copilot — so a healthy
// agent's last_seen can legitimately be up to ~60 s old. Anything older
// than that strongly suggests the host CLI runtime stalled.
//
// Thresholds are deliberately conservative; tune via env if needed.

export const FRESH_MAX_S = Number(process.env.MURMUR_LIVENESS_FRESH_S ?? 90);
export const STALE_MAX_S = Number(process.env.MURMUR_LIVENESS_STALE_S ?? 300);

export function classify(lastSeenIso, nowMs = Date.now()) {
  if (!lastSeenIso) return { ageS: null, status: "unknown" };
  const ageS = Math.max(0, Math.round((nowMs - Date.parse(lastSeenIso)) / 1000));
  let status;
  if (ageS <= FRESH_MAX_S) status = "fresh";
  else if (ageS <= STALE_MAX_S) status = "stale";
  else status = "dead";
  return { ageS, status };
}

export function liveness(participants, nowMs = Date.now()) {
  return participants.map((p) => ({
    handle: p.handle,
    agent_type: p.agent_type,
    last_seen: p.last_seen,
    ...classify(p.last_seen, nowMs),
  }));
}

export function fmtAge(ageS) {
  if (ageS == null) return "—";
  if (ageS < 60) return `${ageS}s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m${ageS % 60}s`;
  return `${Math.floor(ageS / 3600)}h${Math.floor((ageS % 3600) / 60)}m`;
}

export const STATUS_TAG = {
  fresh: "✓",
  stale: "⚠",
  dead: "✗",
  unknown: "?",
};
