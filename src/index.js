import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import player from 'play-sound';
import moment from 'moment';
import config from './config.js';

// read the configurations
let {
  apiKey, apiSecret, amount, amountCurrency, initialBuy, minProfitPercent, intervalSeconds, playSound, burst,
  simulation, helperKeys,
} = config;

let bc, lastTrade = 0, isQuote, helpers = [], pollerIndex = 0;

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
    apiSecret: config.apiSecret
  });

  _.each(helperKeys, (hk) => {
    const { apiKey, apiSecret } = hk;
    helpers.push(new Biscoint({ apiKey, apiSecret }));
  });
};

const checkBalances = async () => {
  const { BRL, BTC } = await bc.balance();

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
const checkInterval = async () => {
  const { endpoints } = await bc.meta();
  const { windowMs, maxRequests } = endpoints.offer.post.rateLimit;
  handleMessage(`Offer Rate limits: ${maxRequests} request per ${windowMs}ms.`);

  let minInterval = 2 * windowMs / maxRequests / 1000;

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

async function tradeCycle(bursting) {
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
    buyOffer = await poller.offer({
      amount,
      isQuote,
      op: 'buy',
    });

    sellOffer = await poller.offer({
      amount,
      isQuote,
      op: 'sell',
    });

    profit = percent(buyOffer.efPrice, sellOffer.efPrice);
    handleMessage(`Calculated profit: ${profit.toFixed(3)}%`);
  } catch (error) {
    handleMessage('Error on get offer', 'error');
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
    try {
      let firstOffer, secondOffer;

      if (initialBuy) {
        firstOffer = buyOffer;
        secondOffer = sellOffer;
      } else {
        firstOffer = sellOffer;
        secondOffer = buyOffer;
      }

      if (simulation) {
        handleMessage('Would execute arbitrage if simulation mode was not enabled');
      } else {
        await bc.confirmOffer({
          offerId: firstOffer.offerId,
        });

        await bc.confirmOffer({
          offerId: secondOffer.offerId,
        });
      }

      lastTrade = Date.now();

      handleMessage(`Success, profit: + ${profit.toFixed(3)}%`);
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
      handleMessage('Error on confirm offer', 'error');
      console.error(error);
    }
  } else {
    if (!bursting) {
      burstsLeft = Math.min(burstMax, burstsLeft + 1);
    }
    console.log(`burstsLeft: ${burstsLeft}`);
  }

  return false;
}

const startTrading = async () => {
  let intervalMs = intervalSeconds / (helpers.length + 1) * 1000;
  handleMessage(`Starting trades every ${intervalMs}ms (keys: ${helpers.length + 1})`);
  await tradeCycle();
  setInterval(tradeCycle, intervalMs);
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
