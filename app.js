// load config first
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const util = require('util')
const buffer = require('buffer');
const crypto = require('crypto');
const { WS_RPC } = require('@vite/vitejs-ws');
const { ViteAPI, wallet } = require('@vite/vitejs');
const { TwitterApi } = require('twitter-api-v2');
const Koa = require('koa');
const Router = require('@koa/router');
const bodyParser = require('koa-bodyparser')
const {
  TipBotContractClient,
  setupLogger,
  readableBalance,
  dmHandler,
  tweetHandler,
} = require('./modules');

// create app
const app = new Koa();

// create logger
const logger = setupLogger(process.env);
app.context.logger = logger;

// create twitter client
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_CONSUMER_KEY,
  appSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
})
app.context.twitterClient = twitterClient;

// middleware
app.use(bodyParser());
app.use(async function (ctx, next) {
  const reqBody = ctx.request.rawBody || ""
  ctx.logger.info(`[ReqIn] [method=${ctx.method}] [URL=${ctx.url}] [headers=${JSON.stringify(ctx.request.headers)}] [body=${reqBody}]`);
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const resBody = ctx.response.body ? JSON.stringify(ctx.response.body) : ''
  ctx.logger.info(`[ResOut] [method=${ctx.method}] [URL=${ctx.url}] [headers=${JSON.stringify(ctx.response.headers)}] [body=${resBody}] - ${ms}ms`);
});

// create router
const router = new Router();
// define routers
router.get('/', (ctx, next) => {
  ctx.body = 'Hello World';
});

/*
 * TODO verify twitter webhook request ip in prod
 * Twitter aggregate network blocks
 * For added security you may wish to add the following aggregate network blocks to an allowlist:
 * 199.59.148.0/22
 * 199.16.156.0/22
 * 192.133.77.0/26
 */

// receives chanllage response check
router.get('/webhook/twitter', (ctx, next) => {
  const crc_token = ctx.request.query.crc_token;
  if (crc_token) {
    const hmac = crypto.createHmac('sha256', process.env.TWITTER_CONSUMER_SECRET).update(crc_token).digest();
    const hash = Buffer.from(hmac).toString('base64');
    ctx.body = {"response_token": `sha256=${hash}`}
  } else {
    ctx.throw(400, 'Error: crc_token missing from request.')
  }
})
// receives Account Acitivity events
// TODO events may be sent repeatedly, add redis
router.post('/webhook/twitter', async(ctx, next) => {
  const sig = ctx.request.headers['x-twitter-webhooks-signature'];
  if (typeof sig == 'undefined' || typeof ctx.request.rawBody != 'string') {
    ctx.logger.info(`auth header not provided, probable malicious access attempt from ${JSON.stringify(ctx.request.headers)}`)
    ctx.body = 'Hello World';
    return;
  }
  const hmac = crypto.createHmac('sha256', process.env.TWITTER_CONSUMER_SECRET).update(ctx.request.rawBody).digest();
  const digest = Buffer.from(`sha256=${Buffer.from(hmac).toString('base64')}`);
  const checksum = Buffer.from(sig);
  if (checksum.length !== digest.length || !crypto.timingSafeEqual(digest, checksum)) {
    ctx.logger.info(`twitter webhooks signature invalid, probable malicious access attempt from ${JSON.stringify(ctx.request.headers)}`)
    ctx.body = 'Hello World';
    return;
  }
  const data = ctx.request.body

  for (const [key, value] of Object.entries(data)) {
    ctx.logger.debug(`${key}: %j`, value);
    const event = value[0];
    switch (key) {
      case 'direct_message_events':
        await dmHandler(ctx, event);
        break;
      case 'tweet_create_events':
        await tweetHandler(ctx, event);
        break;
    }
  }
  ctx.body = 'hello twitter';
})


app.use(router.routes());
app.use(router.allowedMethods());

(async () => {
  try {
    // create vite client
    let abi, platformMap;
    try {
      abi = JSON.parse(process.env.CONTRACT_ABI);
      platformMap = JSON.parse(process.env.CONTRACT_PLATFORM_MAP);
    } catch (e) {
      console.log(e)
      process.exit(1)
    }
    const viteNode = process.env.VITE_NODE
    const connection = new WS_RPC(viteNode);
    const provider = new ViteAPI(connection, async() => {
      logger.info(`vite node(${viteNode}) connected`);
      // create tipbot client
      const contractAddr = process.env.CONTRACT_ADDRESS;
      const tipbotClient = new TipBotContractClient({
        provider,
        logger,
        abi,
        address: contractAddr,
        code: process.env.CONTRACT_CODE,
        offChainCode: process.env.CONTRACT_OFFCHAIN_CODE,
        walletDir: process.env.WALLET_DIR,
        platformMap,
      })
      app.context.tipbotClient = tipbotClient;
      // set owner
      await tipbotClient.setOwner(process.env.CONTRACT_OWNER_MNEMONICS);
      // subscribe log event
      await tipbotClient.subscribeLogEvent(contractAddr, 'ResultEvent');
      // subscribe addressList event
      await tipbotClient.subscribeAddressListEvent();
      // subscribe notify
      logger.info('subscribe notify event');
      tipbotClient.event.on('notify', async (event) => {
        logger.info('notify %j', event);
        if (event.type == 'deposit') {
          const userId = await tipbotClient.getUserId(event.address);
          const prefix = await tipbotClient.getPrefixByAddress(event.address);
          const [platform, _] = Object.entries(platformMap).find(x => x[1] == prefix);
          logger.debug(userId, prefix, platform);
          if ( platform == 'twitter' ) {
            const dm = {
              recipient_id: userId ,
              text: `Your account address received a deposit of ${readableBalance(event.balance)} VITE.\nHash: ${event.hash}`,
            };
            try {
              logger.info('sendDm %j', dm)
              await twitterClient.v1.sendDm(dm);
            } catch (e) {
              logger.error(e);
            }
          }
        }
      })
    })
    // verify credentials
    const currentUser = await twitterClient.v1.verifyCredentials();
    logger.info('twitter access token verification passed')
    app.context.twitterClient = twitterClient;
    app.context.twitterOwner = currentUser;
  } catch (err) {
    console.log(err)
    process.exit(1)
  }
  app.listen(process.env.PORT || '8000');
})()
