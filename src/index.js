import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import player from 'play-sound';
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
  const { windowMs, maxRequests } = endpoints.offer.get.rateLimit;

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
  let poller;
  if (pollerIndex === 0) {
    poller = bc;
  } else {
    poller = helpers[pollerIndex - 1];
  }
  try {
    const buyOffer = await poller.offer({
      amount,
      isQuote,
      op: 'buy',
    });

    const sellOffer = await poller.offer({
      amount,
      isQuote,
      op: 'sell',
    });

    const profit = percent(buyOffer.efPrice, sellOffer.efPrice);
    handleMessage(`Calculated profit: ${profit.toFixed(3)}%`);
    if (
      profit >= minProfitPercent
    ) {
      if (pollerIndex > 0) {
        pollerIndex = 0;
        burstsLeft = Math.max(0, burstsLeft -1);
        return await tradeCycle();
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
          for(; burstsLeft>0; burstsLeft--) {
            if (!await tradeCycle(true)) {
              break;
            }
            console.log(`burstsLeft: ${burstsLeft - 1}`);
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
        pollerIndex = (pollerIndex + 1) % (helpers.length + 1);
        console.log(`next poller ${pollerIndex}`);
      }

      console.log(`burstsLeft: ${burstsLeft}`);
    }
  } catch (error) {
    handleMessage('Error on get offer', 'error');
    console.error(error);
  }
  return false;
}

const startTrading = async () => {
  handleMessage('Starting trades');
  await tradeCycle();
  setInterval(tradeCycle, (intervalSeconds / (helpers.length + 1) * 1000));
};

// -- UTILITY FUNCTIONS --

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve(), ms));
}

function percent(value1, value2) {
  return (Number(value2) / Number(value1) - 1) * 100;
}

function handleMessage(message, level = 'info', throwError = false) {
  console.log(`[Biscoint BOT] [${level}] - ${message}`);
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
  init();
  await checkBalances();
  await checkInterval();
  await startTrading();
}

start();
