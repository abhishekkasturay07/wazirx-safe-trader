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
  if (qty <= 0) { store.cancelEntry(position.id); return; }
  const invested = quoteQty + quoteFee;
  const entryPrice = invested / qty;
  store.confirmEntry(position.id, {
    quantity: qty, entryPrice, invested,
    stopPrice: entryPrice * (1 - config.stopLossPercent / 100),
    targetPrice: entryPrice * (1 + config.firstTakeProfitPercent / 100)
  });
  await notify(`🟢 ${position.symbol.toUpperCase()} BUY filled`, `Quantity: ${qty}\nCost: ₹${invested.toFixed(2)}`);
}

async function reconcileAdd(position, fills) {
  const { qty, quoteQty, quoteFee } = summarizeFills(fills, position.symbol);
  if (qty <= 0) { store.revertAdd(position.id); return; }
  const addedInvested = quoteQty + quoteFee;
  const totalQuantity = position.quantity + qty;
  const totalInvested = position.invested + addedInvested;
  const entryPrice = totalInvested / totalQuantity;
  store.confirmAdd(position.id, {
    addedQuantity: qty, addedInvested, entryPrice, totalQuantity, totalInvested,
    stopPrice: entryPrice * (1 - config.stopLossPercent / 100),
    targetPrice: entryPrice * (1 + config.firstTakeProfitPercent / 100)
  });
  await notify(`🟢 ${position.symbol.toUpperCase()} ADD filled`, `Added quantity: ${qty}\nNew average: ₹${entryPrice.toFixed(8)}`);
}

async function reconcileExit(position, fills, legComplete = true) {
  const { qty, quoteQty, quoteFee } = summarizeFills(fills, position.symbol);
  if (qty <= 0) { store.revertToOpen(position.id); return; }
  const proceeds = quoteQty - quoteFee;
  const reason = position.exit_reason ?? 'FILLED';
  if (nearlyGte(qty, position.quantity)) {
    const pnl = proceeds - position.invested;
    store.confirmExit(position.id, proceeds / qty, pnl, reason);
    await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} SOLD`, `Proceeds: ₹${proceeds.toFixed(2)}\nNet P/L: ₹${pnl.toFixed(2)}`);
  } else {
    const soldInvested = position.invested * (qty / position.quantity);
    const pnl = proceeds - soldInvested;
    const nextStage = legComplete && reason === 'TAKE_PROFIT_1' ? 'TP1_DONE'
      : legComplete && reason === 'TAKE_PROFIT_2' ? 'RUNNER' : position.strategy_stage;
    store.confirmPartialExit(position, { soldQty: qty, soldInvested, exitPrice: proceeds / qty, pnl, reason, nextStage });
    await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} PARTIALLY SOLD`, `Sold: ${qty} of ${position.quantity}\nProceeds: ₹${proceeds.toFixed(2)}\nNet P/L: ₹${pnl.toFixed(2)}\nRemaining quantity stays OPEN.`);
  }
}

// A crash between writing the pending row and attaching the real order id leaves buy/sell_order_id
// null with only client_order_id set — resolve that by looking the order up by clientOrderId.
async function resolveOrderId(position, side) {
  const existing = side === 'buy' ? position.buy_order_id : position.sell_order_id;
  if (existing) return existing;
  if (!position.client_order_id) return null;
  const order = await wazirx.orderStatus(position.symbol, undefined, position.client_order_id);
  if (order?.id) store.attachOrderId(position.id, side, order.id);
  return order?.id ?? null;
}

export async function reconcilePending() {
  for (const position of store.pendingPositions()) {
    try {
      const side = ['PENDING_ENTRY', 'PENDING_ADD'].includes(position.status) ? 'buy' : 'sell';
      const orderId = await resolveOrderId(position, side);
      if (!orderId) {
        const age = minutesSince(position.pending_since);
        store.event('ERROR', `${position.symbol}: pending position #${position.id} has no resolved order id after ${age.toFixed(1)}m; kept pending because the exchange outcome is unknown`);
        continue;
      }
      const order = await wazirx.orderStatus(position.symbol, orderId);
      const executedQty = Number(order.executedQty ?? 0);
      if (order.status === 'done' || (order.status === 'cancel' && executedQty > 0)) {
        const fills = await wazirx.myTrades(position.symbol, orderId);
        if (position.status === 'PENDING_ENTRY') await reconcileEntry(position, fills);
        else if (position.status === 'PENDING_ADD') await reconcileAdd(position, fills);
        else await reconcileExit(position, fills, order.status === 'done');
      } else if (order.status === 'cancel') {
        if (position.status === 'PENDING_ENTRY') store.cancelEntry(position.id);
        else if (position.status === 'PENDING_ADD') store.revertAdd(position.id);
        else store.revertToOpen(position.id);
        store.event('INFO', `${position.symbol}: order ${orderId} was cancelled with no fill`);
      } else if (order.status === 'wait' && minutesSince(order.createdTime) > config.staleOrderMinutes) {
        await cancelStale(position, orderId, order.status);
      }
      // 'idle' or fresh 'wait' — still pending, leave untouched until terminal or stale
    } catch (error) {
      store.event('ERROR', `reconcile ${position.symbol}: ${error.message}`);
    }
  }
  await detectOrphanOrders();
}

export async function reconcileLiveState() {
  await reconcilePending();
  await reconcileOpenBalances();
}

// OPEN rows are the bot's local ledger, while funds() is the exchange source of truth. A coin may
// disappear when it is sold/transferred outside the bot (or when an older deployment missed an
// exit), leaving a phantom position that the bot would otherwise display and try to sell forever.
// Only auto-close a row when the entire base-asset balance is effectively zero. A non-zero mismatch
// is deliberately left untouched because it can include dust, manual holdings, or a partial sale.
export async function reconcileOpenBalances() {
  // A manual/external sale can leave an unresolvable PENDING_EXIT row even though the exchange
  // balance is already zero. Such a phantom row must not consume an entry slot forever.
  const positions = store.activePositions('LIVE').filter(position =>
    position.status === 'OPEN' || position.status === 'PENDING_EXIT');
  if (!positions.length) return;
  const funds = await wazirx.funds();
  const totals = new Map(funds.map(f => [String(f.asset).toLowerCase(), Number(f.free) + Number(f.locked)]));
  for (const position of positions) {
    const symbol = String(position.symbol).toLowerCase();
    if (!symbol.endsWith('inr')) continue;
    const asset = symbol.slice(0, -3);
    const balance = totals.get(asset) ?? 0;
    const zeroTolerance = Math.max(1e-12, Math.abs(Number(position.quantity)) * 1e-8);
    if (balance <= zeroTolerance) {
      store.closeMissingHolding(position.id);
      store.event('INFO', `${symbol}: local OPEN position #${position.id} closed because WazirX ${asset.toUpperCase()} balance is zero`);
    }
  }
}

function minutesSince(timestamp) {
  return timestamp ? (Date.now() - new Date(Number(timestamp) || timestamp).getTime()) / 60000 : 0;
}

// A limit exit that never reaches its price sits at 'wait' forever, letting real loss run past the
// configured stop. WazirX only supports limit/stop_limit orders (no market-order fallback to cross
// the spread with), so the fix is: cancel it, then re-check the ACTUAL final status before touching
// local state — the order can fill (fully or partially) in the gap between deciding it's stale and
// the cancel request landing, so we must never assume "cancel requested" means "cancel succeeded with
// nothing filled".
async function cancelStale(position, orderId, status) {
  await wazirx.cancelOrder(position.symbol, orderId).catch(error => {
    store.event('INFO', `${position.symbol}: cancel request for stale order ${orderId} failed (${error.message}) — checking its real final status anyway`);
  });
  const final = await wazirx.orderStatus(position.symbol, orderId);
  const executedQty = Number(final.executedQty ?? 0);
  if (final.status === 'done' || (final.status === 'cancel' && executedQty > 0)) {
    const fills = await wazirx.myTrades(position.symbol, orderId);
    if (position.status === 'PENDING_ENTRY') await reconcileEntry(position, fills);
    else if (position.status === 'PENDING_ADD') await reconcileAdd(position, fills);
    else await reconcileExit(position, fills, final.status === 'done');
    store.event('INFO', `${position.symbol}: stale order ${orderId} had filled by the time it was cancelled — reconciled ${executedQty}`);
  } else if (final.status === 'cancel') {
    if (position.status === 'PENDING_ENTRY') store.cancelEntry(position.id);
    else if (position.status === 'PENDING_ADD') store.revertAdd(position.id);
    else store.revertToOpen(position.id);
    store.event('INFO', `${position.symbol}: order ${orderId} stale (${status} for >${config.staleOrderMinutes}m) — cancelled with no fill`);
    await notify(`🟡 ${position.symbol.toUpperCase()} stale order cancelled`, `Order ${orderId} sat unfilled past ${config.staleOrderMinutes} minutes and was cancelled.`);
  } else {
    store.event('ERROR', `${position.symbol}: stale-order cancel for ${orderId} did not reach a terminal status (still ${final.status}) — will retry next cycle`);
  }
}

async function detectOrphanOrders() {
  try {
    const live = await wazirx.openOrders();
    const known = new Set(store.pendingPositions().flatMap(p => [p.buy_order_id, p.sell_order_id].filter(Boolean).map(String)));
    const orphans = live.filter(o => !known.has(String(o.id)));
    const unresolved = [];
    for (const order of orphans) {
      const symbol = String(order.symbol ?? '').toLowerCase();
      const side = String(order.side ?? '').toLowerCase();
      const quantity = Number(order.origQty);
      const candidates = side === 'sell' && Number.isFinite(quantity)
        ? store.orphanExitCandidates(symbol, quantity) : [];
      if (candidates.length === 1) {
        const candidate = candidates[0];
        store.reopenAsPendingExit(candidate.id, order.id, candidate.exit_reason ?? 'LEGACY_ORPHAN_RECOVERY');
        store.event('INFO', `${symbol}: adopted orphan sell order ${order.id} into legacy position #${candidate.id}`);
        await notify(`🟡 ${symbol.toUpperCase()} legacy order recovered`, `Orphan sell order ${order.id} was linked to position #${candidate.id}; its previous P/L was removed until the real fill is confirmed.`);
      } else {
        unresolved.push(order);
      }
    }
    if (unresolved.length) {
      const summary = unresolved.map(o => `${o.symbol} ${o.side} id=${o.id} qty=${o.origQty}@${o.price}`).join('\n');
      store.event('ERROR', `Orphan WazirX orders with no local record:\n${summary}`);
      await notify('⚠️ Orphan WazirX orders detected', `These live orders have no matching bot record — check manually:\n${summary}`);
    }
  } catch (error) {
    store.event('ERROR', `orphan check: ${error.message}`);
  }
}
