/**
 * Paper Trading Engine self-test
 *
 * Fills virtual orders against LIVE Polymarket orderbooks (public data only).
 * No real orders are possible - everything routes to the paper wallet.
 *
 * Run: npx tsx scripts/paper-engine-selftest.ts
 */

import 'dotenv/config';
import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== Paper Trading Engine Self-Test ===\n');

  const sdk = await PolymarketSDK.create({ paperTrading: true });
  const eng = sdk.paper;
  if (!eng) throw new Error('Paper engine not initialized');

  const start = eng.getBalances();
  console.log(`Start: $${start.usdc} USDC.e / ${start.matic} MATIC\n`);

  // 1. Pick a LIQUID market (tight spread) so round-trip costs are small
  const trending = await sdk.gammaApi.getTrendingMarkets(20);
  let conditionId = '';
  let yesTokenId = '';
  let bestSpread = Number.POSITIVE_INFINITY;
  for (const m of trending) {
    if (!m.conditionId) continue;
    try {
      const full = await sdk.markets.getMarket(m.conditionId);
      const yes = full.tokens.find(t => t.outcome === 'Yes');
      if (!yes?.tokenId) continue;
      const b = await sdk.markets.getTokenOrderbook(yes.tokenId);
      if (!b.bids[0] || !b.asks[0]) continue;
      const spread = (b.asks[0].price - b.bids[0].price) / b.asks[0].price;
      if (spread < bestSpread && b.asks[0].price > 0.05) {
        bestSpread = spread;
        conditionId = m.conditionId;
        yesTokenId = yes.tokenId;
      }
      if (bestSpread < 0.02) break; // good enough
    } catch { /* try next */ }
  }
  if (!yesTokenId) throw new Error('No suitable market found');
  const book = await sdk.markets.getTokenOrderbook(yesTokenId);
  console.log(`Market: ${conditionId.slice(0, 14)}… (spread ${(bestSpread * 100).toFixed(2)}%)`);
  console.log(`YES book: bestBid=${book.bids[0]?.price} bestAsk=${book.asks[0]?.price}\n`);

  eng.rememberToken(yesTokenId, conditionId, 'Yes');
  let pass = 0, fail = 0;
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log(`  PASS ${name} ${detail}`); }
    else { fail++; console.log(`  FAIL ${name} ${detail}`); }
  };

  // 2. BUY $10 (FAK)
  const buy = await sdk.tradingService.createMarketOrder({
    tokenId: yesTokenId, side: 'BUY', amount: 10, orderType: 'FAK',
  });
  const afterBuy = eng.getBalances();
  const pos = eng.getPositions().find(p => p.tokenId === yesTokenId);
  check('BUY $10 filled', buy.success === true, buy.success ? `orderId=${buy.orderId}` : `err=${buy.errorMsg}`);
  check('USDC decreased by ~$10.03', Math.abs((start.usdc - afterBuy.usdc) - 10.03) < 0.05, `${start.usdc} -> ${afterBuy.usdc}`);
  check('Position opened', !!pos && pos.shares > 0, pos ? `${pos.shares} shares @ ${pos.avgCost.toFixed(4)}` : 'none');

  // 3. SELL everything back (round-trip loss bounded by spread on liquid book)
  if (pos) {
    const sell = await sdk.tradingService.createMarketOrder({
      tokenId: yesTokenId, side: 'SELL', amount: pos.shares, orderType: 'FAK',
    });
    const afterSell = eng.getBalances();
    const snap = eng.snapshot();
    check('SELL filled', sell.success === true, sell.errorMsg || '');
    check('Position closed (test token)', !eng.getPositions().some(p => p.tokenId === yesTokenId));
    check('Round-trip cost < $2 (liquid book)', Math.abs(afterSell.usdc - start.usdc) < 2.0, `${afterSell.usdc} (PnL ${snap.realizedPnl >= 0 ? '+' : ''}${snap.realizedPnl})`);
  }

  // 4. FOK rejection on impossible size
  const huge = await sdk.tradingService.createMarketOrder({
    tokenId: yesTokenId, side: 'BUY', amount: 1000000, orderType: 'FOK',
  });
  check('FOK huge BUY rejected', huge.success === false, (huge.errorMsg || '').slice(0, 80));

  // 5. Min-order rejection (mirrors real validation)
  const tiny = await sdk.tradingService.createMarketOrder({
    tokenId: yesTokenId, side: 'BUY', amount: 0.5,
  });
  check('$0.50 order rejected', tiny.success === false, (tiny.errorMsg || '').slice(0, 80));

  // 6. Non-crossing limit order rests, then cancel
  const belowBid = Math.max(0.001, (book.bids[0]?.price ?? 0.5) - 0.01);
  const limit = await sdk.tradingService.createLimitOrder({
    tokenId: yesTokenId, side: 'BUY', price: belowBid, size: 10,
  });
  check('Non-crossing limit order rests', limit.success === true && !!limit.orderId && eng.getOpenOrders().length === 1,
    limit.orderId || limit.errorMsg || '');
  const cancel = await sdk.tradingService.cancelAllOrders();
  check('cancelAllOrders', cancel.success === true && eng.getOpenOrders().length === 0);

  // 7. getOpenOrders/getTrades shapes
  const trades = await sdk.tradingService.getTrades();
  check('getTrades returns paper fills', trades.length >= 2, `${trades.length} trades`);

  const snap = eng.snapshot();
  console.log(`\nFinal: $${snap.balances.usdc} USDC.e | realized PnL ${snap.realizedPnl >= 0 ? '+' : ''}${snap.realizedPnl} | fills=${snap.fills} | gas=$${snap.gasPaid}`);

  eng.stop();
  sdk.stop();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('SELFTEST ERROR:', err);
  process.exit(1);
});
