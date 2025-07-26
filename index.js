/**
 * index.js — NeatQueue-lite with post-draft flow in one file
 *  • Queueing, match delegation, admin commands, leaderboards
 *  • Post-draft actions delegated to postDraft.js (voice channels, map voting/choosing, wagers, MMR updates)
 *  • /addmoney command logic
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  PermissionsBitField,
  ComponentType,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder
} = require('discord.js');
require('dotenv').config();

// ─────────── FIREBASE ADMIN + MMR SETUP ───────────
const firebaseAdmin  = require('firebase-admin');
const serviceAccount = require('');
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount),
});
const db = firebaseAdmin.firestore();

// ─── External modules ──────────────────────────────
const fs      = require('fs');
const path    = require('path');
const wagers  = require('./wagers');
const rewards = require('./rewards');
const admin   = require('./admin.js');
const {
  pickFromPool,
  buildPoolVoteEmbed,
  BUTTON_POPULAR,
  BUTTON_RANDOM
} = require('./map.js');

// ─── Delegate all post-draft logic here ────────────
const {
  startPostDraft,
  matchState,
  initPostDraftModalHandler
} = require('./postDraft');

// ─── Also import match.js for full-queue auto-match ─
const match = require('./match');

// ─── Top-level constants ───────────────────────────
global.activeUsers = new Set();

const CAPTAIN_VOTES_REQUIRED        = 2;
const REPORT_CAPTAIN_VOTES_REQUIRED = 2;
const PLAYER_VOTES_REQUIRED         = 5;

const TOKEN       = process.env.DISCORD_TOKEN;
const CLIENT_ID   = process.env.CLIENT_ID;
const GUILD_ID    = '';
const CATEGORY_ID = '';

const ICON_URL = 'https://i.imgur.com/YourLogo.png';
const SOCIALS  = [
  '**YouTube:** [MajorLeagueSniping](https://www.youtube.com/MajorLeagueSniping)',
  '**Twitter:** [@MLSniingOG](https://twitter.com/MLSniingOG)',
  '**Twitch:** [MajorLeagueSniping](https://twitch.tv/MajorLeagueSniping)',
  '**TikTok:** [@MajorLeagueSniping](https://tiktok.com/@MajorLeagueSniping)',
  '**Discord:** [Join Us](https://discord.gg/MLSniping)'
].join('\n');

// ─── helper to write into your log channel ───────────
async function logToChannel(guild, content, file) {
  const logId = global.guildLogChannels?.get(guild.id);
  if (!logId) return;
  const ch = await guild.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const opts = { content };
  if (file) opts.files = [file];
  await ch.send(opts).catch(() => {});
}

// ─── /addmoney command execution ─────────────────────
async function handleAddMoney(interaction) {
  const amount = interaction.options.getInteger('amount');
  await interaction.reply({ content:`✅ Request for ${amount} coins sent.`, ephemeral: true });
  const guild = interaction.guild;
  let adminsList = [...guild.roles.cache
    .filter(r => r.permissions.has(PermissionsBitField.Flags.ManageChannels))
    .flatMap(r => [...r.members.values()])
  ];
  if (!adminsList.length) {
    try { adminsList = [ await guild.fetchOwner() ]; } catch {}
  }
  for (const adm of adminsList) {
    adm.send(`💰 AddMoney: <@${interaction.user.id}> → ${amount}`).catch(()=>{});
  }
  const logId = global.guildLogChannels.get(guild.id);
  if (logId) {
    const ch = await interaction.client.channels.fetch(logId).catch(()=>null);
    if (ch?.isTextBased()) ch.send(`💰 /addmoney <@${interaction.user.id}> → ${amount}`);
  }
}

// ─── Register slash commands ─────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('setqueuechannel')
    .setDescription('Select the channel where queues will run')
    .addChannelOption(opt =>
      opt.setName('channel')
         .setDescription('Queue channel')
         .setRequired(true)
    ).toJSON(),

  new SlashCommandBuilder()
    .setName('setlogchannel')
    .setDescription('Select the channel for join/leave & match logs')
    .addChannelOption(opt =>
      opt.setName('channel')
         .setDescription('Log channel')
         .setRequired(true)
    ).toJSON(),

  new SlashCommandBuilder()
    .setName('startqueue')
    .setDescription('Start the 8-slot queue (pre-populated)')
    .toJSON(),

  // admin commands from admin.js
  ...admin.data.map(cmd => cmd.toJSON()),

  new SlashCommandBuilder().setName('leaderboard').setDescription('DM you the full leaderboard').toJSON(),
  new SlashCommandBuilder().setName('balance').setDescription('Check your coin balance').toJSON(),
  new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send coins to another user')
    .addUserOption(opt =>
      opt.setName('user')
         .setDescription('User to send coins to')
         .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('amount')
         .setDescription('Amount of coins to send')
         .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder().setName('withdraw').setDescription('Request a withdrawal of your balance (admin will DM)').toJSON(),
  new SlashCommandBuilder()
    .setName('addmoney')
    .setDescription('Request to add coins to your account')
    .addIntegerOption(opt =>
      opt.setName('amount')
         .setDescription('Number of coins to request')
         .setRequired(true)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

const client = new Client({ intents: [ GatewayIntentBits.Guilds ] });
global.client = client;

const guildSettings         = new Map(); // guildId → queueChannelId
const guildLogChannels      = new Map(); // guildId → logChannelId
const guildQueues           = new Map(); // guildId → { currentQueue, queueMessage, interval }
const guildLeaderboardChans = new Map();

initPostDraftModalHandler(client);

global.guildSettings         = guildSettings;
global.guildLogChannels      = guildLogChannels;
global.guildQueues           = guildQueues;
global.guildLeaderboardChans = guildLeaderboardChans;

// ─── Utility: safe reply/followUp ─────────────────────
async function safeReply(inter, opts) {
  if (inter.replied || inter.deferred) {
    try { return await inter.followUp({ ...opts, ephemeral: true }); }
    catch {}
  } else {
    try { return await inter.reply(opts); }
    catch {}
  }
}

// ─── announce to log channel ─────────────────────────
async function announceLog(guildId, text) {
  const logId = guildLogChannels.get(guildId);
  if (!logId) return;
  const ch = await client.channels.fetch(logId).catch(() => null);
  if (ch?.isTextBased()) ch.send(text).catch(() => {});
}

// ─── embed-style action logger ───────────────────────
async function actionLog(guildId, user, text, color = 0x00AE86) {
  const logId = guildLogChannels.get(guildId);
  if (!logId) return;
  const ch = await client.channels.fetch(logId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const emb = new EmbedBuilder()
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
    .setColor(color)
    .setDescription(text)
    .setTimestamp();
  ch.send({ embeds: [emb] }).catch(() => {});
}

// ─── ensureCoreChannels: create queue, logs & bot-info ───
async function ensureCoreChannels(guild) {
  const category = guild.channels.cache.get(CATEGORY_ID);
  if (!category) {
    console.error('Category ID not found.');
    return;
  }

  // 1) mw2-8s queue channel
  let queueCh = guild.channels.cache.find(ch =>
    ch.name === 'mw2-8s' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!queueCh) {
    queueCh = await guild.channels.create({
      name: 'mw2-8s',
      type: ChannelType.GuildText,
      parent: category
    });
  }
  guildSettings.set(guild.id, queueCh.id);

  // 2) mw2-8s-logs (private)
  let logCh = guild.channels.cache.find(ch =>
    ch.name === 'mw2-8s-logs' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!logCh) {
    logCh = await guild.channels.create({
      name: 'mw2-8s-logs',
      type: ChannelType.GuildText,
      parent: category,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });
  }
  guildLogChannels.set(guild.id, logCh.id);

  // 3) bot-info
  let botInfo = guild.channels.cache.find(ch =>
    ch.name === 'bot-info' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!botInfo) {
    botInfo = await guild.channels.create({
      name: 'bot-info',
      type: ChannelType.GuildText,
      parent: category,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionsBitField.Flags.ViewChannel],
          deny:  [PermissionsBitField.Flags.SendMessages]
        }
      ]
    });
  } else {
    await botInfo.permissionOverwrites.set([{
      id: guild.roles.everyone.id,
      allow: [PermissionsBitField.Flags.ViewChannel],
      deny:  [PermissionsBitField.Flags.SendMessages]
    }]);
  }

  await botInfo.bulkDelete(100).catch(() => {});
  await botInfo.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('🤖 Bot Info & Commands')
        .setColor(0x5865F2)
        .setDescription([
          '**Slash Commands:**',
          '• `/setqueuechannel [#channel]` — set the queue channel',
          '• `/setlogchannel [#channel]` — set the log channel',
          '• `/startqueue` — manually launch the 8‑slot queue',
          '• `/endqueue` — terminate a match (admin only)',
          '• `/resetleaderboard start` — generate confirmation code to reset leaderboard',
          '• `/resetleaderboard confirm code:<code>` — confirm & reset leaderboard',
          '• `/mmr add @user <amt>` — add MMR to a user',
          '• `/mmr remove @user <amt>` — remove MMR from a user',
          '• `/wins add @user <amt>` — add wins to a user',
          '• `/wins remove @user <amt>` — remove losses from a user',
          '• `/adjustbalance add|remove @user <amt>` — (admin) adjust virtual currency',
          '• `/leaderboard` — DM you the full leaderboard',
          '',
          '**Map Voting & Vetoes:**',
          '- After draft, captains & players vote on 🔀 Random vs ✅ Popular pools.',
          '- Once captains or **5** players vote, pool unlocks and style button appears.',
          '- Bot bumps an embed with the chosen map, shows thumbnail if available.',
          '- Captains can veto (🗺️) up to **2** maps total; veto triggers instant repick.',
          '',
          '**MMR & Leaderboard:**',
          '- Uses Elo‑style on team‑average MMR: underdogs gain more, favorites less.',
          '- K‑factor dynamically adjusts by win/loss streak (hot & cold multipliers).',
          '- Records per‑user: MMR, total wins/losses, current streak, last‑10 W/L history.',
          '- Tie or chalked matches do not change MMR.',
          '',
          '**Coin & Wager System:**',
          '• `/balance` — Check your coin balance.',
          '• `/send @user <amount>` — Send coins to another user.',
          '• `/withdraw` — Request a withdrawal (admin notified).',
          '• `/addmoney <amount>` — Request to add coins to your account.',
          '',
          '**How Match Wagers Work:**',
          '- Place a wager during post‑draft with the “💰 Wager” button (opens modal).',
          '- Opposing team members can match your bet 1:1; unmatched wagers are refunded.',
          '- Winners split the opposing pool; losers forfeit their wager.',
          '- Use `/balance` at any time to verify your coins.'
        ].join('\n'))
    ]
  });

  // 4) leaderboards channel
  let lbCh = guild.channels.cache.find(ch =>
    ch.name === 'leaderboards' &&
    ch.parentId === CATEGORY_ID &&
    ch.type === ChannelType.GuildText
  );
  if (!lbCh) {
    lbCh = await guild.channels.create({
      name: 'leaderboards',
      type: ChannelType.GuildText,
      parent: category
    });
  }
  const perms = [
    {
      id: guild.roles.everyone.id,
      allow: [PermissionsBitField.Flags.ViewChannel],
      deny:  [PermissionsBitField.Flags.SendMessages]
    },
    {
      id: client.user.id,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
    }
  ];
  guild.roles.cache
    .filter(r => r.permissions.has(PermissionsBitField.Flags.ManageChannels))
    .forEach(r => {
      perms.push({
        id: r.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
      });
    });
  await lbCh.permissionOverwrites.set(perms);
  guildLeaderboardChans.set(guild.id, lbCh.id);
}

// ─── Leaderboard fetch ──────────────────────────────
async function getLeaderboardRecords(limit = 10) {
  const snap = await db
    .collection('users')
    .orderBy('mmr', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((doc, idx) => {
    const d = doc.data();
    return {
      rank:   idx + 1,
      id:     doc.id,
      wins:   typeof d.wins   === 'number' ? d.wins   : 0,
      losses: typeof d.losses === 'number' ? d.losses : 0,
      streak: typeof d.streak  === 'number' ? d.streak : 0,
      mmr:    typeof d.mmr     === 'number' ? d.mmr    : 1000
    };
  });
}

// ─── Post & update leaderboard ──────────────────────
async function updateLeaderboard(guildId) {
  const lbId = guildLeaderboardChans.get(guildId);
  if (!lbId) return;
  const channel = await client.channels.fetch(lbId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const records = await getLeaderboardRecords(200);
  const nameMap = new Map();
  for (const r of records) {
    try {
      const m = await channel.guild.members.fetch(r.id);
      nameMap.set(r.id, m.displayName);
    } catch {
      nameMap.set(r.id, 'Unknown');
    }
  }

  const rankW   = Math.max(...records.map(r => String(r.rank).length), 1);
  const playerW = Math.max('Player'.length, ...records.map(r => nameMap.get(r.id).length));
  const wlW     = Math.max(...records.map(r => `${r.wins}-${r.losses}`.length), 'W/L'.length);
  const strkW   = Math.max(...records.map(r => String(r.streak).length), 'STRK'.length);
  const mmrW    = Math.max(...records.map(r => String(r.mmr).length), 'MMR'.length);
  const sep     = '  ';

  const pad = (s, w, right = false) => {
    s = String(s);
    return right ? s.padEnd(w, ' ') : s.padStart(w, ' ');
  };

  const header = [
    pad('#', rankW, true),
    pad('Player', playerW, true),
    pad('W/L', wlW, true),
    pad('STRK', strkW, true),
    pad('MMR', mmrW, true)
  ].join(sep);

  const divider = [
    '-'.repeat(rankW),
    '-'.repeat(playerW),
    '-'.repeat(wlW),
    '-'.repeat(strkW),
    '-'.repeat(mmrW)
  ].join(sep);

  const rows = records.map(r =>
    [
      pad(r.rank, rankW, true),
      pad(nameMap.get(r.id), playerW, true),
      pad(`${r.wins}-${r.losses}`, wlW, true),
      pad(r.streak, strkW, true),
      pad(r.mmr, mmrW, true)
    ].join(sep)
  );

  const table = ['```ansi', header, divider, ...rows, '```'].join('\n');

  const last = (await channel.messages.fetch({ limit: 5 }))
                 .filter(m => m.author.id === client.user.id)
                 .first();

  const embed = new EmbedBuilder()
    .setTitle('🏅 Official Leaderboards')
    .setColor(0xFFD700)
    .setDescription(table)
    .setTimestamp();

  if (last) {
    await last.edit({ embeds: [embed] })
      .catch(() => channel.send({ embeds: [embed] }));
  } else {
    await channel.send({ embeds: [embed] });
  }
}

// ─── Start queue in channel ─────────────────────────
async function startQueueInChannel(guildId) {
  if (guildQueues.has(guildId)) return;

  const queueCh = guildSettings.get(guildId);
  if (!queueCh) return;
  const ch = await client.channels.fetch(queueCh).catch(() => null);
  if (!ch?.isTextBased()) return;

  // start with an empty queue for real users
  const initial = [];
  const lines   = Array.from({ length: 8 }, (_, i) =>
    `${i + 1}. ${initial[i] || 'Open'}`
  );
  const count   = initial.length;

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Major League Sniping™', iconURL: ICON_URL })
    .setColor(0xff0000)
    .setDescription(['8’s Queue', '', `Queue ${count}/8`, ...lines].join('\n'))
    .addFields({ name: 'Socials', value: SOCIALS })
    .setTimestamp();

  const lbId   = guildLeaderboardChans.get(guildId);
  const lbLink = lbId
    ? `https://discord.com/channels/${guildId}/${lbId}`
    : `https://discord.com/channels/@me`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join').setLabel('Join Queue').setStyle(ButtonStyle.Primary).setDisabled(false),
    new ButtonBuilder().setCustomId('leave').setLabel('Leave Queue').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setLabel('Leaderboard').setStyle(ButtonStyle.Link).setURL(lbLink)
  );

  const msg = await ch.send({ embeds: [embed], components: [row] });

  const interval = setInterval(() => updateQueueMessage(guildId), 60_000);
  guildQueues.set(guildId, { currentQueue: initial, queueMessage: msg, interval });

  await actionLog(guildId, client.user, `🚀 Queue started in <#${queueCh}>`);
}

// ─── Update queue UI & auto-launch match when full ─────
async function updateQueueMessage(guildId) {
  const data = guildQueues.get(guildId);
  if (!data) return;

  const { currentQueue: q, queueMessage: oldMsg, interval } = data;
  const count = q.length;

  const lines = Array.from({ length: 8 }, (_, i) =>
    `${i + 1}. ${q[i] || 'Open'}`
  );
  let seconds = 60;
  const description = count < 8
    ? ['8’s Queue', '', `Queue ${count}/8`, ...lines].join('\n')
    : [
        '8’s Queue — **FULL!**',
        '',
        'Queue 8/8',
        ...lines,
        '',
        `**Next queue starts in ${seconds}s**`
      ].join('\n');

  const embed = EmbedBuilder
    .from(oldMsg.embeds[0])
    .setDescription(description)
    .setTimestamp();

  const lbId   = guildLeaderboardChans.get(guildId);
  const lbLink = lbId
    ? `https://discord.com/channels/${guildId}/${lbId}`
    : `https://discord.com/channels/@me`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('join')
      .setLabel('Join Queue')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(count >= 8),
    new ButtonBuilder()
      .setCustomId('leave')
      .setLabel('Leave Queue')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(count === 0),
    new ButtonBuilder()
      .setLabel('Leaderboard')
      .setStyle(ButtonStyle.Link)
      .setURL(lbLink)
  );

  await oldMsg.edit({
    embeds:    [embed],
    components:[row]
  });

  if (count < 8) return;

  clearInterval(interval);

  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('join')
      .setLabel('Join Queue')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('leave')
      .setLabel('Leave Queue')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setLabel('Leaderboard')
      .setStyle(ButtonStyle.Link)
      .setURL(lbLink)
  );

  const tick = setInterval(async () => {
    seconds--;

    const bump = EmbedBuilder
      .from(embed)
      .setDescription([
        '8’s Queue — **FULL!**',
        '',
        'Queue 8/8',
        ...lines,
        '',
        `**Next queue starts in ${seconds}s**`
      ].join('\n'));

    await oldMsg.edit({ embeds: [bump], components: [disabledRow] }).catch(() => {});

    if (seconds <= 0) {
      clearInterval(tick);
      await oldMsg.delete().catch(() => {});
      guildQueues.delete(guildId);
      startQueueInChannel(guildId);
    }
  }, 1000);

  data.countdown = tick;

  try {
    await match.startMatch(oldMsg, q);
  } catch (err) {
    console.error('[updateQueueMessage] match.startMatch error:', err);
  }
}

// ─── Interaction handling ───────────────────────────
client.on(Events.InteractionCreate, async inter => {
  if (!inter.guild) return;
  const gid = inter.guildId;

  // ── Slash commands ─────────────────────────────────
  if (inter.isChatInputCommand()) {
    switch (inter.commandName) {
      case 'balance': {
        const bal = await wagers.getBalance(inter.user.id);
        return safeReply(inter, { content: `Your balance: **${bal} coins**.`, ephemeral: true });
      }
      case 'send': {
        const user   = inter.options.getUser('user');
        const amount = inter.options.getInteger('amount');
        if (!user || amount <= 0) return safeReply(inter, { content:'Invalid user or amount.', ephemeral: true });
        if (user.id === inter.user.id)  return safeReply(inter, { content:'You can’t send coins to yourself.', ephemeral: true });
        const bal = await wagers.getBalance(inter.user.id);
        if (bal < amount) return safeReply(inter, { content:`Insufficient funds. You have ${bal} coins.`, ephemeral: true });
        await wagers.addBalance(inter.user.id, -amount);
        await wagers.addBalance(user.id, amount);
        await safeReply(inter, { content:`Sent **${amount} coins** to <@${user.id}>.`, ephemeral: true });
        try { await user.send(`You received **${amount} coins** from <@${inter.user.id}> in ${inter.guild.name}.`); } catch {}
        return;
      }
      case 'withdraw': {
        await safeReply(inter, { content:`Withdrawal request sent to admins.`, ephemeral: true });
        const admins = inter.guild.members.cache.filter(m =>
          m.permissions.has(PermissionsBitField.Flags.ManageChannels)
        );
        admins.forEach(a => a.send(`User <@${inter.user.id}> requested a withdrawal in ${inter.guild.name}.`).catch(()=>{}));
        return;
      }
      case 'addmoney': {
        return handleAddMoney(inter);
      }
    }

    // ── Admin slash commands ───────────────────────────
    const adminCmds = [
      'setqueuechannel','setlogchannel','startqueue','endqueue',
      'resetleaderboard','mmr','wins','losses','adjustbalance'
    ];
    if (adminCmds.includes(inter.commandName)) {
      if (!inter.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return safeReply(inter, { content:'You don’t have permission.', ephemeral: true });
      }
      return admin.execute(inter);
    }

    if (inter.commandName === 'leaderboard') {
      const recs = await getLeaderboardRecords(10);
      return inter.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🏅 Official Leaderboards')
            .setColor(0xFFD700)
            .addFields(
              { name:'#',      value: recs.map(r=>`${r.rank}`).join('\n'), inline:true },
              { name:'Player', value: recs.map(r=>`<@${r.id}>`).join('\n'), inline:true },
              { name:'W/L',    value: recs.map(r=>`${r.wins}-${r.losses}`).join('\n'), inline:true },
              { name:'STRK',   value: recs.map(r=>`${r.streak}`).join('\n'), inline:true },
              { name:'MMR',    value: recs.map(r=>`${r.mmr}`).join('\n'), inline:true }
            )
            .setTimestamp()
        ],
        ephemeral: true
      });
    }

    return;
  }

  // ── Join / Leave buttons ───────────────────────────
  if (inter.isButton() && ['join','leave'].includes(inter.customId)) {
    const data = guildQueues.get(gid);
    if (!data || inter.message.id !== data.queueMessage.id) {
      return safeReply(inter, { content:'No active queue.', ephemeral: true });
    }
    const q   = data.currentQueue;
    const uid = inter.user.id;
    const tag = `<@${uid}>`;

    if (inter.customId === 'join') {
      if (global.activeUsers.has(uid)) {
        return safeReply(inter, { content:'Already in a queue/match.', ephemeral: true });
      }
      if (q.includes(tag)) {
        return safeReply(inter, { content:'Already in this queue.', ephemeral: true });
      }
      if (q.length >= 8) {
        return safeReply(inter, { content:'Queue full.', ephemeral: true });
      }
      q.push(tag);
      global.activeUsers.add(uid);
      inter.deferUpdate().catch(()=>{});
      announceLog(gid, `${tag} joined the queue.`);
      await actionLog(gid, inter.user, `👥 ${tag} joined the queue.`);
      return updateQueueMessage(gid);
    }

    if (inter.customId === 'leave') {
      if (!q.includes(tag)) {
        return safeReply(inter, { content:'Not in this queue.', ephemeral: true });
      }
      data.currentQueue = q.filter(u => u !== tag);
      global.activeUsers.delete(uid);
      inter.deferUpdate().catch(()=>{});
      announceLog(gid, `${tag} left the queue.`);
      await actionLog(gid, inter.user, `❌ ${tag} left the queue.`);
      return updateQueueMessage(gid);
    }
  }

  // ── Admin component menus ───────────────────────────
  if (inter.isStringSelectMenu()) {
    return admin.handleComponent(inter);
  }
});

// ─── Client Ready ─────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  await ensureCoreChannels(guild);

  if (guildSettings.has(guild.id) && !guildQueues.has(guild.id)) {
    await startQueueInChannel(guild.id);
    console.log(`Auto-started queue in <#${guildSettings.get(guild.id)}>`);  
  }

  await updateLeaderboard(guild.id);
  setInterval(() => updateLeaderboard(guild.id), 60_000);
});

// ─── Login ─────────────────────────────────────────────
client.login(TOKEN);
