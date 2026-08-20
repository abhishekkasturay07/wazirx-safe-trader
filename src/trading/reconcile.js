import { store } from '../database/db.js';
import { wazirx } from '../api/wazirx.js';
import { notify } from '../notifications/email.js';

function summarizeFills(fills, symbol) {
  const baseAsset = symbol.endsWith('inr') ? symbol.slice(0, -3) : symbol;
  let qty = 0, quoteQty = 0, baseCommission = 0, quoteCommission = 0;
  for (const fill of fills) {
    qty += Number(fill.qty);
    quoteQty += Number(fill.quoteQty);
    const commission = Number(fill.commission);
    if (fill.commissionAsset === baseAsset) baseCommission += commission;
    else if (fill.commissionAsset === 'inr') quoteCommission += commission;
  }
  return { qty: qty - baseCommission, quoteQty, quoteCommission };
}

export async function reconcilePending() {
  for (const position of store.pendingPositions()) {
    try {
      const orderId = position.status === 'PENDING_ENTRY' ? position.buy_order_id : position.sell_order_id;
      const order = await wazirx.orderStatus(position.symbol, orderId);
      if (order.status === 'done') {
        const fills = await wazirx.myTrades(position.symbol, orderId);
        const { qty, quoteQty, quoteCommission } = summarizeFills(fills, position.symbol);
        if (position.status === 'PENDING_ENTRY') {
          const invested = quoteQty + quoteCommission;
          store.confirmEntry(position.id, { quantity: qty, entryPrice: invested / qty, invested });
          await notify(`🟢 ${position.symbol.toUpperCase()} BUY filled`, `Quantity: ${qty}\nCost: ₹${invested.toFixed(2)}`);
        } else {
          const proceeds = quoteQty - quoteCommission;
          const pnl = proceeds - position.invested;
          store.confirmExit(position.id, proceeds / qty, pnl, position.exit_reason ?? 'FILLED');
          await notify(`${pnl >= 0 ? '🟢' : '🔴'} ${position.symbol.toUpperCase()} SOLD`, `Proceeds: ₹${proceeds.toFixed(2)}\nNet P/L: ₹${pnl.toFixed(2)}`);
        }
      } else if (order.status === 'cancel') {
        if (position.status === 'PENDING_ENTRY') store.cancelEntry(position.id);
        else store.revertToOpen(position.id);
        store.event('INFO', `${position.symbol}: order ${orderId} was cancelled`);
      }
      // 'wait' / 'idle' — still pending, leave untouched until next reconciliation pass
    } catch (error) {
      store.event('ERROR', `reconcile ${position.symbol}: ${error.message}`);
    }
  }
}
