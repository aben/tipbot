const fs = require('fs');
const path = require('path')
const util = require('util')
const { once, EventEmitter } = require('events');
const { ViteAPI, wallet, utils, abi, accountBlock, keystore } = require('@vite/vitejs');

const writeFile = util.promisify(fs.writeFile)
const readFile = util.promisify(fs.readFile)

const VITE_TOKENID = "tti_5649544520544f4b454e6e40";
const EMPTY_ADDRESS="vite_0000000000000000000000000000000000000000a4f3a0cb58"

class TipBotContractClient {
  constructor({provider, address, abi, code, offChainCode, logger, walletDir, platformMap}) {
    this.provider = provider;
    this.address = address;
    this.abi = abi;
    this.code = code;
    this.offChainCode = offChainCode;
    this.logger = logger;
    this.owner = null;
    this.walletDir = walletDir;
    this.platformMap = platformMap;
    this.step = 1000;
    this.addressList = [];
    this.subMap = {};

    const addrType = wallet.isValidAddress(address);
    if (addrType != 2) {
      throw new Error(`${address} is not a contract address and type is ${addrType}`)
    }
    this.event = new EventEmitter();
  }

  getAbi(methodName) {
    for (let i = 0; i < this.abi.length; i++) {
      const abi = this.abi[i]
      if (abi.name === methodName) {
        return abi
      }
    }
  }

  async setOwner(mnemonics) {
    if (this.owner != null) {
      return
    }
    const [ownerAddr] = await this.provider.callOffChainContract({
      address: this.address,
      abi: this.getAbi('getOwner'),
      code: Buffer.from(this.offChainCode, 'hex').toString('base64'),
    })
    this.logger.info('getOwner', ownerAddr);
    const addressList = wallet.deriveAddressList({ 
      mnemonics: mnemonics, 
      startIndex: 0,
      endIndex: 9
    });
    for (let i = 0, len = addressList.length; i < len; i++) {
      if (ownerAddr == addressList[i].address) {
        this.owner = addressList[i];
        break;
      }
    }
    return this.owner;
  }

  async PoW(ab) {
    await ab.autoSetPreviousAccountBlock();
    const quota = await this.provider.request("contract_getQuotaByAccount", ab.address);
    this.logger.debug('quota %j', quota);

  // Get difficulty
  // TODO calc PoW twice referring to one snapshot block
    const pow = await this.provider.request('ledger_getPoWDifficulty', {
      address: ab.address,
      previousHash: ab.previousHash,
      blockType: ab.blockType,
      toAddress: ab.toAddress,
      data: ab.data
    });
    this.logger.debug('pow', ab.previousHash, pow);
    const { requiredQuota, difficulty } = pow;

    this.logger.info(`${ab.address} has quota ${quota.currentQuota}, required quota ${requiredQuota}, difficulty is ${difficulty}`);
    // If difficulty is null, it indicates the account has enough quota to send the transaction. There is no need to do PoW
    if (Number(quota.currentQuota) < Number(requiredQuota) || difficulty) {
      // Call GVite-RPC API to calculate nonce from difficulty
      const getNonceHashBuffer = Buffer.from(ab.originalAddress + ab.previousHash, 'hex');
      const getNonceHash = utils.blake2bHex(getNonceHashBuffer, null, 32);
      const nonce = await this.provider.request('util_getPoWNonce', difficulty, getNonceHash)
      this.logger.info(`nonce: ${nonce}`);

      ab.setDifficulty(difficulty);
      ab.setNonce(nonce);
    }
  }
  async callContract(account, methodName, amount, params = []) {
    if(typeof amount != 'string') {
      throw new Error('amount should be a string');
    }
    const ab = accountBlock.createAccountBlock('callContract', {
      address: account.address,
      abi: this.getAbi(methodName),
      methodName,
      amount,
      toAddress: this.address,
      params
    }).setProvider(this.provider).setPrivateKey(account.privateKey);

    await this.PoW(ab);

    const result = await ab.sign().send();
    this.logger.info(`call contract [method=${methodName}] successful %j`, result);
    return result
  }

  async subscribeLogEvent(address, eventName) {
    const filterParameters = {"addressHeightRange":{[address]:{"fromHeight":"0","toHeight":"0"}}}; 
    const subscription = await this.provider.subscribe("createVmlogSubscription", filterParameters);
    subscription.callback = ([ res ]) => {
      const sig = abi.encodeLogSignature(this.abi, eventName);
      if (sig === res['vmlog']['topics'][0]) {
        const data = Buffer.from(res['vmlog']['data'], 'base64').toString('hex');
        const log = abi.decodeLog(this.abi, data, sig, eventName);
        this.logger.info('log event detected %j', log);
        this.event.emit(log.name, log);
      };
    };
    this.logger.info(`subscribe ${eventName} event successful ${address} ${subscription.id}`);
    return subscription;
  }

  async send(account, toAddress, amount) {
    if(typeof amount != 'string') {
      throw new Error('amount should be a string');
    }
    const ab = accountBlock.createAccountBlock('send', {
      address: account.address,
      toAddress: toAddress,
      amount,
    }).setProvider(this.provider).setPrivateKey(account.privateKey);

    await this.PoW(ab);

    const ret = await ab.sign().send();
    this.logger.info('send success %j', ret);
    return ret;
  }

  async receiveTransaction(account, hash) {
    // create a receive tx
    const ab = accountBlock.createAccountBlock('receive', {
      address: account.address,
      sendBlockHash: hash,
    }).setProvider(this.provider).setPrivateKey(account.privateKey);

    await this.PoW(ab);

    const ret = await ab.sign().send();
    this.logger.info('receive success %j', ret);
    return ret;
  }

  async subscribeAddressListEvent() {
    this.addressList = await this.getAddressList();
    this.addressList.forEach(async (addr) => {
      if (!this.subMap[addr]) {
        const sub = await this.subscribeUnreceivedEvent(addr);
        this.subMap[addr] = sub;
      }
    })
    this.logger.info(`subscribe ${this.addressList.length} addresses event successful`);
    this.event.once('addUser', async ([ret]) => {
      if (ret.result == 'success') {
        await this.subscribeUnreceivedEvent();
      }
    })
  }
  async subscribeUnreceivedEvent(address){
    let account
    try {
      const idx = this.addressList.findIndex((val) => val == address);
      const walletFileName = this.addressList[idx - idx % this.step];
      const str = await readFile(path.join(this.walletDir, walletFileName), 'utf8');
      const walletInfo = JSON.parse(str);
      const activeWallet = wallet.getWallet(walletInfo.mnemonics);
      account = activeWallet.deriveAddress(idx);
    } catch (e) {
      this.logger.error(e)
    }
    if (!account || account.address != address) {
      this.logger.error(`subscribeUnreceivedEvent error ${address}: %j`, account);
      return false
    }
    const subscription = await this.provider.subscribe("createUnreceivedBlockSubscriptionByAddress", address);
    subscription.callback = async ([ res ]) => {
      this.logger.info('unreceived event detected %j', res);
      try {
        if (res.received) {
          const balance = await this.getAddressBalance(account.address);
          this.logger.debug('balance', balance);
          const ret = await this.deposit(account, balance);
          this.logger.debug('deposit %j', ret);
          if (ret) {
            this.event.emit('notify', {
              type: 'deposit',
              address,
              balance,
              hash: ret.hash,
            });
          }
        } else {
          await this.receiveTransaction(account, res.hash);
        }
      } catch (e) {
        this.logger.error('%j', e);
      }
    };
    this.logger.debug('subscribeUnreceivedEvent successful', address, subscription.id)
    return subscription;
  }

  async getAddressBalance(addr, tokenId=VITE_TOKENID){
    const data = await this.provider.request('ledger_getAccountInfoByAddress', addr);
    this.logger.info('account info %j', data);
    if (data.balanceInfoMap && data.balanceInfoMap[tokenId]) {
      return data.balanceInfoMap[tokenId]['balance'];
    } else {
      return '0';
    }
  }

  async getUserBalance(userId, platform) {
    const [balance] = await this.provider.callOffChainContract({
      address: this.address,
      abi: this.getAbi('getUserBalance'),
      code: Buffer.from(this.offChainCode, 'hex').toString('base64'),
      params: [userId, this.platformMap[platform]],
    });
    return balance;
  }

  async getUserBalanceByAddress(addr) {
    const [balance] = await this.provider.callOffChainContract({
      address: this.address,
      abi: this.getAbi('getUserBalanceByAddress'),
      code: Buffer.from(this.offChainCode, 'hex').toString('base64'),
      params: [addr],
    });
    return balance;
  }

  async getUserAddress(userId, platform) {
    if(typeof userId != 'string') {
      throw Error('userId should be a string')
    }
    const [addr] = await this.provider.callOffChainContract({
      address: this.address,
      abi: this.getAbi('getUserAddress'),
      code: Buffer.from(this.offChainCode, 'hex').toString('base64'),
      params: [userId, this.platformMap[platform]],
    });
    if (addr !== EMPTY_ADDRESS) {
      return addr;
    } else {
      return null;
    }
  }

  async getUserId(address) {
    const [ userId ] = await this.provider.callOffChainContract({
      address: this.address,
      abi: this.getAbi('getOriginalUserId'),
      code: Buffer.from(this.offChainCode, 'hex').toString('base64'),
      params: [address],
    });
    return userId;
  }

  async getPrefixByAddress(address) {
    const [ prefix ] = await this.provider.callOffChainContract({
      address: this.address,
      abi: this.getAbi('getPrefixByAddress'),
      code: Buffer.from(this.offChainCode, 'hex').toString('base64'),
      params: [address],
    });
    return prefix;
  }

  async getAddressList(){
    const [addressList] = await this.provider.callOffChainContract({
      address: this.address,
      abi: this.getAbi('getAddressList'),
      code: Buffer.from(this.offChainCode, 'hex').toString('base64'),
    })
    return addressList;
  }

  // getAddressSample(){
  //   const sample = [];
  //   for (let i = 0, len = this.addressList.length; i < len; i = i+this.step) {
  //     sample.push(this.addressList[i]);
  //   }
  //   return sample;
  // }

  async deriveAddress(userId, platform) {
    if(typeof userId != 'string') {
      throw Error('userId should be a string')
    }
    // const addr = await this.getUserAddress(userId, platform);
    // if (addr) {
    //   this.logger.info('This user has bound an address', addr);
    //   return addr;
    // }
    this.addressList = await this.getAddressList();
    this.logger.info('derive a new address to this user');
    // Derive a new address, derive 1000 addresses in each wallet
    // race condition, make sure only one pair can add user successful
    const idx = this.addressList.length % this.step;
    let newAddr;
    if (idx == 0) {
      // create new wallet
      const newWallet = wallet.createWallet();
      newAddr = newWallet.deriveAddress(idx);
      try {
        // save wallet info to a file
        const stream = fs.createWriteStream(path.join(this.walletDir, newAddr.address), {
          flags: 'a',
          encoding: 'utf8',
        })
        stream.write(JSON.stringify(newWallet));
        stream.end();
      } catch (e) {
        this.logger.error(e);
        //TODO save wallet info to the log file
        this.logger.error('%j', newWallet);
      }
      return newAddr.address;
    } else {
      const walletFileName = this.addressList[this.addressList.length - idx];
      try {
        const str = await readFile(path.join(this.walletDir, walletFileName), 'utf8');
        const walletInfo = JSON.parse(str);
        const activeWallet = wallet.getWallet(walletInfo.mnemonics);
        newAddr = activeWallet.deriveAddress(idx);
      } catch (err) {
        this.logger.error(err);
        throw err;
      }
    }
    return newAddr.address;
  }

  async addUser(userId, platform, address) {
    if(typeof userId != 'string') {
      throw new Error('userId should be a string');
    }
    let info;
    process.nextTick(async () => {
      try {
        info = await this.callContract(this.owner, 'addUser', '0', [userId, this.platformMap[platform], address]);
        this.logger.info('addUser %j', info);
      } catch (e) {
        this.logger.error('%j', e);
        this.event.emit('addUser', {name: 'addUser', result: 'error'});
      }
    })
    const [ret] = await once(this.event, 'addUser');
    if (ret.result == 'success') {
      return info;
    } else {
      return false;
    }
  }

  async deposit(account, amount) {
    if(typeof amount != 'string') {
      throw new Error('amount should be a string');
    }
    let info;
    process.nextTick(async () => {
      try {
        info = await this.callContract(account, 'deposit', amount);
        this.logger.info('deposit %j', info);
      } catch (e) {
        this.logger.error('%j', e);
        this.event.emit('deposit', {name: 'deposit', result: 'error'});
      }
    })
    const [ret] = await once(this.event, 'deposit');
    this.logger.info(ret);
    if (ret.result == 'success') {
      return info;
    } else {
      return false;
    }
  }

  async withdraw(userId, platform, withdrawAddress, amount) {
    if(typeof userId != 'string') {
      throw new Error('userId should be a string');
    }
    if(typeof amount != 'string') {
      throw new Error('amount should be a string');
    }
    const userAddress = await this.getUserAddress(userId, platform);
    if (userAddress === null) {
      throw new Error('User does not exist');
    }
    let info;
    process.nextTick(async () => {
      try {
        info = await this.callContract(this.owner, 'withdrawByOwner', '0', [userAddress, withdrawAddress, amount]);
        this.logger.info('withdraw %j', info);
      } catch (e) {
        this.logger.error('%j', e);
        this.event.emit('withdrawByOwner', {name: 'withdrawByOwner', result: 'error'});
      }
    })
    const [ret] = await once(this.event, 'withdrawByOwner');
    if (ret.result == 'success') {
      return info;
    } else {
      return false;
    }
  }

  async withdrawByAddress(userAddress, withdrawAddress, amount) {
    if(typeof amount != 'string') {
      throw new Error('amount should be a string');
    }
    let info;
    process.nextTick(async () => {
      try {
        info = await this.callContract(this.owner, 'withdrawByOwner', '0', [userAddress, withdrawAddress, amount]);
        this.logger.info('withdrawByAddress %j', info);
      } catch (e) {
        this.logger.error('%j', e);
        this.event.emit('withdrawByOwner', {name: 'withdrawByOwner', result: 'error'});
      }
    });
    const [ret] = await once(this.event, 'withdrawByOwner');
    if (ret.result == 'success') {
      return info;
    } else {
      return false;
    }
  }

  async tip(fromAddress, toAddress, amount) {
    if(typeof amount != 'string') {
      throw new Error('amount should be a string');
    }
    let info;
    process.nextTick(async () => {
      try {
        info = await this.callContract(this.owner, 'tipByOwner', '0', [fromAddress, toAddress, amount]);
        this.logger.info('tipByOwner %j', info);
      } catch (e) {
        this.logger.error('%j', e);
        this.event.emit('tipByOwner', {name: 'tipByOwner', result: 'error'});
      }
    });
    const [ret] = await once(this.event, 'tipByOwner');
    if (ret.result == 'success') {
      return info;
    } else {
      return false;
    }
  }
}

function readableBalance(balance) {
  return Number(BigInt(balance) / BigInt(1e10)) / 1e8;
}


module.exports = {
  TipBotContractClient,
  readableBalance,
}