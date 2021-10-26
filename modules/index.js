const { TipBotContractClient, readableBalance } = require('./tipBotClient');
const { setupLogger } = require('./logger');

module.exports = {
    setupLogger,
    TipBotContractClient,
    readableBalance,
}
