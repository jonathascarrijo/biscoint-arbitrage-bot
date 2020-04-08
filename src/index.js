import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import player from 'play-sound';
import moment from 'moment';
import config from './config.js';

// read the configurations
let {
  apiKey, apiSecret, amount, amountCurrency, initialBuy, minProfitPercent, intervalSeconds, playSound, burst,
  simulation, helperKeys, executeMissedSecondLeg,
} = config;

// global variables
let bc, lastTrade = 0, isQuote, helpers = [], pollerIndex = 0, balances;

// Initializes the Biscoint API connector object.
const init = () => {
  if (!apiKey) {
    handleMessage('You must specify "apiKey" in config.json', 'error', true);
  }
  if (!apiSecret) {
    handleMessage('You must specify "apiSecret" in config.json', 'error', true);
  }

  amountCurrency = _.toUpper(amountCurrency);
  if (!['BRL', 'BTC'].includes(amountCurrency)) {
    handleMessage('"amountCurrency" must be either "BRL" or "BTC". Check your config.json file.', 'error', true);
  }

  if (isNaN(amount)) {
    handleMessage(`Invalid amount "${amount}. Please specify a valid amount in config.json`, 'error', true);
  }

  isQuote = amountCurrency === 'BRL';

  bc = new Biscoint({
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    apiUrl: config.apiUrl,
  });

  _.each(helperKeys, (hk) => {
    const { apiKey, apiSecret } = hk;
    helpers.push(new Biscoint({ apiKey, apiSecret }));
  });
};

// Checks that the balance necessary for the first operation is sufficient for the configured 'amount'.
const checkBalances = async () => {
  balances = await bc.balance();
  const { BRL, BTC } = balances;

  handleMessage(`Balances:  BRL: ${BRL} - BTC: ${BTC} `);

  const nAmount = Number(amount);
  let amountBalance = isQuote ? BRL : BTC;
  if (nAmount > Number(amountBalance)) {
    handleMessage(
      `Amount ${amount} is greater than the user's ${isQuote ? 'BRL' : 'BTC'} balance of ${amountBalance}`,
      'error',
      true,
    );
  }
};

let burstMax = 0;
let burstsLeft = 0;

// Checks that the configured interval is within the allowed rate limit.
const checkInterval = async () => {
  const { endpoints } = await bc.meta();
  const { windowMs, maxRequests } = endpoints.offer.post.rateLimit;
  handleMessage(`Offer Rate limits: ${maxRequests} request per ${windowMs}ms.`);

  let minInterval = 2.0 * parseFloat(windowMs) / parseFloat(maxRequests) / 1000.0;

  if (!intervalSeconds) {
    intervalSeconds = minInterval;
    handleMessage(`Setting interval to ${intervalSeconds}s`);
  } else if (intervalSeconds < minInterval) {
    handleMessage(`Interval too small (${intervalSeconds}s). Must be higher than ${minInterval.toFixed(1)}s`, 'error', true);
  } else if (intervalSeconds > minInterval) {
    burstMax = Math.floor((intervalSeconds - minInterval) / minInterval / 4 * maxRequests);
    burstsLeft = burstMax;
    console.log(`burstMax: ${burstMax}`);
  }
};

let tradeCycleCount = 0;

// Executes an arbitrage cycle
async function tradeCycle(bursting) {
  let startedAt = 0;
  let finishedAt = 0;

  tradeCycleCount += 1;
  const tradeCycleStartedAt = Date.now();

  handleMessage(`[${tradeCycleCount}] Trade cycle started...`);

  let poller, isMain = false;
  if (bursting || pollerIndex === 0) {
    if (helpers.length) {
      console.log('polling with main');
    }
    poller = bc;
    isMain = true;
  } else {
    console.log(`polling with helper ${pollerIndex}`);
    poller = helpers[pollerIndex - 1];
  }
  let buyOffer, sellOffer, profit;
  try {
    startedAt = Date.now();

    buyOffer = await poller.offer({
      amount,
      isQuote,
      op: 'buy',
    });

    finishedAt = Date.now();

    handleMessage(`[${tradeCycleCount}] Got buy offer: ${buyOffer.efPrice} (${finishedAt - startedAt} ms)`);

    startedAt = Date.now();

    sellOffer = await poller.offer({
      amount,
      isQuote,
      op: 'sell',
    });

    finishedAt = Date.now();

    handleMessage(`[${tradeCycleCount}] Got sell offer: ${sellOffer.efPrice} (${finishedAt - startedAt} ms)`);

    profit = percent(buyOffer.efPrice, sellOffer.efPrice);
    handleMessage(`[${tradeCycleCount}] Calculated profit: ${profit.toFixed(3)}%`);
  } catch (error) {
    handleMessage(`[${tradeCycleCount}] Error on get offer: ${error.error || error.message}`, 'error');
    console.error(error);
  } finally {
    pollerIndex = (pollerIndex + 1) % (helpers.length + 1);
    if (helpers.length) {
      console.log(`next poller ${pollerIndex}`);
    }
  }

  if (
    profit >= minProfitPercent
  ) {
    if (!isMain) {
      if (burstsLeft > 0) {
        console.log('found arbitrage with helper, reverting to main poller and bursting');
        pollerIndex = 0;
        burstsLeft--;
        await tradeCycle();
      }
      return false;
    }
    let firstOffer, secondOffer, firstLeg, secondLeg;
    try {
      if (initialBuy) {
        firstOffer = buyOffer;
        secondOffer = sellOffer;
      } else {
        firstOffer = sellOffer;
        secondOffer = buyOffer;
      }

      if (simulation) {
        handleMessage('[${tradeCycleCount}] Would execute arbitrage if simulation mode was not enabled');
      } else {
        firstLeg = await bc.confirmOffer({
          offerId: firstOffer.offerId,
        });

        secondLeg = await bc.confirmOffer({
          offerId: secondOffer.offerId,
        });
      }

      finishedAt = Date.now();

      lastTrade = Date.now();

      handleMessage(`[${tradeCycleCount}] Success, profit: + ${profit.toFixed(3)}%`);
      play();
      if (burst && !bursting && burstsLeft) {
        console.log(`bursting ${burstsLeft} times`);
        while(burstsLeft>0) {
          --burstsLeft;
          if (!await tradeCycle(true)) {
            break;
          }
          console.log(`burstsLeft: ${burstsLeft}`);
        }
      }
      return true;
    } catch (error) {
      handleMessage(`[${tradeCycleCount}] Error on confirm offer: ${error.error}`, 'error');
      console.error(error);

      if (firstLeg && !secondLeg) {
        // probably only one leg of the arbitrage got executed, we have to accept loss and rebalance funds.
        try {
          // first we ensure the leg was not actually executed
          let secondOp = initialBuy ? 'sell' : 'buy';
          const trades = await bc.trades({ op: secondOp });
          if (_.find(trades, t => t.offerId === secondOffer.offerId)) {
            handleMessage(`[${tradeCycleCount}] The second leg was executed despite of the error. Good!`);
          } else if (!executeMissedSecondLeg) {
            handleMessage(
              `[${tradeCycleCount}] Only the first leg of the arbitrage was executed, and the ` +
              'executeMissedSecondLeg is false, so we won\'t execute the second leg.',
            );
          } else {
            handleMessage(
              `[${tradeCycleCount}] Only the first leg of the arbitrage was executed. ` +
              'Trying to execute it at a possible loss.',
            );
            secondLeg = await bc.offer({
              amount,
              isQuote,
              op: secondOp,
            });
            await bc.confirmOffer({
              offerId: secondLeg.offerId,
            });
            handleMessage(`[${tradeCycleCount}] The second leg was executed and the balance was normalized`);
          }
        } catch (error) {
          handleMessage(
            `[${tradeCycleCount}] Fatal error. Unable to recover from incomplete arbitrage. Exiting.`, 'fatal',
          );
          await sleep(500);
          process.exit(1);
        }
      }
    }
  } else {
    if (!bursting) {
      burstsLeft = Math.min(burstMax, burstsLeft + 1);
    }
    console.log(`burstsLeft: ${burstsLeft}`);
  }


  const tradeCycleFinishedAt = Date.now();
  const tradeCycleElapsedMs = parseFloat(tradeCycleFinishedAt - tradeCycleStartedAt);

  const intervalMs = intervalSeconds / (helpers.length + 1) * 1000.0;
  const shouldWaitMs = Math.max(Math.ceil(intervalMs - tradeCycleElapsedMs), 0);

  // handleMessage(`[${cycleCount}] Cycle took ${tradeCycleElapsedMs} ms`);

  // handleMessage(`[${cycleCount}] New cycle in ${shouldWaitMs} ms...`);

  setTimeout(tradeCycle, shouldWaitMs);
}

// Starts trading, scheduling trades to happen every 'intervalSeconds' seconds.
const startTrading = async () => {
  handleMessage(`Starting trades every ${intervalMs}ms (keys: ${helpers.length + 1})`);
  await tradeCycle();
};

// -- UTILITY FUNCTIONS --

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve(), ms));
}

function percent(value1, value2) {
  return (Number(value2) / Number(value1) - 1) * 100;
}

function handleMessage(message, level = 'info', throwError = false) {
  console.log(`${moment().format('hh:mm:ss.SSS')} [BOT][${level}] ${message}`);
  if (throwError) {
    throw new Error(message);
  }
}

const sound = playSound && player();

const play = () => {
  if (playSound) {
    sound.play('./tone.mp3', (err) => {
      if (err) console.log(`Could not play sound: ${err}`);
    });
  }
};

// performs initialization, checks and starts the trading cycles.
async function start() {
  try {
    init();
    await checkBalances();
    await checkInterval();
    await startTrading();
  } catch (e) {
    handleMessage(e, 'error');
  }
}

start().catch(e => handleMessage(JSON.stringify(e), 'error'));
