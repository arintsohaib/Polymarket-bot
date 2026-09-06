/**
 * Paper Trading Engine
 *
 * Virtual wallet that fills orders against LIVE Polymarket orderbooks using
 * the same semantics as the real CLOB:
 * - BUY amount = USDC, SELL amount = shares (official clob-client convention)
 * - FOK/FAK depth-walking with average fill price
 * - Minimum order value ($1) and tick-size-style rounding
 * - Simulated gas cost per fill
 * - Settlement monitor: resolved markets credit $1 per winning share
 *   (paper equivalent of on-chain merge/redeem)
 *
 * The engine never touches the network for trading: orders are only ever
 * filled virtually. It reads public market data (orderbooks, market
 * resolution) injected at construction time.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { roundSize } from '../utils/price-utils.js';
import type { Orderbook } from '../core/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIN_ORDER_VALUE_USDC = 1;

export interface PaperEngineConfig {
  /** Starting virtual USDC.e balance */
  startingUsdc?: number;
  /** Starting virtual MATIC balance */
  startingMatic?: number;
  /** Simulated gas cost (USDC) deducted per fill */
  gasPerFillUsd?: number;
  /** Persistence file (default: <projectRoot>/data/paper-state.json) */
  stateFile?: string;
  /** Live orderbook provider (e.g. MarketService.getTokenOrderbook) */
  getOrderbook: (tokenId: string) => Promise<Orderbook>;
  /** Market metadata provider (used for settlement + outcome labels) */
  getMarket?: (conditionId: string) => Promise<{
    closed?: boolean;
    question?: string;
    tokens?: Array<{ tokenId: string; outcome: string; winner?: boolean; price?: number }>;
  } | null>;
  /** Log sink (wired to the dashboard logger) */
  logger?: (level: string, message: string, data?: unknown) => void;
}

export interface PaperMarketOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  /** BUY: USDC amount. SELL: number of shares. */
  amount: number;
  /** Optional limit/slippage bound: max price for BUY, min price for SELL */
  price?: number;
  orderType?: 'FOK' | 'FAK';
  conditionId?: string;
  source?: string;
}

export interface PaperLimitOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
  conditionId?: string;
  source?: string;
}

export interface PaperOrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
}

export interface PaperPosition {
  tokenId: string;
  conditionId: string;
  outcome: string;
  shares: number;
  avgCost: number;
  openedAt: number;
}

interface PaperLimitOrder {
  orderId: string;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  createdAt: number;
}

interface PaperTrade {
  id: string;
  timestamp: number;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  shares: number;
  avgPrice: number;
  usdcDelta: number;
  gasUsd: number;
  realizedPnl: number;
  source?: string;
}

interface PersistedState {
  version: number;
  usdc: number;
  matic: number;
  positions: PaperPosition[];
  openOrders: PaperLimitOrder[];
  trades: PaperTrade[];
  totals: { realizedPnl: number; fills: number; gasPaid: number; volume: number };
  orderCounter: number;
  updatedAt: number;
}

export class PaperTradingEngine {
  private startingUsdc: number;
  private startingMatic: number;
  private gasPerFillUsd: number;
  private stateFile: string;
  private getOrderbook: (tokenId: string) => Promise<Orderbook>;
  private getMarket?: PaperEngineConfig['getMarket'];
  private logger: (level: string, message: string, data?: unknown) => void;

  private usdc: number;
  private matic: number;
  private positions = new Map<string, PaperPosition>();
  private openOrders = new Map<string, PaperLimitOrder>();
  private trades: PaperTrade[] = [];
  private tokenMeta = new Map<string, { conditionId: string; outcome?: string }>();
  private totals = { realizedPnl: 0, fills: 0, gasPaid: 0, volume: 0 };
  private orderCounter = 0;
  private tradeCounter = 0;

  /** Short-TTL book cache so bursts of orders share one REST book fetch */
  private bookCache = new Map<string, { book: Orderbook; at: number }>();
  private bookCacheTtlMs = 1000;

  private settlementTimer: ReturnType<typeof setInterval> | null = null;
  private matchTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(config: PaperEngineConfig) {
    if (!config.getOrderbook) {
      throw new Error('PaperTradingEngine requires a getOrderbook provider');
    }
    this.startingUsdc = config.startingUsdc ?? 250;
    this.startingMatic = config.startingMatic ?? 10;
    this.gasPerFillUsd = config.gasPerFillUsd ?? 0.03;
    this.stateFile = config.stateFile || join(__dirname, '../../data/paper-state.json');
    this.getOrderbook = config.getOrderbook;
    this.getMarket = config.getMarket;
    this.logger = config.logger || ((level, message) => console.log(`[PaperEngine][${level}] ${message}`));

    this.usdc = this.startingUsdc;
    this.matic = this.startingMatic;

    this.load();
    this.startMonitors();

    const loaded = this.totals.fills > 0;
    this.log('INFO', loaded
      ? `Wallet restored: $${this.usdc.toFixed(2)} USDC.e · ${this.matic} MATIC · ${this.positions.size} positions · ${this.totals.fills} lifetime fills`
      : `Wallet seeded: $${this.usdc.toFixed(2)} USDC.e · ${this.matic} MATIC (virtual)`);
  }

  // ==========================================================================
  // Public API (mirrors TradingService semantics)
  // ==========================================================================

  setLogger(logger: (level: string, message: string, data?: unknown) => void): void {
    this.logger = logger;
  }

  getBalances(): { usdc: number; matic: number } {
    return { usdc: this.round2(this.usdc), matic: this.round2(this.matic) };
  }

  getPositions(): PaperPosition[] {
    return [...this.positions.values()].map(p => ({ ...p }));
  }

  getOpenOrders(): Array<{
    id: string; status: string; tokenId: string; side: 'BUY' | 'SELL';
    price: number; originalSize: number; filledSize: number; remainingSize: number;
    associateTrades: string[]; createdAt: number;
  }> {
    return [...this.openOrders.values()].map(o => ({
      id: o.orderId,
      status: 'live',
      tokenId: o.tokenId,
      side: o.side,
      price: o.price,
      originalSize: o.size,
      filledSize: 0,
      remainingSize: o.size,
      associateTrades: [],
      createdAt: o.createdAt,
    }));
  }

  getTrades(): Array<{ id: string; tokenId: string; side: 'BUY' | 'SELL'; price: number; size: number; fee: number; timestamp: number }> {
    return this.trades.slice(0, 100).map(t => ({
      id: t.id,
      tokenId: t.tokenId,
      side: t.side,
      price: t.avgPrice,
      size: t.shares,
      fee: 0,
      timestamp: t.timestamp,
    }));
  }

  snapshot(): {
    balances: { usdc: number; matic: number };
    realizedPnl: number; unrealizedPnl: number; fills: number; volume: number;
    gasPaid: number; openPositions: number; openOrders: number; lifetimeTrades: number;
  } {
    return {
      balances: this.getBalances(),
      realizedPnl: this.round2(this.totals.realizedPnl),
      unrealizedPnl: this.round2(this.computeUnrealizedPnl()),
      fills: this.totals.fills,
      volume: this.round2(this.totals.volume),
      gasPaid: this.round2(this.totals.gasPaid),
      openPositions: this.positions.size,
      openOrders: this.openOrders.size,
      lifetimeTrades: this.trades.length,
    };
  }

  /** Remember token → market mapping (used for settlement + labels) */
  rememberToken(tokenId: string, conditionId: string, outcome?: string): void {
    if (!tokenId || !conditionId) return;
    this.tokenMeta.set(tokenId, { conditionId, outcome: outcome || this.tokenMeta.get(tokenId)?.outcome });
  }

  reset(): void {
    this.usdc = this.startingUsdc;
    this.matic = this.startingMatic;
    this.positions.clear();
    this.openOrders.clear();
    this.trades = [];
    this.totals = { realizedPnl: 0, fills: 0, gasPaid: 0, volume: 0 };
    this.orderCounter = 0;
    this.tradeCounter = 0;
    this.persist();
    this.log('WARN', `Paper wallet reset to $${this.startingUsdc}`);
  }

  // ==========================================================================
  // Orders
  // ==========================================================================

  async submitMarketOrder(p: PaperMarketOrderParams): Promise<PaperOrderResult> {
    if (!p.tokenId) return { success: false, errorMsg: 'Missing tokenId' };
    if (!(p.amount > 0)) return { success: false, errorMsg: 'Order amount must be positive' };

    // Mirror the real TradingService minimum check exactly
    if (p.amount < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order amount ($${p.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const orderType = p.orderType || 'FOK';

    try {
      if (p.side === 'BUY') {
        return await this.fillMarketBuy(p, orderType);
      }
      return await this.fillMarketSell(p, orderType);
    } catch (err) {
      return { success: false, errorMsg: `Paper order failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async submitLimitOrder(p: PaperLimitOrderParams): Promise<PaperOrderResult> {
    // Mirror real minimums: 5 shares and $1 notional
    if (p.size < 5) {
      return { success: false, errorMsg: `Order size (${p.size}) is below Polymarket minimum (5 shares)` };
    }
    const orderValue = p.price * p.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }
    if (p.price <= 0 || p.price >= 1) {
      return { success: false, errorMsg: `Price ${p.price} must be between 0 and 1` };
    }

    try {
      const book = await this.getBook(p.tokenId);
      const crossing = p.side === 'BUY'
        ? (book.asks[0]?.price ?? 1) <= p.price
        : (book.bids[0]?.price ?? 0) >= p.price;

      if (crossing) {
        // Marketable limit: fill immediately at book prices bounded by the limit
        const marketLike: PaperMarketOrderParams = {
          tokenId: p.tokenId,
          side: p.side,
          amount: p.side === 'BUY' ? p.size * p.price : p.size,
          price: p.price,
          orderType: 'FAK',
          conditionId: p.conditionId,
          source: p.source,
        };
        if (p.side === 'SELL') {
          // convert to exact-share sell by walking manually with size cap
          return await this.fillMarketSell({ ...marketLike, amount: p.size }, 'FAK');
        }
        return await this.fillMarketBuy(marketLike, 'FAK');
      }

      // Rest the order
      const orderId = this.nextOrderId();
      this.openOrders.set(orderId, {
        orderId,
        tokenId: p.tokenId,
        conditionId: p.conditionId || this.tokenMeta.get(p.tokenId)?.conditionId || '',
        side: p.side,
        price: p.price,
        size: p.size,
        createdAt: Date.now(),
      });
      this.persist();
      this.log('INFO', `LIMIT ${p.side} ${p.size} @ $${p.price} resting (paper)`, { orderId });
      return { success: true, orderId };
    } catch (err) {
      return { success: false, errorMsg: `Paper limit order failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async cancelOrder(orderId: string): Promise<PaperOrderResult> {
    if (this.openOrders.delete(orderId)) {
      this.persist();
      this.log('INFO', `Canceled paper order ${orderId}`);
      return { success: true, orderId };
    }
    return { success: false, orderId, errorMsg: 'Order not found (paper)' };
  }

  async cancelOrders(orderIds: string[]): Promise<PaperOrderResult> {
    let canceled = 0;
    for (const id of orderIds) {
      if (this.openOrders.delete(id)) canceled++;
    }
    this.persist();
    return { success: true, orderIds, errorMsg: canceled === orderIds.length ? undefined : `${canceled}/${orderIds.length} canceled` };
  }

  async cancelAllOrders(): Promise<PaperOrderResult> {
    const n = this.openOrders.size;
    this.openOrders.clear();
    this.persist();
    this.log('INFO', `Canceled all paper orders (${n})`);
    return { success: true };
  }

  // ==========================================================================
  // Fill engines
  // ==========================================================================

  private async fillMarketBuy(p: PaperMarketOrderParams, orderType: 'FOK' | 'FAK'): Promise<PaperOrderResult> {
    const spendTarget = p.amount;
    if (this.usdc < spendTarget + this.gasPerFillUsd) {
      return {
        success: false,
        errorMsg: `Insufficient paper USDC.e: have $${this.usdc.toFixed(2)}, need $${(spendTarget + this.gasPerFillUsd).toFixed(2)}`,
      };
    }

    const book = await this.getBook(p.tokenId);
    const limit = typeof p.price === 'number' && p.price > 0 ? p.price : Number.POSITIVE_INFINITY;

    let spend = 0;
    let shares = 0;
    for (const level of book.asks) {
      if (level.price > limit) break;
      const remainingUsdc = spendTarget - spend;
      if (remainingUsdc <= 1e-9) break;
      const levelCost = level.price * level.size;
      const takeUsdc = Math.min(remainingUsdc, levelCost);
      spend += takeUsdc;
      shares += takeUsdc / level.price;
      if (spend >= spendTarget - 1e-9) break;
    }

    const fullyFilled = spend >= spendTarget - 1e-6;
    if (orderType === 'FOK' && !fullyFilled) {
      return {
        success: false,
        errorMsg: `Insufficient ask depth to fill $${spendTarget.toFixed(2)} (FOK): only $${spend.toFixed(2)} available${typeof p.price === 'number' ? ` within $${p.price}` : ''}`,
      };
    }
    if (orderType === 'FAK' && spend <= 0) {
      return { success: false, errorMsg: 'No liquidity at or below limit price (FAK)' };
    }

    shares = roundSize(shares);
    if (shares <= 0 || spend <= 0) {
      return { success: false, errorMsg: 'No fillable liquidity (paper)' };
    }
    const avgPrice = spend / shares;

    // Apply balances
    this.usdc -= spend + this.gasPerFillUsd;
    this.totals.gasPaid += this.gasPerFillUsd;
    this.totals.volume += spend;
    this.totals.fills += 1;

    const existing = this.positions.get(p.tokenId);
    if (existing) {
      const totalShares = existing.shares + shares;
      existing.avgCost = (existing.avgCost * existing.shares + spend) / totalShares;
      existing.shares = totalShares;
    } else {
      const meta = this.tokenMeta.get(p.tokenId);
      this.positions.set(p.tokenId, {
        tokenId: p.tokenId,
        conditionId: p.conditionId || meta?.conditionId || '',
        outcome: meta?.outcome || '',
        shares,
        avgCost: avgPrice,
        openedAt: Date.now(),
      });
    }

    this.recordTrade(p, orderType, shares, avgPrice, -(spend + this.gasPerFillUsd));
    this.persist();

    this.log('FILL' as string, `BUY ${shares} @ $${avgPrice.toFixed(4)} for $${spend.toFixed(2)} (paper)`, {
      tokenId: p.tokenId.slice(0, 14) + '…',
      source: p.source || 'manual',
    });

    return { success: true, orderId: this.nextOrderId(), transactionHashes: [] };
  }

  private async fillMarketSell(p: PaperMarketOrderParams, orderType: 'FOK' | 'FAK'): Promise<PaperOrderResult> {
    const sharesTarget = roundSize(p.amount);
    const position = this.positions.get(p.tokenId);
    if (!position || position.shares <= 0) {
      return { success: false, errorMsg: 'No paper position to sell for this token' };
    }
    const sellable = Math.min(sharesTarget, position.shares);
    if (sellable <= 0) {
      return { success: false, errorMsg: 'Nothing to sell (paper)' };
    }

    const book = await this.getBook(p.tokenId);
    const limit = typeof p.price === 'number' && p.price > 0 ? p.price : 0;

    let filled = 0;
    let proceeds = 0;
    for (const level of book.bids) {
      if (level.price < limit) break;
      const remaining = sellable - filled;
      if (remaining <= 1e-9) break;
      const take = Math.min(remaining, level.size);
      filled += take;
      proceeds += take * level.price;
      if (filled >= sellable - 1e-9) break;
    }

    const fullyFilled = filled >= sellable - 1e-6;
    if (orderType === 'FOK' && !fullyFilled) {
      return {
        success: false,
        errorMsg: `Insufficient bid depth to sell ${sellable} shares (FOK): only ${filled.toFixed(2)} available${typeof p.price === 'number' ? ` at ≥ $${p.price}` : ''}`,
      };
    }
    if (filled <= 0) {
      return { success: false, errorMsg: 'No bid liquidity (paper)' };
    }

    const avgPrice = proceeds / filled;

    // Sanity guard mirroring the real $1 minimum order value on proceeds
    if (proceeds < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${proceeds.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    // Apply balances + realized PnL
    const costBasis = avgPrice * 0; // avg cost applied per-share below
    const realizedPnl = (avgPrice - position.avgCost) * filled;
    this.usdc += proceeds - this.gasPerFillUsd;
    this.totals.gasPaid += this.gasPerFillUsd;
    this.totals.volume += proceeds;
    this.totals.fills += 1;
    this.totals.realizedPnl += realizedPnl;

    position.shares = roundSize(position.shares - filled);
    if (position.shares <= 0) {
      this.positions.delete(p.tokenId);
    }
    void costBasis;

    this.recordTrade(p, orderType, filled, avgPrice, proceeds - this.gasPerFillUsd, realizedPnl);
    this.persist();

    this.log('FILL' as string, `SELL ${filled} @ $${avgPrice.toFixed(4)} for $${proceeds.toFixed(2)} · PnL ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)} (paper)`, {
      tokenId: p.tokenId.slice(0, 14) + '…',
      source: p.source || 'manual',
    });

    return { success: true, orderId: this.nextOrderId(), transactionHashes: [] };
  }

  // ==========================================================================
  // Monitors: resting-limit matching + settlement
  // ==========================================================================

  private startMonitors(): void {
    this.settlementTimer = setInterval(() => {
      this.settleResolvedMarkets().catch(() => { /* quiet tick */ });
    }, 60_000);
    this.matchTimer = setInterval(() => {
      this.matchOpenOrders().catch(() => { /* quiet tick */ });
    }, 30_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.settlementTimer) { clearInterval(this.settlementTimer); this.settlementTimer = null; }
    if (this.matchTimer) { clearInterval(this.matchTimer); this.matchTimer = null; }
    this.persist();
  }

  private async matchOpenOrders(): Promise<void> {
    if (this.stopped || this.openOrders.size === 0) return;
    for (const order of [...this.openOrders.values()]) {
      try {
        const book = await this.getBook(order.tokenId, true);
        const bestAsk = book.asks[0]?.price ?? 1;
        const bestBid = book.bids[0]?.price ?? 0;
        const crossed = order.side === 'BUY' ? bestAsk <= order.price : bestBid >= order.price;
        if (!crossed) continue;

        if (order.side === 'BUY') {
          const res = await this.fillMarketBuy({
            tokenId: order.tokenId, side: 'BUY', amount: order.size * order.price,
            price: order.price, orderType: 'FAK', conditionId: order.conditionId, source: 'paper-limit',
          }, 'FAK');
          if (res.success) this.openOrders.delete(order.orderId);
        } else {
          const res = await this.fillMarketSell({
            tokenId: order.tokenId, side: 'SELL', amount: order.size,
            price: order.price, orderType: 'FAK', conditionId: order.conditionId, source: 'paper-limit',
          }, 'FAK');
          if (res.success) this.openOrders.delete(order.orderId);
        }
        this.persist();
      } catch {
        // keep order; retry next tick
      }
    }
  }

  private async settleResolvedMarkets(): Promise<void> {
    if (this.stopped || !this.getMarket || this.positions.size === 0) return;

    const conditionIds = new Set<string>();
    for (const pos of this.positions.values()) {
      if (pos.conditionId) conditionIds.add(pos.conditionId);
    }

    for (const conditionId of conditionIds) {
      try {
        const market = await this.getMarket(conditionId);
        if (!market || !market.closed || !market.tokens) continue;

        for (const pos of [...this.positions.values()].filter(pp => pp.conditionId === conditionId)) {
          const token = market.tokens.find(t => t.tokenId === pos.tokenId);
          if (!token) continue;

          const won = token.winner === true;
          const payout = won ? pos.shares * 1 : 0;
          const gas = this.gasPerFillUsd; // simulated redeem tx
          this.usdc += payout - gas;
          this.totals.gasPaid += gas;
          this.totals.realizedPnl += payout - pos.avgCost * pos.shares - gas;
          this.positions.delete(pos.tokenId);
          this.totals.fills += 1;

          this.log(won ? 'TRADE' : 'INFO',
            `SETTLED ${won ? 'WON' : 'LOST'}: ${pos.shares} ${pos.outcome || ''} shares → $${payout.toFixed(2)} (paper)`,
            { conditionId: conditionId.slice(0, 14) + '…', question: market.question });
        }
        this.persist();
      } catch {
        // market not resolvable yet; retry next tick
      }
    }
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private computeUnrealizedPnl(): number {
    // Based on last known fill/book prices when available (kept simple)
    let pnl = 0;
    for (const pos of this.positions.values()) {
      const cached = this.bookCache.get(pos.tokenId)?.book;
      if (cached) {
        const bid = cached.bids[0]?.price ?? pos.avgCost;
        pnl += (bid - pos.avgCost) * pos.shares;
      }
    }
    return pnl;
  }

  private async getBook(tokenId: string, force = false): Promise<Orderbook> {
    const cached = this.bookCache.get(tokenId);
    if (!force && cached && Date.now() - cached.at < this.bookCacheTtlMs) {
      return cached.book;
    }
    const book = await this.getOrderbook(tokenId);
    this.bookCache.set(tokenId, { book, at: Date.now() });
    return book;
  }

  private recordTrade(
    p: { tokenId: string; side: 'BUY' | 'SELL'; conditionId?: string; source?: string },
    orderType: string,
    shares: number,
    avgPrice: number,
    usdcDelta: number,
    realizedPnl = 0,
  ): void {
    this.tradeCounter += 1;
    const meta = this.tokenMeta.get(p.tokenId);
    this.trades.unshift({
      id: `paper_${Date.now()}_${this.tradeCounter}`,
      timestamp: Date.now(),
      tokenId: p.tokenId,
      conditionId: p.conditionId || meta?.conditionId || '',
      side: p.side,
      orderType,
      shares,
      avgPrice,
      usdcDelta,
      gasUsd: this.gasPerFillUsd,
      realizedPnl,
      source: p.source,
    });
    if (this.trades.length > 500) this.trades.length = 500;
  }

  private nextOrderId(): string {
    this.orderCounter += 1;
    return `paper_${this.orderCounter}_${Date.now().toString(36)}`;
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private log(level: string, message: string, data?: unknown): void {
    this.logger(level, message, data);
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  private persist(): void {
    try {
      const dir = dirname(this.stateFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const state: PersistedState = {
        version: 1,
        usdc: this.usdc,
        matic: this.matic,
        positions: [...this.positions.values()],
        openOrders: [...this.openOrders.values()],
        trades: this.trades.slice(0, 500),
        totals: this.totals,
        orderCounter: this.orderCounter,
        updatedAt: Date.now(),
      };
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, this.stateFile);
    } catch (err) {
      this.log('WARN', `Failed to persist paper state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.stateFile)) return;
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf-8')) as PersistedState;
      if (!raw || typeof raw.usdc !== 'number') return;
      this.usdc = raw.usdc;
      this.matic = typeof raw.matic === 'number' ? raw.matic : this.startingMatic;
      this.positions = new Map((raw.positions || []).map(p => [p.tokenId, p]));
      this.openOrders = new Map((raw.openOrders || []).map(o => [o.orderId, o]));
      this.trades = raw.trades || [];
      this.totals = raw.totals || this.totals;
      this.orderCounter = raw.orderCounter || 0;
    } catch (err) {
      this.log('WARN', `Could not load paper state, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
