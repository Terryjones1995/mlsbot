// wagers.js
const adminFire = require('firebase-admin');
const { FieldValue } = adminFire.firestore;
const db            = adminFire.firestore();

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

// ─── Balance Helpers ───────────────────────────────────────────
async function getBalance(userId) {
  const snap = await db.collection('users').doc(userId).get();
  return snap.exists ? (snap.data().coins || 0) : 0;
}

async function setBalance(userId, amount) {
  await db.collection('users').doc(userId)
    .set({ coins: Math.max(0, amount) }, { merge: true });
}

async function addBalance(userId, amount) {
  if (!Number.isFinite(amount) || amount === 0) return;
  await db.collection('users').doc(userId)
    .update({ coins: FieldValue.increment(amount) })
    .catch(async err => {
      if (err.code === 5) {
        await setBalance(userId, Math.max(0, amount));
      } else throw err;
    });
}
// ───────────────────────────────────────────────────────────────

// ─── Transactional Wager Creation ─────────────────────────────
async function createWager(matchId, userId, amount) {
  if (!Number.isFinite(amount) || amount <= 0)
    return { ok:false, reason:'Invalid amount' };

  return await db.runTransaction(async txn => {
    const userRef  = db.collection('users').doc(userId);
    const wagerRef = db.collection('wagers').doc(matchId);

    const [uSnap, wSnap] = await Promise.all([
      txn.get(userRef),
      txn.get(wagerRef),
    ]);

    const bal = uSnap.exists ? (uSnap.data().coins||0) : 0;
    if (amount > bal) return { ok:false, reason:'Insufficient funds' };

    txn.update(userRef, { coins: FieldValue.increment(-amount) });

    const existing = wSnap.exists ? wSnap.data().wagers||[] : [];
    existing.push({ userId, amount });
    txn.set(wagerRef, { matchId, wagers:existing, accepted:false }, { merge:true });

    return { ok:true, newBalance:bal-amount };
  });
}

const acceptWager = createWager; // same debit+write logic

// ─── Execute Payout / Refund ──────────────────────────────────
async function finishWager(matchId, winnerIds=[], loserIds=[]) {
  const ref  = db.collection('wagers').doc(matchId);
  const snap = await ref.get();
  if (!snap.exists) return { total:0, participants:[] };

  const allW = snap.data().wagers||[];
  if (!allW.length) return { total:0, participants:[] };

  const wins = new Set(winnerIds), loses = new Set(loserIds);
  const wWin = allW.filter(w=> wins.has(w.userId));
  const wLose= allW.filter(w=> loses.has(w.userId));

  // only one side—refund
  if (!wWin.length || !wLose.length) {
    await db.runTransaction(async txn => {
      for (const w of allW) {
        txn.update(db.collection('users').doc(w.userId), {
          coins: FieldValue.increment(w.amount)
        });
      }
      txn.update(ref, { accepted:true, winner:null, payoutAmount:0, refunded:true });
    });
    return { total:0, participants:allW.map(w=>w.userId), refunded:true };
  }

  const loseTotal = wLose.reduce((s,w)=>s+w.amount,0);
  const share     = loseTotal / wWin.length;

  await db.runTransaction(async txn => {
    for (const w of wWin) {
      txn.update(db.collection('users').doc(w.userId), {
        coins: FieldValue.increment(w.amount + share)
      });
    }
    const payoutTotal = loseTotal + wWin.reduce((s,w)=>s+w.amount,0);
    txn.update(ref, {
      accepted:true,
      winner:winnerIds,
      payoutAmount:payoutTotal,
      refunded:false
    });
  });

  return {
    total: loseTotal + wWin.reduce((s,w)=>s+w.amount,0),
    participants: allW.map(w=>w.userId),
    eachWinnerGets: wWin.map(w=>({
      userId: w.userId,
      payout: w.amount + share
    })),
    refunded:false
  };
}
// ───────────────────────────────────────────────────────────────

// ─── Discord Interaction Handlers ────────────────────────────
async function handleWagerModal(inter, matchState) {
  const amt = Number(inter.fields.getTextInputValue('amount').trim());
  if (!Number.isFinite(amt) || amt <= 0)
    return inter.reply({ content:'⚠️ Enter a positive number.', ephemeral:true });

  const uid = inter.user.id;
  const res = await createWager(inter.channel.name, uid, amt);
  if (!res.ok)
    return inter.reply({ content:`⚠️ ${res.reason}`, ephemeral:true });

  const state = matchState.get(inter.channelId);
  state.potTotal += amt;
  await state.editLive();

  const embed = new EmbedBuilder()
    .setTitle('💰 New Wager')
    .setDescription(`<@${uid}> wagered **${amt}** coins.\n\n• ✅ Accept to match\n• ✖ Cancel`)
    .setColor(0xF8C300)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wager_accept_${uid}_${amt}`)
      .setLabel('✅ Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`wager_cancel_${uid}_${amt}`)
      .setLabel('✖ Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  await inter.channel.send({ embeds:[embed], components:[row] });
  return inter.reply({ content:`💰 Wager placed for **${amt}** coins.`, ephemeral:true });
}

async function handleWagerButton(inter, matchState) {
  const [ , action, owner, rawAmt ] = inter.customId.split('_');
  const amt = Number(rawAmt), uid = inter.user.id;
  const ref = db.collection('wagers').doc(inter.channel.name);
  const state = matchState.get(inter.channelId);

  await inter.deferUpdate();
  const disable = msg => {
    const rows = msg.components.map(r =>
      ActionRowBuilder.from(r).setComponents(
        r.components.map(c => ButtonBuilder.from(c).setDisabled(true))
      )
    );
    return msg.edit({ components:rows }).catch(()=>{});
  };

  if (action === 'cancel') {
    if (uid !== owner)
      return inter.followUp({ content:'❌ Only placer can cancel.', ephemeral:true });

    const snap  = await ref.get();
    const entry = (snap.data().wagers||[]).find(w=>w.userId===owner&&w.amount===amt);
    if (!entry) return inter.followUp({ content:'⚠️ Already handled.', ephemeral:true });

    await addBalance(owner, amt);
    await ref.update({ wagers: FieldValue.arrayRemove(entry) });
    state.potTotal -= amt;
    await state.editLive();
    await disable(inter.message);
    return inter.followUp({ content:`✖ Refunded ${amt} coins.`, ephemeral:true });
  }

  // accept
  if (action === 'accept') {
    if (uid === owner)
      return inter.followUp({ content:'❌ Can’t accept own wager.', ephemeral:true });

    const bal = await getBalance(uid);
    if (amt > bal)
      return inter.followUp({ content:`⚠️ You only have ${bal} coins.`, ephemeral:true });

    await createWager(inter.channel.name, uid, amt);
    state.potTotal += amt;
    await state.editLive();
    await disable(inter.message);

    const matched = new EmbedBuilder()
      .setTitle('💰 Wager Matched')
      .setDescription(`<@${uid}> matched **${amt}**. Pot is now **${state.potTotal}**.`)
      .setColor(0x00ff00)
      .setTimestamp();

    inter.channel.send({ embeds:[matched] }).catch(()=>{});
    return inter.followUp({ content:`✅ Matched ${amt} coins!`, ephemeral:true });
  }
}

module.exports = {
  getBalance,
  setBalance,
  addBalance,
  createWager,
  acceptWager,
  finishWager,
  handleWagerModal,
  handleWagerButton,
};
