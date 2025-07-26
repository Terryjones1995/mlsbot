/**
 * postDraft.js — Delegates post‑draft map voting, vetos, wagers & reports
 *  • @‑mentions highlight in the live‑match embed
 *  • Voice links renamed → “Join Team 1 Chat / Join Team 2 Chat” with 🎙️
 *  • Live “Match Duration” timer (updates every second)
 *  • Map thumbnail bug fixed
 *  • Max three Game picks + two vetos
 *  • Embed layout: MMR Diff | Odds; Chalk Votes | Capt. Votes; Reports | Pot
 */

const {
  PermissionsBitField,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  Events
} = require('discord.js');
const path      = require('path');
const fs        = require('fs');
const wagers    = require('./wagers');
const adminFire = require('firebase-admin');
const db        = adminFire.firestore();

// ——— Configuration ———————————————————————————
const TEST_MODE                     = true;
const CAPTAIN_VOTES_REQUIRED        = TEST_MODE ? 1 : 2;
const REPORT_CAPTAIN_VOTES_REQUIRED = TEST_MODE ? 1 : 2;
const PLAYER_VOTES_REQUIRED         = 5;
const CATEGORY_ID                   = '1394047708980969514';

const MAX_GAME_PICKS         = 3;  // three games max
const VETO_LIMIT_PER_CAPTAIN = 1;  // one veto per captain

// ——— Map‑and‑mode picker data —————————————————————
const POOLS = {
  popular: [
    { map: 'Scrapyard', mode: 'Headquarters', weight: 22 },
    { map: 'Invasion',  mode: 'Headquarters', weight: 22 },
    { map: 'Terminal',  mode: 'Headquarters', weight: 20 },
    { map: 'Favela',    mode: 'Capture The Flag', weight: 6 },
    { map: 'Highrise',  mode: 'Capture The Flag', weight: 6 },
    { map: 'Favela',    mode: 'Domination', weight: 4 },
    { map: 'Highrise',  mode: 'Domination', weight: 4 },
    { map: 'Sub Base',  mode: 'Headquarters', weight: 4 },
    { map: 'Rundown',   mode: 'Headquarters', weight: 4 },
    { map: 'Karachi',   mode: 'Headquarters', weight: 4 },
    { map: 'Underpass', mode: 'Headquarters', weight: 4 }
  ],
  random: [
    { map: 'Scrapyard', mode: 'Headquarters', weight: 10 },
    { map: 'Invasion',  mode: 'Headquarters', weight: 10 },
    { map: 'Terminal',  mode: 'Headquarters', weight: 10 },
    { map: 'Sub Base',  mode: 'Headquarters', weight: 5 },
    { map: 'Rundown',   mode: 'Headquarters', weight: 5 },
    { map: 'Karachi',   mode: 'Headquarters', weight: 5 },
    { map: 'Underpass', mode: 'Headquarters', weight: 5 },
    { map: 'Favela',    mode: 'Headquarters', weight: 2 },
    { map: 'Skidrow',   mode: 'Headquarters', weight: 2 },
    { map: 'Afghan',    mode: 'Headquarters', weight: 2 },
    { map: 'Wasteland', mode: 'Headquarters', weight: 2 },
    { map: 'Quarry',    mode: 'Headquarters', weight: 2 },
    { map: 'Estate',    mode: 'Headquarters', weight: 1 },
    { map: 'Derail',    mode: 'Headquarters', weight: 1 },

    { map: 'Favela',    mode: 'Capture The Flag', weight: 5 },
    { map: 'Highrise',  mode: 'Capture The Flag', weight: 5 },
    { map: 'Underpass', mode: 'Capture The Flag', weight: 2 },
    { map: 'Rundown',   mode: 'Capture The Flag', weight: 2 },
    { map: 'Quarry',    mode: 'Capture The Flag', weight: 2 },
    { map: 'Derail',    mode: 'Capture The Flag', weight: 1 },

    { map: 'Favela',    mode: 'Domination', weight: 5 },
    { map: 'Highrise',  mode: 'Domination', weight: 5 },
    { map: 'Skidrow',   mode: 'Domination', weight: 2 },
    { map: 'Rundown',   mode: 'Domination', weight: 2 },
    { map: 'Karachi',   mode: 'Domination', weight: 1 },
    { map: 'Quarry',    mode: 'Domination', weight: 1 },

    { map: 'Terminal',  mode: 'Sabotage', weight: 2 },
    { map: 'Scrapyard', mode: 'Sabotage', weight: 2 },
    { map: 'Wasteland', mode: 'Sabotage', weight: 1 }
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

const BUTTON_POPULAR = 'map_pool_popular';
const BUTTON_RANDOM  = 'map_pool_random';
const BUTTON_VETO    = 'map_veto';

function pickWeighted(list) {
  let total = list.reduce((sum, x) => sum + x.weight, 0);
  let r     = Math.random() * total;
  for (const itm of list) {
    if (r < itm.weight) return { map: itm.map, mode: itm.mode };
    r -= itm.weight;
  }
  return { map: list[0].map, mode: list[0].mode };
}

function pickFromPool(pool = 'popular') {
  return pickWeighted(POOLS[pool] || POOLS.popular);
}

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

function createMapFlow(channel, logToChannel, opts) {
  const state = {
    poolVotes:   { popular: new Set(), random: new Set() },
    vetoes:      new Set(),
    gameCount:   0,
    currentPool: null
  };

  async function handleMapVote(inter, winner, loser) {
    if (state.gameCount >= MAX_GAME_PICKS) {
      return inter.reply({ content: `⚠️ Already generated ${MAX_GAME_PICKS} maps.`, flags: 64 });
    }
    await inter.deferUpdate().catch(() => {});

    const uid = inter.user.id;
    if (state.poolVotes.popular.has(uid) || state.poolVotes.random.has(uid)) {
      return inter.followUp({ content: '⚠️ Already voted this round.', flags: 64 });
    }

    const poolKey = inter.customId === BUTTON_POPULAR ? 'popular' : 'random';
    state.poolVotes.popular.delete(uid);
    state.poolVotes.random.delete(uid);
    state.poolVotes[poolKey].add(uid);

    const capVotes = [winner, loser].filter(x =>
      state.poolVotes.popular.has(x) || state.poolVotes.random.has(x)
    ).length;
    const plyVotes = state.poolVotes.popular.size + state.poolVotes.random.size - capVotes;

    if (capVotes >= CAPTAIN_VOTES_REQUIRED || plyVotes >= PLAYER_VOTES_REQUIRED) {
      await inter.followUp({ content: '🔓 Pool unlocked—pick style…', flags: 64 });
      const msg = await channel.send(buildPoolVoteEmbed());
      msg.createMessageComponentCollector({
        componentType: ComponentType.Button,
        max: 1,
        time: 120_000
      }).on('collect', async btn => {
        state.currentPool = btn.customId === BUTTON_POPULAR ? 'popular' : 'random';
        await btn.deferUpdate();
        await btn.message.delete().catch(() => {});
        doPick(false);
      });
    } else {
      await inter.followUp({
        content: `📍 Vote (${plyVotes}/${PLAYER_VOTES_REQUIRED} players, ${capVotes}/${CAPTAIN_VOTES_REQUIRED} captains)`,
        flags: 64
      });
    }
  }

  async function doPick(isVeto) {
    const { map, mode } = pickFromPool(state.currentPool);
    if (!isVeto) state.gameCount++;
    const gameNum = state.gameCount;

    let imageUrl   = null;
    let attachment = null;
    const thumbName = MAP_THUMBS[map];
    if (thumbName) {
      const thumbPath = path.join(__dirname, 'maps', thumbName);
      if (fs.existsSync(thumbPath)) {
        imageUrl   = `attachment://${thumbName}`;
        attachment = { attachment: thumbPath, name: thumbName };
      }
    }

    state.poolVotes.popular.clear();
    state.poolVotes.random.clear();
    state.currentPool = null;

    opts.onMapChosen(`Game #${gameNum} — **${map} — ${mode}**`, imageUrl, attachment);
    logToChannel(channel.guild, `▶️ Map for Game ${gameNum}: ${map} — ${mode}`);
  }

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

    opts.onVetoed();
    await inter.followUp({ content: '❌ Map vetoed! Repicking…', flags: 64 });
    doPick(true);
  }

  return { handleMapVote, handleVeto, state };
}

// ——— Modal‑submit handler —————————————————————————————————
function initPostDraftModalHandler(client) {
  client.on(Events.InteractionCreate, async inter => {
    if (!inter.isModalSubmit() || inter.customId !== 'wager_modal') return;
    const state = matchState.get(inter.channelId);
    if (!state) return;

    await inter.deferReply({ flags: 64 });
    const amt = Number(inter.fields.getTextInputValue('amount').trim());
    if (!Number.isFinite(amt) || amt <= 0) {
      return inter.editReply({ content: '⚠️ Enter a positive number.' });
    }
    const uid = inter.user.id;
    const bal = await wagers.getBalance(uid);
    if (amt > bal) {
      return inter.editReply({ content: `⚠️ You only have ${bal} coins.` });
    }

    await wagers.addBalance(uid, -amt);
    await db.collection('wagers').doc(inter.channel.name).set({
      wagers: adminFire.firestore.FieldValue.arrayUnion({ userId: uid, amount: amt })
    }, { merge: true });

    state.potTotal += amt;
    await state.editLive();

    const wagerEmbed = new EmbedBuilder()
      .setTitle('💰 New Wager')
      .setDescription(`<@${uid}> wagered **${fmt(amt)}** coins.\n\n• ✅ Accept to match\n• ✖ Cancel (owner only)`)
      .setColor(0xF8C300)
      .setTimestamp();
    const wagerRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wager_accept_${uid}_${amt}`)
        .setLabel('✅ Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`wager_cancel_${uid}_${amt}`)
        .setLabel('✖ Cancel').setStyle(ButtonStyle.Danger)
    );
    await inter.channel.send({ embeds: [wagerEmbed], components: [wagerRow] });
    return inter.editReply({ content: `💰 Wager placed for **${fmt(amt)}** coins.` });
  });
}

// ——— Helpers ——————————————————————————————————————————————————
async function getDisplayNames(guild, ids) {
  const arr = [];
  for (const id of ids) {
    let display = `<@${rawId(id)}>`;
    try {
      const m = await guild.members.fetch(rawId(id));
      display = m.displayName
        ? `@${m.displayName}`
        : m.user.username
          ? `@${m.user.username}`
          : display;
    } catch {}
    arr.push(display);
  }
  return arr;
}

const rawId = v => (String(v).match(/\d{17,19}/) || [v])[0];
const fmt   = n => (Math.round(n * 100) / 100).toFixed(2);

async function getAverageMMR(ids) {
  if (!Array.isArray(ids) || !ids.length) return 1000;
  const snaps = await Promise.all(
    ids.map(id => db.collection('users').doc(rawId(id)).get())
  );
  return snaps.reduce((sum, d) => {
    const m = d.exists && typeof d.data().mmr === 'number' ? d.data().mmr : 1000;
    return sum + m;
  }, 0) / ids.length;
}

function calcUpsetOdds(diff) {
  return + (100 / (1 + Math.pow(10, diff / 400))).toFixed(1);
}

function getMentions(ids) {
  return ids.map(id => `<@${rawId(id)}>`); 
}

async function logToChannel(guild, content, fileOrEmbed) {
  const logId = global.guildLogChannels?.get(guild.id);
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  if (fileOrEmbed && fileOrEmbed.data?.title) {
    await ch.send({ content, embeds: [fileOrEmbed] }).catch(() => {});
  } else if (fileOrEmbed) {
    await ch.send({ content, files: [fileOrEmbed] }).catch(() => {});
  } else {
    await ch.send(content).catch(() => {});
  }
}

const matchState = new Map();

// ——— Main post‑draft workflow ——————————————————————————
async function startPostDraft(channel, { team1, team2, winner, loser }) {
  // Guard against deleted channel
  if (!channel || channel.deleted) return;
  try { await channel.fetch(); } catch { return; }

  const guild     = channel.guild;
  const matchName = channel.name;
  const doc       = db.collection('matchLogs').doc(matchName);

  await doc.set({
    team1,
    team2,
    createdAt: adminFire.firestore.FieldValue.serverTimestamp(),
    status: 'ready'
  });

  // Compute MMR stats & Upset Odds
  const avg1        = await getAverageMMR(team1);
  const avg2        = await getAverageMMR(team2);
  const mmrDiff     = Math.abs(avg1 - avg2).toFixed(0);
  const odds        = calcUpsetOdds(mmrDiff);
  const lowerIsTeam1 = avg1 < avg2;

  // Create voice channels
  const basePerms = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.Connect] }];
  const permsFor  = ids => basePerms.concat(
    ids.map(rawId).filter(id => /^\d+$/.test(id)).map(id => ({
      id,
      allow: [PermissionsBitField.Flags.Connect]
    }))
  );
  let vc1, vc2;
  try {
    vc1 = await guild.channels.create({
      name: `${matchName} — Team 1 VC`,
      type: ChannelType.GuildVoice,
      parent: CATEGORY_ID,
      permissionOverwrites: permsFor(team1)
    });
    vc2 = await guild.channels.create({
      name: `${matchName} — Team 2 VC`,
      type: ChannelType.GuildVoice,
      parent: CATEGORY_ID,
      permissionOverwrites: permsFor(team2)
    });
  } catch (err) {
    console.error('[postDraft] VC creation failed:', err);
    return;
  }

  // DM participants to join
  const notify = async (uid, link) => {
    try {
      const user = await guild.client.users.fetch(rawId(uid));
      await user.send(
        `🕑 **Your match is about to start!**\n` +
        `Join your team voice chat here:\n${link}`
      );
    } catch {}
  };
  for (const id of team1) notify(id, `https://discord.com/channels/${guild.id}/${vc1.id}`);
  for (const id of team2) notify(id, `https://discord.com/channels/${guild.id}/${vc2.id}`);

  // Hook up map flow
  const mapFlow = createMapFlow(channel, logToChannel, {
    onMapChosen: async (mapTitle, mapImageUrl, attachment) => {
      state.liveMapTitle       = mapTitle;
      state.liveMapImage       = mapImageUrl;
      state.liveMapAttachments = attachment ? [attachment] : [];
      state.vetoEnabled        = true;
      await state.editLive();
    },
    onVetoed: async () => {
      state.liveMapTitle       = null;
      state.liveMapImage       = null;
      state.liveMapAttachments = [];
      state.vetoEnabled        = true;
      await state.editLive();
    }
  });

  // Build the Live Match embed  (REPLACE WHOLE FUNCTION)
async function buildLiveEmbed(st) {
  const t1 = getMentions(st.team1);
  const t2 = getMentions(st.team2);

  const elapsed = Math.floor((Date.now() - st.startedAt) / 1000);
  const m       = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s       = String(elapsed % 60).padStart(2, '0');
  const dur     = `${m}:${s}`;

  const e = new EmbedBuilder()
    .setTitle(`🔫 ${matchName} — Live Match`)
    .addFields(
      { name: '⏱️ Match Duration', value: dur, inline: false },
      { name: '🟥 Team 1', value: t1.join('\n'), inline: true },
      { name: '🟦 Team 2', value: t2.join('\n'), inline: true }
    )
    .setTimestamp();

  if (st.liveMapImage) {
    e.setThumbnail(st.liveMapImage).setImage(st.liveMapImage);
  }
  if (st.liveMapTitle) {
    e.addFields({ name: `🗺️ Game #${mapFlow.state.gameCount}`, value: st.liveMapTitle, inline: false });
  }

  e.addFields({
    name: '🎙️ Team Chat',
    value:
      `[Join Team 1 Chat](https://discord.com/channels/${guild.id}/${vc1.id})\n` +
      `[Join Team 2 Chat](https://discord.com/channels/${guild.id}/${vc2.id})`,
    inline: false
  });

  e.addFields(
    { name: '📊 MMR Diff',    value: mmrDiff.toString(),                                 inline: true },
    { name: '🎲 Odds',        value: lowerIsTeam1 ? `T1 ${odds}%` : `T2 ${odds}%`,       inline: true },
    { name: '🧹 Chalk Votes', value: `${st.chalkVotes.size}/${PLAYER_VOTES_REQUIRED}`,    inline: true },
    { name: '🗺️ Capt. Votes', value: `0/${CAPTAIN_VOTES_REQUIRED}`,                     inline: true },
    { name: '📝 Reports',     value: `0/${REPORT_CAPTAIN_VOTES_REQUIRED}`,               inline: true },
    { name: '💰 Pot',         value: fmt(st.potTotal),                                   inline: true }
  );

  return e;
}


  // Build button row
  function buildRowButtons() {
    const mapDisabled  = mapFlow.state.gameCount >= MAX_GAME_PICKS;
    const vetoDisabled = mapFlow.state.vetoes.size >= VETO_LIMIT_PER_CAPTAIN * 2;

    const buttons = [
      new ButtonBuilder().setCustomId('chalk').setEmoji('🧹').setLabel('Chalk').setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('map_vote')
        .setEmoji('🗺️')
        .setLabel('Map')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(mapDisabled),
      new ButtonBuilder().setCustomId('wager_open').setEmoji('💰').setLabel('Wager').setStyle(ButtonStyle.Success)
    ];

    if (state.vetoEnabled) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(BUTTON_VETO)
          .setEmoji('✏️')
          .setLabel('Veto')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(vetoDisabled)
      );
    }

    return new ActionRowBuilder().addComponents(buttons);
  }

  // State initialization
  const state = {
    team1,
    team2,
    potTotal:           0,
    chalkVotes:         new Set(),
    liveMapTitle:       null,
    liveMapImage:       null,
    liveMapAttachments: [],
    vetoEnabled:        false,
    liveMsg:            null,
    startedAt:          Date.now(),
    rowActions:         new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('action_select')
        .setPlaceholder('Actions…')
        .addOptions([
          { label: 'Report match',    value: 'report_match',    emoji: '📝' },
          { label: 'Kick a player',   value: 'kick_player',     emoji: '👢' },
          { label: 'Substitution',    value: 'substitution',    emoji: '🔄' },
          { label: 'Promote Captain', value: 'promote_captain', emoji: '⭐' },
          { label: 'Report a problem',value: 'report_issue',    emoji: '⚠️'}
        ])
    ),
    editLive: async () => {
      if (!state.liveMsg) return;
      let msg;
      try { msg = await channel.messages.fetch(state.liveMsg.id); } catch { return; }
      const embed = await buildLiveEmbed(state);
      const payload = {
        embeds:    [embed],
        components:[ buildRowButtons(), state.rowActions ],
        files:     state.liveMapAttachments
      };
      await msg.edit(payload).catch(() => {});
      state.liveMsg = msg;
      
    }
  };
  matchState.set(channel.id, state);

  // Initial send
  try {
    state.liveMsg = await channel.send({
      embeds:     [ await buildLiveEmbed(state) ],
      components: [ buildRowButtons(), state.rowActions ],
      files:      state.liveMapAttachments
    });
  } catch (err) {
    console.error(`[postDraft] failed to send live embed:`, err);
    return;
  }

 // ─── Auto‑refresh: bump embed every 60 s only when something changed
let lastHash = '';
const refresher = setInterval(async () => {
  if (!matchState.has(channel.id)) return clearInterval(refresher);

  // hash only the bits that matter so we don't spam Discord
  const hash = JSON.stringify({
    map:    state.liveMapTitle,
    votes:  state.chalkVotes.size,
    pot:    state.potTotal,
    minute: Math.floor((Date.now() - state.startedAt) / 60000)
  });
  if (hash === lastHash) return;          // nothing new → no bump
  lastHash = hash;

  // delete old embed & resend so it “bumps” the channel
  try { await state.liveMsg.delete().catch(() => {}); } catch {}

  const embed = await buildLiveEmbed(state);
  state.liveMsg = await channel.send({
    embeds:     [embed],
    components: [ buildRowButtons(), state.rowActions ],
    files:      state.liveMapAttachments       // keep thumbnail every bump
  });
}, 60_000);



  // Cleanup & final summary
  async function performCleanup(reason) {
    clearInterval(refresher);
    state.lastT1 = await getDisplayNames(guild, state.team1);
    state.lastT2 = await getDisplayNames(guild, state.team2);

    // 1️⃣ Transcript
    try {
      const msgs = await channel.messages.fetch({ limit: 100 });
      const transcript = msgs
        .map(m => `${m.createdAt.toISOString()} [${m.author.tag}]: ${m.content}`)
        .reverse()
        .join('\n');
      const filename = `${matchName}-transcript.txt`;
      const filepath = path.join(__dirname, filename);
      fs.writeFileSync(filepath, transcript);
      await logToChannel(guild, `📜 Transcript for ${matchName}`, { attachment: filepath, name: filename });
      fs.unlinkSync(filepath);
    } catch (err) {
      console.error('[cleanup] transcript error:', err);
    }

    // 2️⃣ Outcome
    const team1Wins = reason === 'team1';
    const team2Wins = reason === 'team2';
    if (!team1Wins && !team2Wins) {
      await logToChannel(guild, `⚖️ No conclusive report—tie.`);
    } else {
      await logToChannel(guild, `🏆 Team ${team1Wins ? '1' : '2'} wins! (${matchName})`);
    }

    // 3️⃣ MMR update
    const allIds   = [...state.team1, ...state.team2].map(rawId);
    const userDocs = allIds.map(id => db.collection('users').doc(id));
    const beforeSn = await Promise.all(userDocs.map(d => d.get()));
    const beforeDat = beforeSn.map(s => {
      const d = s.exists ? s.data() : {};
      return { ...d, mmr: typeof d.mmr === 'number' ? d.mmr : 1000 };
    });

    try {
      await require('./rewards').processMatch({
        team1Ids: state.team1,
        team2Ids: state.team2,
        winner:   team1Wins ? 1 : team2Wins ? 2 : null,
        chalked:  false
      });
      await logToChannel(guild, '📈 MMR updated.');
    } catch (e) {
      console.error('[cleanup] MMR update error:', e);
      await logToChannel(guild, `⚠️ Error updating MMR: ${e.message}`);
    }

    const afterSn = await Promise.all(userDocs.map(d => d.get()));
    const deltas  = allIds.map((id, i) => ({
      id,
      mmrDelta:
        (afterSn[i].data()?.mmr ?? beforeDat[i].mmr) - beforeDat[i].mmr
    }));

    // 4️⃣ Wagers payout
    let payout = 0, wmsg = '';
    const wRef  = db.collection('wagers').doc(channel.name);
    const wSnap = await wRef.get();
    const wData = wSnap.exists ? wSnap.data() : null;

    if (wData?.wagers?.length) {
      if (team1Wins || team2Wins) {
        const winIds  = team1Wins ? state.team1.map(rawId) : state.team2.map(rawId);
        const loseIds = team1Wins ? state.team2.map(rawId) : state.team1.map(rawId);
        const wWin    = wData.wagers.filter(w => winIds.includes(w.userId));
        const wLose   = wData.wagers.filter(w => loseIds.includes(w.userId));
        const sumWin  = wWin.reduce((s, w) => s + w.amount, 0);
        const sumLose = wLose.reduce((s, w) => s + w.amount, 0);
        const share   = wWin.length ? sumLose / wWin.length : 0;

        for (const w of wWin) {
          await wagers.addBalance(w.userId, w.amount + share);
        }
        payout = sumWin + sumLose;
        wmsg   = `💰 Pot ${fmt(payout)}. Winners got back wager + ${fmt(share)} each.`;
        await wRef.set({
          winner:       winIds,
          paid:         true,
          payoutAmount: payout
        }, { merge: true });
      } else {
        for (const w of wData.wagers) {
          await wagers.addBalance(w.userId, w.amount);
        }
        payout = wData.wagers.reduce((s, w) => s + w.amount, 0);
        wmsg   = `🔄 No opposing bets—refunded ${fmt(payout)} coins.`;
      }
      await logToChannel(guild, wmsg);
    }

    // 5️⃣ Final summary embed
    const fields = [
      { name:'🟥 Team 1',      value: state.lastT1.join('\n'), inline:true },
      { name:'🟦 Team 2',      value: state.lastT2.join('\n'), inline:true },
      { name:'🏁 Outcome',     value: team1Wins ? 'Team 1 Wins' : team2Wins ? 'Team 2 Wins' : 'Tie', inline:false },
      { name:'📊 MMR Changes', value: deltas.map(d => `<@${d.id}>: ${d.mmrDelta >= 0 ? '+' : ''}${d.mmrDelta}`).join('\n'), inline:false }
    ];
    const resultEmbed = new EmbedBuilder()
      .setTitle(`📝 ${matchName} — Final Summary`)
      .addFields(fields)
      .setTimestamp();
    if (state.liveMapTitle) resultEmbed.addFields({ name: '🗺️ Game #1', value: state.liveMapTitle, inline: false });
    if (state.liveMapImage) resultEmbed.setImage(state.liveMapImage);

    await channel.send({ embeds:[resultEmbed] }).catch(() => {});
    await logToChannel(guild, `📝 ${matchName} — Final Summary`, resultEmbed);

    for (const d of deltas) {
      const u = await guild.client.users.fetch(d.id).catch(() => null);
      if (u) u.send(`You ${d.mmrDelta >= 0 ? 'gained' : 'lost'} ${Math.abs(d.mmrDelta)} MMR in ${matchName}.`).catch(() => {});
    }

    await doc.update({
      status:  team1Wins ? 'team1_win' : team2Wins ? 'team2_win' : 'tie',
      endedAt: adminFire.firestore.FieldValue.serverTimestamp(),
      deltas
    });

    for (const id of [...state.team1, ...state.team2]) {
      global.activeUsers?.delete(rawId(id));
    }

    // Delay deletion to let summary log
    setTimeout(async () => {
      if (!channel.deleted) await channel.delete().catch(() => {});
      if (vc1) await vc1.delete().catch(() => {});
      if (vc2) await vc2.delete().catch(() => {});
    }, 20_000);
  }

  // **Actions menu**
  const actionCollector = channel.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: i => i.customId === 'action_select' && i.channelId === channel.id,
    time: 30 * 60_000
  });
  actionCollector.on('collect', async i => {
    await i.deferUpdate();
    const choice = i.values[0];

    if (choice === 'report_match') {
      const chooser = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('report_winner')
          .setPlaceholder('Who won?')
          .addOptions([
            { label: 'Team 1', value: 'team1', emoji: '1️⃣' },
            { label: 'Team 2', value: 'team2', emoji: '2️⃣' }
          ])
      );
      await channel.send({
        content: 'Select the winning team…',
        components: [chooser]
      });
      return;
    }

    if (choice === 'substitution') {
      const st   = matchState.get(channel.id);
      const cap1 = rawId(st.team1[0]);
      const cap2 = rawId(st.team2[0]);
      if (![cap1, cap2].includes(i.user.id)) {
        return i.followUp({ content: 'Only the captain can use substitution.', ephemeral: true });
      }
      st.awaitingSub = {
        userTeam: i.user.id === cap1 ? 'team1' : 'team2',
        captainId: i.user.id
      };
      const teamArr = st[st.awaitingSub.userTeam];
      const names   = await getDisplayNames(i.guild, teamArr);
      const subOutMenu = new StringSelectMenuBuilder()
        .setCustomId('sub_out')
        .setPlaceholder('Select player to replace')
        .addOptions(
          teamArr.map((uid, idx) => ({
            label: names[idx],
            value: rawId(uid)
          }))
        );
      await i.followUp({
        content: 'Who is being subbed out?',
        components: [new ActionRowBuilder().addComponents(subOutMenu)],
        ephemeral: true
      });
      return;
    }

    if (choice === 'promote_captain') {
      const st   = matchState.get(channel.id);
      const cap1 = rawId(st.team1[0]);
      const cap2 = rawId(st.team2[0]);
      let teamKey;
      if (i.user.id === cap1) teamKey = 'team1';
      else if (i.user.id === cap2) teamKey = 'team2';
      else {
        return i.followUp({ content: 'Only the current captain can promote another.', ephemeral: true });
      }
      st.awaitingPromote = { userTeam: teamKey, captainId: i.user.id };
      const candidates = st[teamKey].slice(1);
      if (candidates.length === 0) {
        return i.followUp({ content: 'No eligible teammates to promote.', ephemeral: true });
      }
      const names = await getDisplayNames(i.guild, candidates);
      const promoteMenu = new StringSelectMenuBuilder()
        .setCustomId('promote_select')
        .setPlaceholder('Select new captain')
        .addOptions(
          candidates.map((uid, idx) => ({
            label: names[idx],
            value: rawId(uid)
          }))
        );
      await i.followUp({
        content: 'Pick a teammate to promote to captain:',
        components: [new ActionRowBuilder().addComponents(promoteMenu)],
        ephemeral: true
      });
      return;
    }

    // fallback
    await i.followUp({ content: `${choice} not implemented.`, ephemeral: true });
  });

  // **Sub out**
  const subOutCollector = channel.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: i => i.customId === 'sub_out' && i.channelId === channel.id,
    time: 15 * 60_000
  });
  subOutCollector.on('collect', async i => {
    await i.deferUpdate();
    const st = matchState.get(channel.id);
    if (!st.awaitingSub || i.user.id !== st.awaitingSub.captainId) return;
    st.subOutId = i.values[0];
    const userSelect = new UserSelectMenuBuilder()
      .setCustomId('sub_in')
      .setPlaceholder('Select the substitute');
    await i.followUp({
      content: 'Pick a substitute from the server:',
      components: [new ActionRowBuilder().addComponents(userSelect)],
      ephemeral: true
    });
  });

  // **Sub in**
  const subInCollector = channel.createMessageComponentCollector({
    componentType: ComponentType.UserSelect,
    filter: i => i.customId === 'sub_in' && i.channelId === channel.id,
    time: 15 * 60_000
  });
  subInCollector.on('collect', async i => {
    await i.deferUpdate();
    const st = matchState.get(channel.id);
    if (!st.awaitingSub || i.user.id !== st.awaitingSub.captainId) return;
    const subId   = i.values[0];
    const teamArr = st[st.awaitingSub.userTeam];
    const idx     = teamArr.findIndex(u => rawId(u) === st.subOutId);
    if (idx === -1) {
      return i.followUp({ content: 'Could not find player in team.', ephemeral: true });
    }
    teamArr.splice(idx, 1, subId);
    global.activeUsers?.add(subId);
    st.awaitingSub = null;
    st.subOutId   = null;
    await st.editLive();
    await i.followUp({ content: 'Substitution complete.', ephemeral: true });
  });

  // **Promote captain**
  const promoteCollector = channel.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: i => i.customId === 'promote_select' && i.channelId === channel.id,
    time: 15 * 60_000
  });
  promoteCollector.on('collect', async i => {
    await i.deferUpdate();
    const st = matchState.get(channel.id);
    if (!st.awaitingPromote || i.user.id !== st.awaitingPromote.captainId) return;
    const newCapId = i.values[0];
    const arr      = st[st.awaitingPromote.userTeam];
    const idx      = arr.findIndex(u => rawId(u) === newCapId);
    if (idx <= 0) {
      return i.followUp({ content: 'Invalid selection.', ephemeral: true });
    }
    arr.splice(idx, 1);
    arr.unshift(newCapId);
    st.awaitingPromote = null;
    await st.editLive();
    await i.followUp({ content: `Promoted <@${newCapId}> to captain.`, ephemeral: true });
  });

  // **Report winner**
  const reportCollector = channel.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: i => i.customId === 'report_winner' && i.channelId === channel.id,
    time: 15 * 60_000
  });
  reportCollector.on('collect', async i => {
    await i.deferUpdate();
    const team = i.values[0] === 'team1' ? '1' : '2';
    await i.followUp({ content: `📝 Reporting Team ${team} win…`, ephemeral: true });
    await performCleanup(i.values[0]);
  });

    // **Main button collector**
  const mainBtnCollector = channel.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: btn =>
      btn.channelId === channel.id &&
      ['chalk','map_vote',BUTTON_VETO,'wager_open'].includes(btn.customId),
    time: 30 * 60_000
  });
  mainBtnCollector.on('collect', async interaction => {
    const id = interaction.customId;
    const st = matchState.get(channel.id);
    if (!st) return;
    switch (id) {
      case 'map_vote':
        return mapFlow.handleMapVote(interaction, winner, loser);
      case BUTTON_VETO:
        return mapFlow.handleVeto(interaction, winner, loser);
      case 'wager_open':
        return interaction.showModal(
          new ModalBuilder()
            .setCustomId('wager_modal')
            .setTitle('Place Your Wager')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('amount')
                  .setLabel('Coins to wager')
                  .setStyle(TextInputStyle.Short)
                  .setPlaceholder('Positive number')
                  .setRequired(true)
              )
            )
        );
      case 'chalk':
        await interaction.deferUpdate();
        if (st.chalkVotes.has(interaction.user.id)) {
          return interaction.followUp({ content:'⚠️ Already voted.', ephemeral:true });
        }
        st.chalkVotes.add(interaction.user.id);
        await st.editLive();
        if (st.chalkVotes.size >= PLAYER_VOTES_REQUIRED ||
            [winner, loser].includes(interaction.user.id)) {
          await interaction.followUp({ content:'🧹 Chalk threshold reached—ending.', ephemeral:true });
          await performCleanup(null);
        } else {
          await interaction.followUp({
            content:`🧹 Chalk vote (${st.chalkVotes.size}/${PLAYER_VOTES_REQUIRED})`,
            ephemeral:true
          });
        }
        break;
    }
  });

  // **Wager accept/cancel collector**
  const wagerCol = channel.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: btn => /^wager_(accept|cancel)_/.test(btn.customId) && btn.channelId === channel.id,
    time: 30 * 60_000
  });

  wagerCol.on('collect', async i => {
    const st = matchState.get(channel.id);
    if (!st) return;
    await i.deferUpdate();

    const [ , action, owner, rawAmt ] = i.customId.split('_');
    const amt = Number(rawAmt), uid = i.user.id;
    const ref = db.collection('wagers').doc(channel.name);

    const disableBtns = async msg => {
      const newRows = msg.components.map(r =>
        ActionRowBuilder.from(r).setComponents(
          r.components.map(c => ButtonBuilder.from(c).setDisabled(true))
        )
      );
      await msg.edit({ components: newRows }).catch(() => {});
    };

    if (action === 'cancel') {
      if (uid !== owner) {
        return i.followUp({ content: '❌ Only placer can cancel.', ephemeral: true });
      }
      const snap  = await ref.get();
      const entry = (snap.data()?.wagers || []).find(w => w.userId === owner && w.amount === amt);
      if (!entry) {
        return i.followUp({ content: '⚠️ Already handled.', ephemeral: true });
      }
      await wagers.addBalance(owner, amt);
      await ref.update({ wagers: adminFire.firestore.FieldValue.arrayRemove(entry) });
      st.potTotal -= amt;
      await st.editLive();
      await disableBtns(i.message);
      return i.followUp({ content: `✖ Refunded ${fmt(amt)} coins.`, ephemeral: true });
    }

    if (action === 'accept') {
      if (uid === owner) {
        return i.followUp({ content: '❌ Can’t accept own wager.', ephemeral: true });
      }
      const bal = await wagers.getBalance(uid);
      if (amt > bal) {
        return i.followUp({ content: `⚠️ You only have ${bal} coins.`, ephemeral: true });
      }
      await wagers.addBalance(uid, -amt);
      await ref.set({
        wagers: adminFire.firestore.FieldValue.arrayUnion({ userId: uid, amount: amt })
      }, { merge: true });
      st.potTotal += amt;
      await st.editLive();
      await disableBtns(i.message);

      const matched = new EmbedBuilder()
        .setTitle('💰 Wager Matched')
        .setDescription(`<@${uid}> matched **${fmt(amt)}**.\nPot is now **${fmt(st.potTotal)}**.`)
        .setTimestamp();
      await channel.send({ embeds: [matched] });
      return i.followUp({ content: `✅ Matched ${fmt(amt)} coins!`, ephemeral: true });
    }
  });
}

module.exports = {
  startPostDraft,
  matchState,
  initPostDraftModalHandler
};
