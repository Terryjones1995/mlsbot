/**
 * match.js — full-match workflow with logging and persistent match numbering
 *  • Manual draft timer (updates every second for mobile)
 *  • Caches display names for zero-lag buttons
 *  • Shows which captain is on the clock
 *  • “You’re not on the clock” ephemerally when invalid picks are clicked
 *  • RPS always announces final outcome after ties and DMs both players
 *  • NEW: Captains vote on “Snake” vs “Straight” draft; RPS fallback on tie
 *  • NEW: Shows each user’s MMR beside their name in draft
 *  • NEW: Shows each team’s total MMR in the embed title
 *  • NEW: Match numbers persist in Firestore so they never reset on restart
 */

const {
  ChannelType,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType
} = require('discord.js');

const { startPostDraft } = require('./postDraft');
const admin = require('firebase-admin');
const db    = admin.firestore();

const CATEGORY_ID = '1394047708980969514';

// ───── Persistent match counter ─────
async function getNextMatchNumber() {
  const ref  = db.collection('meta').doc('counters');
  const snap = await ref.get();
  let count = snap.exists && typeof snap.data().matchCount === 'number'
    ? snap.data().matchCount
    : 0;
  count += 1;
  await ref.set({ matchCount: count }, { merge: true });
  return count;
}
// ─────────────────────────────────────

const nameCache = new Map();
const shuffle   = arr => arr.slice().sort(() => Math.random() - 0.5);
function rawId(val) {
  const m = String(val).match(/\d{17,19}/);
  return m ? m[0] : val;
}

async function log(guild, text) {
  const logId = global.guildLogChannels?.get(guild.id);
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription(text)
    .setTimestamp();
  await ch.send({ embeds: [embed] }).catch(() => {});
}

async function getDisplayName(id, guild) {
  if (nameCache.has(id)) return nameCache.get(id);
  try {
    const member = await guild.members.fetch(id);
    nameCache.set(id, member.displayName);
    return member.displayName;
  } catch {
    try {
      const user = await guild.client.users.fetch(id);
      nameCache.set(id, user.username);
      return user.username;
    } catch {
      nameCache.set(id, id);
      return id;
    }
  }
}

async function getUserMMR(uid) {
  try {
    const snap = await db.collection('users').doc(uid).get();
    const data = snap.exists ? snap.data() : {};
    return typeof data.mmr === 'number' ? data.mmr : 0;
  } catch {
    return 0;
  }
}

async function getUserWL(uid) {
  try {
    const snap = await db.collection('users').doc(uid).get();
    const d    = snap.exists ? snap.data() : {};
    const w    = typeof d.wins   === 'number' ? d.wins   : 0;
    const l    = typeof d.losses === 'number' ? d.losses : 0;
    return { wins: w, losses: l };
  } catch {
    return { wins: 0, losses: 0 };
  }
}

function makePlayerButton(onClock, id, mmr) {
  const display = (nameCache.get(id) || id).slice(0, 20);
  return new ButtonBuilder()
    .setCustomId(`pick_${onClock}_${id}`)
    .setLabel(`${display} (${mmr})`)
    .setStyle(ButtonStyle.Secondary);
}

function makeCaptainButton(id, idx, mmr) {
  const colours = [ButtonStyle.Primary, ButtonStyle.Success, ButtonStyle.Danger];
  const display = (nameCache.get(id) || id).slice(0, 20);
  return new ButtonBuilder()
    .setCustomId(`vote_${id}`)
    .setLabel(`${display} (${mmr})`)
    .setEmoji('👑')
    .setStyle(colours[idx % colours.length]);
}

// ─────────────────────────────────────────────────────────────
//                      MAIN ENTRYPOINT
// ─────────────────────────────────────────────────────────────
async function startMatch(queueMessage, players) {
  // Bail out if the original queue channel has been deleted
  if (!queueMessage?.channel || queueMessage.channel.deleted) {
    console.warn('[match.js] queue channel no longer exists, skipping startMatch');
    return;
  }

  const matchNumber = await getNextMatchNumber();
  const matchName   = `match-${matchNumber}`;
  const guild       = queueMessage.guild;

  const channel = await guild.channels.create({
    name: matchName,
    type: ChannelType.GuildText,
    parent: CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
    ]
  });
  await log(guild, `🆕 Match channel created: **${channel.name}**`);

  global.activeMatches = global.activeMatches || new Map();
  global.activeMatches.set(channel.id, { channel, players });

  for (const p of players) {
    const id = rawId(p);
    if (!/^\d+$/.test(id)) continue;
    try {
      const member = await guild.members.fetch(id);
      await channel.permissionOverwrites.create(member, {
        ViewChannel:  true,
        SendMessages: true
      });
    } catch {}
  }

  await log(guild, '🔔 Starting captain vote');
  const [cap1, cap2] = await promptCaptainVote(channel, players);
  await log(guild, `🥳 Captains: <@${cap1}> & <@${cap2}>`);

  await log(guild, '🔔 Starting draft-type vote');
  const draftType = await promptDraftType(channel, [cap1, cap2]);
  await channel.send(
    `📋 Draft type chosen: **${draftType === 'snake' ? 'Snake Draft' : 'Straight Draft'}**`
  );
  await log(guild, `📋 Draft type: ${draftType}`);

  await log(guild, '🔔 Starting RPS for pick order');
  const [winner, loser] = await runRockPaperScissors(
    channel, [cap1, cap2], 'first pick'
  );
  await log(guild, `🤜🤛 RPS winner: <@${winner}> beat <@${loser}>`);

  await log(guild, `🔔 Starting draft (${draftType})`);
  const draftResult = await runDraft(
    channel, winner, loser, players, [cap1, cap2], draftType
  );
  if (!draftResult) {
    await log(guild, `🧹 Match cancelled during draft.`);
    return;
  }
  const { team1, team2 } = draftResult;
  await log(
    guild,
    `✅ Draft complete: Team 1 [${team1.map(id=>`<@${id}>`).join(', ')}] vs Team 2 [${team2.map(id=>`<@${id}>`).join(', ')}]`
  );

  try {
    await startPostDraft(channel, { team1, team2, winner, loser });
  } catch (err) {
    console.error('[match.js] startPostDraft failed:', err);
    await log(guild, `❌ Post-draft error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// promptCaptainVote
async function promptCaptainVote(channel, players) {
  const guild = channel.guild;
  const ids   = players.map(rawId);
  await Promise.all(ids.map(id => getDisplayName(id, guild)));

  // fetch MMRs
  const mmrs = {};
  await Promise.all(ids.map(async id => { mmrs[id] = await getUserMMR(id); }));

  let timeLeft = 20;
  const votes  = new Map();
  const base   = new EmbedBuilder()
    .setTitle('📢 Vote for Captains!')
    .setColor(0x00AE86)
    .setTimestamp();

  function buildEmbed() {
    const lines = ids.map((id, i) => {
      const ct = [...votes.values()].filter(v => v === id).length;
      return `${i+1}. <@${id}> **(${mmrs[id]})**` + (ct ? ` (${ct})` : '');
    });
    return base.setDescription(
      `Click one below. You get 1 vote.\nTime left: **${timeLeft}s**\n\n${lines.join('\n')}`
    );
  }

  const buttons = ids.map((id, i) => makeCaptainButton(id, i, mmrs[id]));
  const rows    = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i+5)));
  }

  const msg   = await channel.send({ embeds: [buildEmbed()], components: rows });
  const timer = setInterval(() => {
    timeLeft--;
    if (timeLeft >= 0) msg.edit({ embeds: [buildEmbed()] }).catch(() => {});
  }, 1000);

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 20_000
  });
  collector.on('collect', inter => {
    if (!votes.has(inter.user.id)) {
      votes.set(inter.user.id, inter.customId.split('_')[1]);
    }
    inter.deferUpdate().catch(() => {});
  });

  return new Promise(resolve => {
    collector.on('end', async () => {
      clearInterval(timer);
      msg.delete().catch(() => {});
      const tally = {};
      for (const v of votes.values()) tally[v] = (tally[v] || 0) + 1;

      let caps;
      if (!Object.keys(tally).length) {
        caps = shuffle(ids).slice(0,2);
      } else {
        const maxV = Math.max(...Object.values(tally));
        const top  = Object.entries(tally).filter(([,v]) => v===maxV).map(([k])=>k);
        if (top.length >= 2) {
          caps = shuffle(top).slice(0,2);
        } else {
          const first = top[0];
          const rest  = Object.entries(tally)
                       .filter(([k])=>k!==first)
                       .sort((a,b)=>b[1]-a[1])
                       .map(([k])=>k);
          const ties  = rest.filter(k=>tally[k]===tally[rest[0]]);
          caps = [
            first,
            ties.length ? shuffle(ties)[0] : shuffle(ids.filter(x=>x!==first))[0]
          ];
        }
      }

      await channel.send(`🥳 **Captains Selected!** <@${caps[0]}> & <@${caps[1]}>`);
      resolve(caps);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// promptDraftType
async function promptDraftType(channel, [cap1, cap2]) {
  let timeLeft = 20;
  const votes = new Map();
  const base = new EmbedBuilder()
    .setTitle('📋 Choose Draft Type')
    .setColor(0xFFA500)
    .setTimestamp();

  function buildEmbed() {
    const straightCount = [...votes.values()].filter(v => v === 'straight').length;
    const snakeCount    = [...votes.values()].filter(v => v === 'snake').length;
    return base.setDescription(
      `Both captains pick **Snake** or **Straight**.\n\n` +
      `✅ Straight: ${straightCount}    🐍 Snake: ${snakeCount}\n\n` +
      `Time left: **${timeLeft}s**`
    );
  }

  const btnSnake    = new ButtonBuilder().setCustomId('dt_snake').setLabel('Snake').setStyle(ButtonStyle.Primary);
  const btnStraight = new ButtonBuilder().setCustomId('dt_straight').setLabel('Straight').setStyle(ButtonStyle.Primary);
  const row         = new ActionRowBuilder().addComponents(btnSnake, btnStraight);

  const msg = await channel.send({ embeds: [buildEmbed()], components: [row] });

  const timer = setInterval(() => {
    timeLeft--;
    if (timeLeft >= 0) msg.edit({ embeds: [buildEmbed()] }).catch(() => {});
  }, 1000);

  const collector = msg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: i =>
      [cap1, cap2].includes(i.user.id) &&
      ['dt_snake', 'dt_straight'].includes(i.customId),
    max: 2,
    time: 20_000
  });

  collector.on('collect', async i => {
    if (!votes.has(i.user.id)) {
      votes.set(
        i.user.id,
        i.customId === 'dt_snake' ? 'snake' : 'straight'
      );
    }
    await i.deferUpdate();
  });

  return new Promise(resolve => {
    collector.on('end', async () => {
      clearInterval(timer);
      await msg.delete().catch(() => {});

      let choice;
      const vals = [...votes.values()];
      if (votes.size === 2) {
        if (vals[0] === vals[1]) {
          choice = vals[0];
        } else {
          const [rpsWinner] = await runRockPaperScissors(channel, [cap1, cap2], 'draft type');
          choice = votes.get(rpsWinner);
          await channel.send(
            `⚖️ Draft-type disagreement → RPS winner <@${rpsWinner}>'s pick: **${choice === 'snake' ? 'Snake Draft' : 'Straight Draft'}**`
          );
        }
      } else if (votes.size === 1) {
        choice = vals[0];
      } else {
        choice = 'straight';
        await channel.send(`⌛ No draft-type votes → defaulting to **Straight Draft**.`);
      }

      resolve(choice);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// runRockPaperScissors
async function runRockPaperScissors(channel, [cap1, cap2], purpose='this RPS') {
  const client = channel.client;
  const opts   = ['rock','paper','scissors'];

  await log(channel.guild, `🔔 Starting RPS for **${purpose}**`);

  async function pick(id) {
    if (!/^\d+$/.test(id)) return opts[Math.floor(Math.random()*opts.length)];
    const user = await client.users.fetch(id);
    const dm   = await user.createDM();
    const msg  = await dm.send({
      content: `🎲 Play Rock/Paper/Scissors for **${purpose}** in 15s`,
      components: [ new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rps_rock').setLabel('🪨 Rock').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('rps_paper').setLabel('📄 Paper').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('rps_scissors').setLabel('✂️ Scissors').setStyle(ButtonStyle.Primary)
      )]
    });
    setTimeout(()=>msg.delete().catch(()=>{}), 20000);

    try {
      const inter = await msg.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 15000,
        filter: i => i.user.id === id
      });
      await inter.reply({ content:'Choice recorded!', ephemeral:true });
      return inter.customId.split('_')[1];
    } catch {
      const auto = opts[Math.floor(Math.random()*opts.length)];
      await dm.send(`⏰ No pick → auto **${auto}**.`)
              .then(m=>setTimeout(()=>m.delete().catch(()=>{}),20000));
      return auto;
    }
  }

  let a, b;
  do {
    a = await pick(cap1);
    b = await pick(cap2);
    if (a === b) {
      await channel.send(`🤝 Both chose **${a}** — tie! Rerunning RPS.`);
    }
  } while (a === b);

  const wins = { rock:'scissors', paper:'rock', scissors:'paper' };
  const [winner, loser] = wins[a] === b ? [cap1, cap2] : [cap2, cap1];

  // announcement + outcome
  await channel.send(`🤜🤛 RPS (${purpose}): <@${cap1}> (${a}) vs (${b}) <@${cap2}> → 🏆 <@${winner}>`);
  await channel.send(`✅ <@${winner}> wins!  <@${loser}> loses.`);
  await log(channel.guild, `🏆 <@${winner}> won RPS for **${purpose}**`);

  // DMs
  try {
    const dm = await (await client.users.fetch(winner)).createDM();
    await dm.send(`🎉 You won the Rock/Paper/Scissors for **${purpose}**!`);
  } catch {}
  try {
    const dm = await (await client.users.fetch(loser)).createDM();
    await dm.send(`😞 You lost the Rock/Paper/Scissors for **${purpose}**.`);
  } catch {}

  return [winner, loser];
}

// ─────────────────────────────────────────────────────────────────────────────
// runDraft with manual countdown
async function runDraft(channel, winner, loser, players, captains, draftType) {
  const guild = channel.guild;

  // cleanup old vote/RPS messages
  const fetched = await channel.messages.fetch({ limit: 50 });
  const oldMsgs = fetched.filter(m =>
    m.author.id === channel.client.user.id &&
    m.components.some(r => r.components.some(c => /^vote_|^rps_|^pick_/.test(c.customId)))
  );
  if (oldMsgs.size) await channel.bulkDelete(oldMsgs).catch(() => {});

  // prepare
  const ids       = players.map(rawId);
  let remaining   = ids.filter(id => id !== winner && id !== loser);
  const team1     = [winner];
  const team2     = [loser];
  const draftLog  = [];
  let pickNum     = 1;
  let draftMsg;

  // fetch MMRs + W/L
  const mmrs  = {};
  const stats = {};
  await Promise.all(ids.map(async id => {
    mmrs[id]  = await getUserMMR(id);
    stats[id] = await getUserWL(id);
  }));

  // build steps
  let steps = [];
  if (draftType === 'straight') {
    for (let i = 0; i < remaining.length; i++) {
      steps.push({ cap: (i % 2 === 0 ? winner : loser) });
    }
  } else {
    function genSnake1211(w, l, n) {
      const order = [];
      let isB = true;
      for (let i = 0; i < n; ) {
        if (i === 0) {
          order.push(w);
          i++;
        } else {
          const p = isB ? l : w;
          order.push(p);
          i++;
          if (i < n) {
            order.push(p);
            i++;
          }
          isB = !isB;
        }
      }
      return order.slice(0, n);
    }
    const order = genSnake1211(winner, loser, remaining.length);
    steps = order.map(cap => ({ cap }));
  }

  await log(guild, `🔔 Draft begins (${draftType}), <@${winner}> picks first`);

  function remainingLines(list) {
    return list.map(id => {
      const { wins, losses } = stats[id];
      const total = wins + losses;
      const pct   = total ? Math.round(wins/total * 100) : 0;
      return `• <@${id}> (${pct}%)`;
    }).join('\n') || '—';
  }

  // manual countdown render
  async function render(onClock, deadline) {
    const t1mmr = team1.reduce((s, id) => s + (mmrs[id] || 0), 0);
    const t2mmr = team2.reduce((s, id) => s + (mmrs[id] || 0), 0);
    const emb = new EmbedBuilder().setColor(0xffa500);

    if (onClock) {
      const timeLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      emb
        .setTitle('✏️ Draft in progress')
        .setFooter({ text: `Pick ${pickNum}` })
        .addFields(
          { name: '⏱ Time left',     value: `**${timeLeft}s**`, inline: true },
          { name: '👑 On the clock',  value: `<@${onClock}>`,   inline: true }
        );
    } else {
      emb.setTitle('✅ Draft complete');
    }

    if (draftLog.length) {
      emb.addFields({ name:'📜 Draft Log', value:draftLog.join('\n'), inline:false });
    }

    if (remaining.length) {
      emb.addFields({
        name: `🎯 Remaining Players (${remaining.length})`,
        value: remainingLines(remaining),
        inline: false
      });
    }

    emb.addFields(
      {
        name: `🟥 Team 1 (MMR: ${t1mmr})`,
        value: team1.map(id=>`• <@${id}> (${mmrs[id]})`).join('\n') || '—',
        inline:true
      },
      {
        name: `🟦 Team 2 (MMR: ${t2mmr})`,
        value: team2.map(id=>`• <@${id}> (${mmrs[id]})`).join('\n') || '—',
        inline:true
      }
    );

    const rows = [];
    if (onClock) {
      const btns = remaining.map(id => makePlayerButton(onClock, id, mmrs[id]));
      for (let i = 0; i < btns.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i+5)));
      }
    }

    if (!draftMsg) {
      draftMsg = await channel.send({ embeds:[emb], components:rows });
    } else {
      await draftMsg.edit({ embeds:[emb], components:rows }).catch(() => {});
    }
  }

  // pick loop with 1s updates
  for (const { cap } of steps) {
    if (remaining.length === 1) {
      const last = remaining.shift();
      (cap === winner ? team1 : team2).push(last);
      draftLog.push(`Pick ${pickNum} — <@${last}> (auto)`);
      await log(guild, `⌛ Only one left—auto-picked <@${last}> for <@${cap}>`);
      pickNum++;
      break;
    }

    const deadline = Date.now() + 20000;
    await render(cap, deadline);
    const timer = setInterval(() => render(cap, deadline).catch(() => {}), 1000);

    let picked = false;
    while (!picked) {
      let inter;
      try {
        inter = await draftMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: deadline - Date.now(),
          filter: btn => btn.customId.startsWith('pick_')
        });
      } catch {
        inter = null;
      }
      clearInterval(timer);

      if (!inter) {
        const auto = remaining.shift();
        (cap === winner ? team1 : team2).push(auto);
        draftLog.push(`Pick ${pickNum} — <@${auto}> (auto)`);
        await log(guild, `⏰ <@${cap}> auto-picked <@${auto}>`);
        pickNum++;
        break;
      }

      const [, onClk, pickId] = inter.customId.split('_');
      if (inter.user.id !== onClk) {
        await inter.reply({ content:'You’re not on the clock!', ephemeral:true });
        continue;
      }
      await inter.deferUpdate();
      remaining = remaining.filter(x => x !== pickId);
      (cap === winner ? team1 : team2).push(pickId);
      draftLog.push(`Pick ${pickNum} — <@${pickId}>`);
      await log(guild, `✏️ <@${cap}> picked <@${pickId}>`);
      pickNum++;
      picked = true;
    }
  }

  await render(null);
  await log(
    guild,
    `✅ Draft complete: Team 1 [${team1.map(id=>`<@${id}>`).join(', ')}] vs Team 2 [${team2.map(id=>`<@${id}>`).join(', ')}]`
  );

  return { team1, team2 };
}

module.exports = { startMatch };
