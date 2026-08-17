import crypto from 'node:crypto';
import { config } from '../config.js';

const BASE_URL = 'https://api.wazirx.com';
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function throttle() {
  const run = requestQueue.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  requestQueue = run.catch(() => {});
  return run;
}

async function request(path, options = {}, attempt = 0) {
  await throttle();
  const response = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(12_000), ...options });
  if (response.status === 429 && attempt < 3) {
    await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    return request(path, options, attempt + 1);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WazirX ${response.status}: ${body.message ?? body.code ?? response.statusText}`);
  return body;
}

function signedBody(params) {
  const body = new URLSearchParams({ ...params, recvWindow: '10000', timestamp: String(Date.now()) });
  body.set('signature', crypto.createHmac('sha256', config.secretKey).update(body.toString()).digest('hex'));
  return body;
}

export const wazirx = {
  ping: () => request('/sapi/v1/ping'),
  exchangeInfo: () => request('/sapi/v1/exchangeInfo'),
  ticker: symbol => request(`/sapi/v1/ticker/24hr?${new URLSearchParams({ symbol })}`),
  async candles(symbol, interval = config.interval, limit = 2000) {
    const rows = await request(`/sapi/v1/klines?${new URLSearchParams({ symbol, interval, limit: String(limit) })}`);
    return rows.map(([time, open, high, low, close, volume]) => ({
      time: Number(time) < 1e12 ? Number(time) * 1000 : Number(time),
      open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume)
    })).filter(c => [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite));
  },
  async funds() {
    const body = signedBody({});
    return request(`/sapi/v1/funds?${body}`, { headers: { 'X-Api-Key': config.apiKey } });
  },
  async placeLimitOrder({ symbol, side, quantity, price, test = false }) {
    if (!config.liveMode) throw new Error('Live orders are disabled');
    const body = signedBody({ symbol, side, type: 'limit', quantity: String(quantity), price: String(price) });
    return request(`/sapi/v1/order${test ? '/test' : ''}`, {
      method: 'POST', headers: { 'X-Api-Key': config.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
  }
};
