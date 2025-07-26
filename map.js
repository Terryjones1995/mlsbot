/**
 * map.js — MW2 2009 map‐and‐mode picker + pool‐vote & veto flow
 *
 * 2 vetos (1 per captain) + 3 map picks = 5 total interactions.
 * Now updated so that **no new messages** are spawned when a map
 * is chosen or vetoed—only a quick temp upload to grab the CDN URL.
 * Final updates go through postDraft’s callbacks:
 *   • opts.onMapChosen(mapTitle, mapImageUrl)
 *   • opts.onVetoed()
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder
} = require('discord.js');
const path = require('path');
const fs   = require('fs');

// ─── CONFIG ─────────────────────────────────────────
const MAX_POOL_PICKS         = 3;  // three final picks after up to two vetos
const PLAYER_VOTES_REQUIRED  = 5;
const VETO_LIMIT_PER_CAPTAIN = 1;

const POOLS = {
  popular: [
    { map: 'Scrapyard',  mode: 'Headquarters',     weight: 22 },
    { map: 'Invasion',   mode: 'Headquarters',     weight: 22 },
    { map: 'Terminal',   mode: 'Headquarters',     weight: 20 },
    { map: 'Favela',     mode: 'Capture The Flag', weight:  6 },
    { map: 'Highrise',   mode: 'Capture The Flag', weight:  6 },
    { map: 'Favela',     mode: 'Domination',       weight:  4 },
    { map: 'Highrise',   mode: 'Domination',       weight:  4 },
    { map: 'Sub Base',   mode: 'Headquarters',     weight:  4 },
    { map: 'Rundown',    mode: 'Headquarters',     weight:  4 },
    { map: 'Karachi',    mode: 'Headquarters',     weight:  4 },
    { map: 'Underpass',  mode: 'Headquarters',     weight:  4 }
  ],
  random: [
    { map: 'Scrapyard',  mode: 'Headquarters',     weight: 10 },
    { map: 'Invasion',   mode: 'Headquarters',     weight: 10 },
    { map: 'Terminal',   mode: 'Headquarters',     weight: 10 },
    { map: 'Sub Base',   mode: 'Headquarters',     weight:  5 },
    { map: 'Rundown',    mode: 'Headquarters',     weight:  5 },
    { map: 'Karachi',    mode: 'Headquarters',     weight:  5 },
    { map: 'Underpass',  mode: 'Headquarters',     weight:  5 },
    { map: 'Favela',     mode: 'Headquarters',     weight:  2 },
    { map: 'Skidrow',    mode: 'Headquarters',     weight:  2 },
    { map: 'Afghan',     mode: 'Headquarters',     weight:  2 },
    { map: 'Wasteland',  mode: 'Headquarters',     weight:  2 },
    { map: 'Quarry',     mode: 'Headquarters',     weight:  2 },
    { map: 'Estate',     mode: 'Headquarters',     weight:  1 },
    { map: 'Derail',     mode: 'Headquarters',     weight:  1 },

    { map: 'Favela',     mode: 'Capture The Flag', weight:  5 },
    { map: 'Highrise',   mode: 'Capture The Flag', weight:  5 },
    { map: 'Underpass',  mode: 'Capture The Flag', weight:  2 },
    { map: 'Rundown',    mode: 'Capture The Flag', weight:  2 },
    { map: 'Quarry',     mode: 'Capture The Flag', weight:  2 },
    { map: 'Derail',     mode: 'Capture The Flag', weight:  1 },

    { map: 'Favela',     mode: 'Domination',       weight:  5 },
    { map: 'Highrise',   mode: 'Domination',       weight:  5 },
    { map: 'Skidrow',    mode: 'Domination',       weight:  2 },
    { map: 'Rundown',    mode: 'Domination',       weight:  2 },
    { map: 'Karachi',    mode: 'Domination',       weight:  1 },
    { map: 'Quarry',     mode: 'Domination',       weight:  1 },

    { map: 'Terminal',   mode: 'Sabotage',         weight:  2 },
    { map: 'Scrapyard',  mode: 'Sabotage',         weight:  2 },
    { map: 'Wasteland',  mode: 'Sabotage',         weight:  1 }
  ]
};

const MAP_THUMBS = {
  Afghan:    'afghan-t.jpg',
  Derail:    'derail-t.jpg',
  Estate:    'estate-t.jpg',
  Favela:    'favela-t.jpg',
  Highrise:  'highrise-t.jpg',
  Invasion:  'invasion-t.jpg',
  Karachi:   'karachi-t.jpg',
  Quarry:    'quarry-t.jpg',
  Rundown:   'rundown-t.jpg',
  Scrapyard: 'scrapyard-t.jpg',
  Skidrow:   'skidrow-t.jpg',
  'Sub Base':'sub-base-t.jpg',
  Terminal:  'terminal-t.jpg',
  Underpass: 'underpass-t.jpg',
  Wasteland: 'wasteland-t.jpg'
};

// ─── HELPERS ────────────────────────────────────────
function pickWeighted(list) {
  let total = list.reduce((sum, x) => sum + x.weight, 0);
  let r = Math.random() * total;
  for (const itm of list) {
    if (r < itm.weight) return { map: itm.map, mode: itm.mode };
    r -= itm.weight;
  }
  return { map: list[0].map, mode: list[0].mode };
}

function pickFromPool(pool = 'popular') {
  return pickWeighted(POOLS[pool] || POOLS.popular);
}

const BUTTON_POPULAR = 'map_pool_popular';
const BUTTON_RANDOM  = 'map_pool_random';
const BUTTON_VETO    = 'map_veto';

function buildPoolVoteEmbed() {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Choose Map Style')
        .setDescription('Select how the next map will be picked:')
        .addFields(
          { name: '✅ Popular', value: 'Favourites weighted higher', inline: true },
          { name: '🔀 Random',  value: 'Wide variety, lower odds',   inline: true }
        )
        .setColor(0x3B82F6)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(BUTTON_POPULAR).setLabel('Popular').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(BUTTON_RANDOM).setLabel('Random').setStyle(ButtonStyle.Primary)
      )
    ]
  };
}

/**
 * @param {TextChannel} channel
 * @param {Function}    logToChannel  — (guild, content) logger
 * @param {Object}      opts
 *   • opts.onMapChosen(mapTitle: string, mapImageUrl: string|null)
 *   • opts.onVetoed()
 */
function createMapFlow(channel, logToChannel, opts) {
  const state = {
    poolVotes:   { popular: new Set(), random: new Set() },
    vetoes:      new Set(),
    pickCount:   0,
    currentPool: null
  };

  // 1) Vote to unlock pool
  async function handleMapVote(inter, winner, loser) {
    if (state.pickCount >= MAX_POOL_PICKS) {
      return inter.reply({ content: `⚠️ Map already picked ${MAX_POOL_PICKS} times.`, flags: 64 });
    }
    await inter.deferUpdate().catch(() => {});

    const uid = inter.user.id;
    if (state.poolVotes.popular.has(uid) || state.poolVotes.random.has(uid)) {
      return inter.followUp({ content: '⚠️ Already voted this round.', flags: 64 });
    }

    // record vote
    const poolKey = inter.customId === BUTTON_POPULAR ? 'popular' : 'random';
    state.poolVotes.popular.delete(uid);
    state.poolVotes.random.delete(uid);
    state.poolVotes[poolKey].add(uid);

    // count captain vs player votes
    const capVotes = [winner, loser].filter(x =>
      state.poolVotes.popular.has(x) || state.poolVotes.random.has(x)
    ).length;
    const plyVotes = state.poolVotes.popular.size + state.poolVotes.random.size - capVotes;

    if (capVotes >= 1 || plyVotes >= PLAYER_VOTES_REQUIRED) {
      await inter.followUp({ content: '🔓 Map pool unlocked! Choose style…', flags: 64 });
      const msg = await channel.send(buildPoolVoteEmbed());
      msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        max: 1,
        time: 120_000
      }).on('collect', async btn => {
        state.currentPool = btn.customId === BUTTON_POPULAR ? 'popular' : 'random';
        await btn.deferUpdate();
        await btn.message.delete().catch(() => {});
        doPick(winner, loser);
      });
    } else {
      await inter.followUp({
        content: `📍 Vote (${plyVotes}/${PLAYER_VOTES_REQUIRED} players, ${capVotes}/1 captain)`,
        flags: 64
      });
    }
  }

  // 2) Pick & callback
  async function doPick(winner, loser) {
    const { map, mode } = pickFromPool(state.currentPool || 'popular');
    state.pickCount++;

    // fetch CDN thumbnail URL
    let imageUrl = null;
    const thumbName = MAP_THUMBS[map];
    if (thumbName) {
      const thumbPath = path.join(__dirname, 'maps', thumbName);
      if (fs.existsSync(thumbPath)) {
        const tmp = await channel.send({ files: [{ attachment: thumbPath, name: thumbName }] });
        imageUrl = tmp.attachments.first()?.url || null;
        await tmp.delete().catch(() => {});
      }
    }

    // reset for next round
    state.poolVotes.popular.clear();
    state.poolVotes.random.clear();
    state.currentPool = null;

    // notify postDraft
    opts.onMapChosen(`${map} — **${mode}**`, imageUrl);
    logToChannel(channel.guild, `▶️ Map pick #${state.pickCount}: ${map} — ${mode}`);
  }

  // 3) Veto by captain
  async function handleVeto(inter, winner, loser) {
    const uid = inter.user.id;
    if (![winner, loser].includes(uid)) {
      return inter.reply({ content: '❌ Only captains may veto.', flags: 64 });
    }
    if (state.vetoes.has(uid) || state.vetoes.size >= VETO_LIMIT_PER_CAPTAIN * 2) {
      return inter.reply({ content: '⚠️ No vetoes remaining.', flags: 64 });
    }

    state.vetoes.add(uid);
    await inter.deferUpdate().catch(() => {});

    // clear last map
    opts.onVetoed();

    // repick immediately
    await inter.followUp({ content: '❌ Map vetoed! Repicking…', flags: 64 });
    doPick(winner, loser);
  }

  return { handleMapVote, handleVeto, state };
}

module.exports = {
  pickFromPool,
  BUTTON_POPULAR,
  BUTTON_RANDOM,
  BUTTON_VETO,
  createMapFlow
};
