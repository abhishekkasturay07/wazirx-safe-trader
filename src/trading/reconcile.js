import { config } from '../config.js';
import { store } from '../database/db.js';
import { wazirx } from '../api/wazirx.js';
import { notify } from '../notifications/email.js';

function summarizeFills(fills, symbol) {
  const baseAsset = symbol.endsWith('inr') ? symbol.slice(0, -3) : symbol;
  let qty = 0, quoteQty = 0, baseFee = 0, quoteFee = 0;
  for (const fill of fills) {
    qty += Number(fill.qty);
    quoteQty += Number(fill.quoteQty);
    const fee = Number(fill.fee);
    if (fill.feeCurrency === baseAsset) baseFee += fee;
    else if (fill.feeCurrency === 'inr') quoteFee += fee;
  }
  return { qty: qty - baseFee, quoteQty, quoteFee };
}

const nearlyGte = (a, b) => a >= b - 1e-8;

async function reconcileEntry(position, fills) {
  const { qty, quoteQty, quoteFee } = summarizeFills(fills, position.symbol);
  const invested = quoteQty + quoteFee;
  const entryPrice = invested / qty;
  store.confirmEntry(position.id, {
    quantity: qty, entryPrice, invested,
    stopPrice: entryPrice * (1 - config.stopLossPercent / 100),
    targetPrice: entryPrice * (1 + config.targetPercent / 100)
  });
  await notify(`🟢 ${position.symbol.toUpperCase()} BUY filled`, `Quantity: ${qty}\nCost: ₹${invested.toFixed(2)}`);
}

async function reconcileExit(position, fills) {
  const { qty, quoteQty, quoteFee } = summarizeFills(fills, position.symbol);
  const proceeds = quoteQty - quoteFee;
  const reason = position.exit_reason ?? 'FILLED';
  if (nearlyGte(qty, position.quantity)) {
    const pnl = proceeds - position.invested;
    store.confirmExit(position.id, proceeds / qty, pnl, reason);
    await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} SOLD`, `Proceeds: ₹${proceeds.toFixed(2)}\nNet P/L: ₹${pnl.toFixed(2)}`);
  } else {
    const soldInvested = position.invested * (qty / position.quantity);
    const pnl = proceeds - soldInvested;
    store.confirmPartialExit(position, { soldQty: qty, soldInvested, exitPrice: proceeds / qty, pnl, reason });
    await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} PARTIALLY SOLD`, `Sold: ${qty} of ${position.quantity}\nProceeds: ₹${proceeds.toFixed(2)}\nNet P/L: ₹${pnl.toFixed(2)}\nRemaining quantity stays OPEN.`);
  }
}

export async function reconcilePending() {
  for (const position of store.pendingPositions()) {
    try {
      const orderId = position.status === 'PENDING_ENTRY' ? position.buy_order_id : position.sell_order_id;
      const order = await wazirx.orderStatus(position.symbol, orderId);
      const executedQty = Number(order.executedQty ?? 0);
      if (order.status === 'done' || (order.status === 'cancel' && executedQty > 0)) {
        const fills = await wazirx.myTrades(position.symbol, orderId);
        if (position.status === 'PENDING_ENTRY') await reconcileEntry(position, fills);
        else await reconcileExit(position, fills);
      } else if (order.status === 'cancel') {
        if (position.status === 'PENDING_ENTRY') store.cancelEntry(position.id);
        else store.revertToOpen(position.id);
        store.event('INFO', `${position.symbol}: order ${orderId} was cancelled with no fill`);
      }
      // 'wait' / 'idle' — still pending (possibly partially filled), leave untouched until it reaches a terminal status
    } catch (error) {
      store.event('ERROR', `reconcile ${position.symbol}: ${error.message}`);
    }
  }
  await detectOrphanOrders();
}

async function detectOrphanOrders() {
  try {
    const live = await wazirx.openOrders();
    const known = new Set(store.pendingPositions().flatMap(p => [p.buy_order_id, p.sell_order_id].filter(Boolean).map(String)));
    const orphans = live.filter(o => !known.has(String(o.id)));
    if (orphans.length) {
      const summary = orphans.map(o => `${o.symbol} ${o.side} id=${o.id} qty=${o.origQty}@${o.price}`).join('\n');
      store.event('ERROR', `Orphan WazirX orders with no local record:\n${summary}`);
      await notify('⚠️ Orphan WazirX orders detected', `These live orders have no matching bot record — check manually:\n${summary}`);
    }
  } catch (error) {
    store.event('ERROR', `orphan check: ${error.message}`);
  }
}
