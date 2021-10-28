const { wallet } = require('@vite/vitejs');
const QRcode = require('qrcode');

async function dmHandler(ctx, event) {
  if (!event.type == 'message_create') {
    return;
  }
  const msg = event.message_create.message_data.text.trim();
  const parsedMsg = msg.split(' ');
  const command = parsedMsg.find((x) => x.startsWith('!'));
  const senderId = event.message_create.sender_id;
  if (senderId == ctx.twitterOwner.id_str) {
    return;
  }
  const dm = {
    recipient_id: senderId ,
  };
  try {
    let address = await ctx.tipbotClient.getUserAddress(senderId, 'twitter');
    if (address == null) {
      // create one
      address = await ctx.tipbotClient.deriveAddress(senderId, 'twitter');
      await ctx.tipbotClient.addUser(senderId, 'twitter', address);
    } else {
      // workaround: sometimes can't receive createUnreceivedBlockSubscriptionByAddress event;
      await depositHandler(ctx, address);
    }
    let balanceStr, balance;

    switch (command) {
      case '!register':
      case '!deposit':
      case '!account':
        dm.text = `Your account address is:\n${address}`;
        const buffer = await new Promise((resolve, reject) => {
          QRcode.toBuffer(address, (error, buf) => {
            if(error) return reject(error)
            resolve(buf)
          })
        })
        const mediaId = await ctx.twitterClient.v1.uploadMedia(buffer, {
          type: 'png',
          target: 'dm',
        });
        dm.attachment = {
          type: "media",
          media: {
            id: mediaId
          }
        }
        break;

      case '!balance':
        ctx.logger.debug('!balance', address);
        balanceStr = await ctx.tipbotClient.getUserBalanceByAddress(address);
        ctx.logger.debug(balanceStr)
        dm.text = `${readableBalance(balanceStr)} VITE`;
        break;

      case '!withdraw':
        const idx = parsedMsg.findIndex(x => x == '!withdraw');
        let [amountStr, withdrawAddress] = parsedMsg.slice(idx+1, idx+3);
        let amount
        if (Number.isNaN(Number(amountStr))) {
          withdrawAddress = amountStr;
          amount = null;
        } else {
          amount = BigInt(amountStr) * BigInt(1e18);
        }
        ctx.logger.debug('!withdraw', amount.toString(), withdrawAddress);
        const addrType = wallet.isValidAddress(withdrawAddress);
        if (addrType != 1 || withdrawAddress == address) {
          dm.text = 'Please provide a valid address';
        } else {
          balanceStr = await ctx.tipbotClient.getUserBalanceByAddress(address);
          ctx.logger.debug('balance', balanceStr);
          balance = BigInt(balanceStr);
          if (amount == null) {
            amount = balance;
          }
          if (balance >= amount && amount > BigInt(0)) {
            const ret = await ctx.tipbotClient.withdrawByAddress(address, withdrawAddress, amount.toString());
            if (ret) {
              dm.text = `Withdraw successful. Hash:\n${ret.hash}`;
            }
          } else {
            dm.text = 'Your account address have not enough balance';
          }
        }
        break;

      case '!help':
        dm.text = [
          '!help: display help for command',
          '!register: register an account address',
          '!account: return the account address',
          '!balance: return the balance of your account address',
          '!withdraw: send the balance of your account to the provided address. Example: !withdraw <amount> <address>',
          '!tip: tips are sent through public tweets. Example: @star_vite !tip 5 @vitelabs',
        ].join('\n\n');
        break;

      default:
        dm.text = 'The command you sent is not recognized. Please send !help for a list of commands and what they do.'
    }
  } catch (e) {
    ctx.logger.error(e)
    // TODO
    dm.text = 'Something wrong, please contract us'
  }

  try {
    ctx.logger.info('sendDm %j', dm)
    await ctx.twitterClient.v1.sendDm(dm);
  } catch (e) {
    ctx.logger.error(e);
  }
}

async function tweetHandler(ctx, event) {
  const senderId = event.user.id_str;
  if (senderId == ctx.twitterOwner.id_str) {
    return;
  }
  const parsedMsg = event.text.trim().split(' ');
  const idx = parsedMsg.findIndex((x) => x.startsWith('!tip'));
  const amountStr = parsedMsg.find((x, i) => (i > idx && !Number.isNaN(Number(x))));
  const toUserName = parsedMsg.find((x, i) => (i > idx && x.startsWith('@')));
  if (!amountStr || !toUserName) {
    return;
  }
  const amount = BigInt(amountStr) * BigInt(1e18);
  const toUser = event.entities.user_mentions.find((x) => ( toUserName.startsWith(`@${x.screen_name}`)));

  try {
    let text;
    let balance;
    let fromAddress = await ctx.tipbotClient.getUserAddress(senderId, 'twitter');
    let toAddress = await ctx.tipbotClient.getUserAddress(toUser.id_str, 'twitter');
    if (fromAddress == null) {
      // create one
      fromAddress = await ctx.tipbotClient.deriveAddress(senderId, 'twitter');
      await ctx.tipbotClient.addUser(senderId, 'twitter', fromAddress);
      balance = BigInt(0);
    } else {
      // workaround: sometimes can't receive createUnreceivedBlockSubscriptionByAddress event;
      await depositHandler(ctx, fromAddress);
      const balanceStr = await ctx.tipbotClient.getUserBalanceByAddress(fromAddress);
      balance = BigInt(balanceStr);
    }
    if (toAddress == null) {
      // create one
      toAddress = await ctx.tipbotClient.deriveAddress(toUser.id_str, 'twitter');
      await ctx.tipbotClient.addUser(toUser.id_str, 'twitter', toAddress);
    }
    if (balance >= amount) {
      const ret = await ctx.tipbotClient.tip(fromAddress, toAddress, amount.toString());
      text = `You have successfully sent your ${amountStr} $VITE tip. Hash:\n${ret.hash}`
    } else {
      text = `You do not have enough VITE to cover this ${amountStr} VITE tip.  Please check your balance by sending a DM to me with !balance and retry.`
    }
    ctx.logger.info(`reply to the tweet(${event.id_str}): ${text}`);
    await ctx.twitterClient.v1.reply(text, event.id_str);
  } catch (e) {
    ctx.logger.error(e);
  }
}
async function depositHandler(ctx, address) {
  const balanceStr = await ctx.tipbotClient.getAddressBalance(address);
  ctx.logger.debug('depositHandler', address, balanceStr);
  if (BigInt(balanceStr) > 0n) {
    const account = await ctx.tipbotClient.getAccount(address);
    if (!account) {
      return
    }
    const ret = await ctx.tipbotClient.deposit(account, balanceStr);
    ctx.logger.debug('deposit %j', ret);
    if (ret) {
      ctx.tipbotClient.event.emit('notify', {
        type: 'deposit',
        address,
        balanceStr,
        hash: ret.hash,
      });
    }
  }
}

function readableBalance(balance) {
  return Number(BigInt(balance) / BigInt(1e10)) / 1e8;
}

module.exports = {
  dmHandler,
  tweetHandler,
  readableBalance,
}
