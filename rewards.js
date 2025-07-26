/**
 * rewards.js – match‑result → MMR update logic
 * -------------------------------------------------
 *  ✦ Elo‑style adjustment using team‑average MMR.
 *  ✦ Underdogs gain more, favourites gain less (or lose more).
 *  ✦ Per‑user win/lose record, live streak & last‑10 buffer (W/L chars).
 *
 *  Public API:
 *    • processMatch({ team1Ids, team2Ids, winner, chalked })
 *    • adjustMMR(winningIds, losingIds)
 *    • adjustMMRForTie(allIds)
 *    • getLeaderboardLines(limit = 10)
 */

const admin = require('firebase-admin');        // already initialised in index.js
const db    = admin.firestore();

const DEFAULT_MMR = 100;   // new users start here
const BASE_K      = 32;    // Elo “K‑factor”

/* ── hybrid‑MMR tuning ─────────────────────────────────────────────── */
const MAX_STREAK_BOOST   = 5;    // don’t let streaks explode K
const HOT_MULTIPLIER     = 0.3;  // W‑streak boost per step   (smaller = slower gain)
const COLD_MULTIPLIER    = 0.5;  // L‑streak boost per step   (larger = faster recovery)

const UNDERDOG_THRESHOLD = 0.35; // exp ≤ 35 % ⇒ counted as big under‑dog
const UNDERDOG_SHIELD    = 4;    // bonus points they keep even on a loss

function playerK(user) {
  const boost = Math.min(Math.abs(user.streak), MAX_STREAK_BOOST);
  return BASE_K + boost * (user.streak > 0 ? HOT_MULTIPLIER : COLD_MULTIPLIER);
}

/* ────────────────────────── low‑level helpers ────────────────────────── */

/**
 * Hydrate (or create) a user document.
 * – If the doc is missing we immediately create it with DEFAULT_MMR so
 *   later reads don’t get “undefined → NaN” surprises.
 */
async function getUser(uid) {
  const ref  = db.collection('users').doc(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    /* brand‑new user – seed a record now */
    const fresh = {
      mmr   : DEFAULT_MMR,
      wins  : 0,
      losses: 0,
      streak: 0,
      last10: []
    };
    await ref.set(fresh, { merge: true });
    return fresh;
  }

  const d = snap.data();
  return {
    mmr   : typeof d.mmr    === 'number' ? d.mmr    : DEFAULT_MMR,
    wins  : typeof d.wins   === 'number' ? d.wins   : 0,
    losses: typeof d.losses === 'number' ? d.losses : 0,
    streak: typeof d.streak === 'number' ? d.streak : 0,
    /* always return an array */
    last10: Array.isArray(d.last10) ? d.last10 : []
  };
}

function expectedScore(mmrA, mmrB) {
  return 1 / (1 + Math.pow(10, (mmrB - mmrA) / 400));
}

/* ─────────────────────────── main entry point ────────────────────────── */

/**
 * @param {Object}   opts
 * @param {string[]} opts.team1Ids – Discord user IDs for team 1
 * @param {string[]} opts.team2Ids – Discord user IDs for team 2
 * @param {1|2|null} opts.winner   – 1 or 2 for winner; null for tie
 * @param {boolean}  opts.chalked  – true → no MMR updates
 */
async function processMatch({ team1Ids, team2Ids, winner, chalked = false }) {
  if (chalked || winner === null) return;          // no‑MMR cases

  const t1 = [...new Set(team1Ids)];
  const t2 = [...new Set(team2Ids)];

  /* fetch all users once */
  const users = {};
  await Promise.all(
    [...t1, ...t2].map(async uid => {
      users[uid] = await getUser(uid);
    })
  );

  /* team averages */
  const avg1 = t1.reduce((sum, id) => sum + users[id].mmr, 0) / t1.length;
  const avg2 = t2.reduce((sum, id) => sum + users[id].mmr, 0) / t2.length;

  /* expected team scores */
  const exp1 = expectedScore(avg1, avg2);
  const exp2 = 1 - exp1;

  /* streak‑aware K for each team = average of member Ks */
  const k1 = t1.reduce((s, id) => s + playerK(users[id]), 0) / t1.length;
  const k2 = t2.reduce((s, id) => s + playerK(users[id]), 0) / t2.length;

  /* under‑dog shield: +4 to the losing team if big under‑dog */
  const shield1 = (winner !== 1 && exp1 < UNDERDOG_THRESHOLD) ? UNDERDOG_SHIELD : 0;
  const shield2 = (winner !== 2 && exp2 < UNDERDOG_THRESHOLD) ? UNDERDOG_SHIELD : 0;

  /* final deltas */
  const delta1 = winner === 1
    ?  +k1 * (1 - exp1)
    : -(k1 * exp1) + shield1;

  const delta2 = winner === 2
    ?  +k2 * (1 - exp2)
    : -(k2 * exp2) + shield2;

  /* batch update for speed & atomicity */
  const batch = db.batch();

  function write(uid, won, delta) {
    const ref = db.collection('users').doc(uid);
    const u   = users[uid];

    const newStreak = won
      ? (u.streak >= 0 ? u.streak + 1 : 1)
      : (u.streak <= 0 ? u.streak - 1 : -1);

    const history = Array.isArray(u.last10) ? u.last10 : [];
    const last10  = [won ? 'W' : 'L', ...history].slice(0, 10);

    batch.set(
      ref,
      {
        mmr   : Math.round(u.mmr + delta),
        wins  : u.wins   + (won ? 1 : 0),
        losses: u.losses + (won ? 0 : 1),
        streak: newStreak,
        last10
      },
      { merge: true }
    );
  }

  t1.forEach(uid => write(uid, winner === 1, delta1));
  t2.forEach(uid => write(uid, winner === 2, delta2));

  await batch.commit();
}

/* ──────────────────────── convenience wrappers ─────────────────────── */

const adjustMMR = (winners, losers) =>
  processMatch({ team1Ids: winners, team2Ids: losers, winner: 1 });

const adjustMMRForTie = ids =>
  processMatch({ team1Ids: ids, team2Ids: [], winner: null });

/* ───────────────────────── leaderboard helper ───────────────────────── */

async function getLeaderboardLines(limit = 10) {
  const ss = await db.collection('users')
    .orderBy('mmr', 'desc')
    .limit(limit)
    .get();

  return ss.docs.map((d, i) => {
    const { wins = 0, losses = 0, mmr = DEFAULT_MMR } = d.data();
    return `\`${String(i + 1).padStart(2)}.\` <@${d.id}> — **${mmr} MMR**  (${wins}-${losses})`;
  });
}

module.exports = {
  processMatch,
  adjustMMR,
  adjustMMRForTie,
  getLeaderboardLines
};
