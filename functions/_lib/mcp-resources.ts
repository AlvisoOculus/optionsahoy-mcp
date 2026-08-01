// AlphaLatitude Inc. © 2026
//
// MCP resource definitions. Each resource is a short markdown briefing on
// one equity-compensation topic, mirrored 1:1 with a cornerstone article on
// optionsahoy.com/learn and the matching calculator tool. The MCP server
// exposes these via resources/list (metadata) and resources/read (content).
//
// The bodies are intentionally compact (~400-600 words). They give an LLM
// enough grounding to discuss the topic and pick the right tool. For full
// prose, the URI links to the published article.

import { tickerCoverage } from '../../lib/data/ticker-coverage';

export type McpResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: 'text/markdown';
  contents: string;
};

const ARTICLE_BASE = 'https://optionsahoy.com/learn';

// The covered-tickers resource is generated at module load from the actual
// resolvability of the bundled snapshots (see lib/data/ticker-coverage), NOT
// from coveredTickers() membership: that array lists every trailing-returns
// key, including recent IPOs that resolve no growth. Enumerating by bucket
// here gives agents the accurate, in-band answer to "which symbols can I pass,
// and what does each resolve" so they stop trusting the looser descriptor list.
const COVERED_TICKERS_URI = 'https://optionsahoy.com/tools/covered-tickers';
const COVERED_TICKERS_DESC =
  'The public-stock symbols the optional `ticker` shortcut resolves, split by whether each resolves expected growth, volatility, or both. Symbols outside these lists need the numeric fields supplied directly.';

function buildCoveredTickersResource(): McpResource {
  // Built at module load from the bundled snapshots. A malformed ETL snapshot
  // must not throw out of the RESOURCES initializer and black out resources/list
  // for every resource, so fall back to a static pointer on any failure.
  let c: ReturnType<typeof tickerCoverage>;
  try {
    c = tickerCoverage();
  } catch {
    return {
      uri: COVERED_TICKERS_URI,
      name: 'Covered tickers for the optional ticker shortcut (growth and volatility)',
      description: COVERED_TICKERS_DESC,
      mimeType: 'text/markdown',
      contents: `# Covered tickers for the ticker shortcut\n\nThe per-symbol coverage list is temporarily unavailable. Pass a covered public-stock symbol and the growth tools resolve expected growth and volatility from bundled data; an uncovered symbol returns a required-field error naming the field to supply.\n`,
    };
  }
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : '(none)');
  const growthTotal = c.growthAndVol.length + c.growthOnly.length;
  const volTotal = c.growthAndVol.length + c.volOnly.length;
  return {
    uri: COVERED_TICKERS_URI,
    name: 'Covered tickers for the optional ticker shortcut (growth and volatility)',
    description: COVERED_TICKERS_DESC,
    mimeType: 'text/markdown',
    contents: `# Covered tickers for the ticker shortcut

The growth-bearing tools (amt_iso_optimize, nso_calculate, rsu_sell_vs_hold, concentration_analyze) and protective_put_price accept an optional \`ticker\`. When it is a covered symbol, the tool resolves expected growth from a bundled trailing-return snapshot and volatility from a bundled implied-volatility snapshot, so you do not have to supply those numbers. equity_funding_plan also accepts a per-stack \`ticker\`, which resolves that stack's expected growth the same way (it does not resolve volatility from the ticker). A symbol a given tool cannot resolve for the field it needs returns a required-field error naming that field; pass the field explicitly in that case.

Two independent snapshots back the shortcut, so coverage differs by field: ${growthTotal} symbols resolve expected growth, ${volTotal} resolve volatility, and ${c.growthAndVol.length} resolve both. The lists below are generated from the bundled data and can change between deploys, so treat them as the current set rather than a fixed roster.

## Resolves both growth and volatility (${c.growthAndVol.length})

Pass \`ticker\` alone; no growth or volatility number is needed.

${list(c.growthAndVol)}

## Resolves growth only (${c.growthOnly.length})

These resolve expected growth but not volatility. Supply \`volatility\` if a growth tool returns a required-field error naming it. protective_put_price is unaffected: it falls back to a sector-typical volatility.

${list(c.growthOnly)}

## Resolves volatility only (${c.volOnly.length})

Useful for protective_put_price on ticker alone; on the growth tools, supply the expected-return or sale-price field yourself.

${list(c.volOnly)}

Any symbol not listed above is not covered: pass the numeric growth and volatility fields directly instead of a ticker. Share-class aliases resolve to their listed class (for example GOOG resolves as GOOGL). The GET https://optionsahoy.com/mcp descriptor also carries a \`coveredTickers\` array, but it is a looser superset that includes those aliases and symbols resolving neither field, so prefer the buckets here.
`,
  };
}

export const RESOURCES: McpResource[] = [
  {
    uri: `${ARTICLE_BASE}/amt-crossover`,
    name: 'ISO Alternative Minimum Tax (AMT) crossover and four expensive mistakes',
    description:
      'Why a single-year ISO exercise can produce a six-figure AMT bill in cash before any shares are sold, and how multi-year scheduling, state AMT, and the calendar boundary change the answer. Pair with amt_iso_optimize.',
    mimeType: 'text/markdown',
    contents: `# ISO/AMT crossover and four expensive mistakes

Exercising incentive stock options (ISOs) creates a "bargain element" equal to (fair market value - strike) x shares. This bargain element is invisible to regular federal income tax but counts as ordinary income for the federal Alternative Minimum Tax (AMT). AMT is owed in cash with your return the following April 15 (and often through quarterly estimated payments during the year to avoid underpayment penalties), even if you never sold a share. State AMT applies separately in California, Minnesota, Colorado, and Connecticut.

## The four most expensive mistakes

1. **Failing to plan the calendar.** A January RSU vest, a mid-year ISO exercise, and a December bonus compound in one tax year. Same logic at the day scale: December 30 vs January 2 lands in different tax years with potentially very different AMT bills.

2. **Ignoring state AMT.** A single filer in California with a $50,000 bargain element pays roughly $13K of federal AMT plus $3.5K of California AMT - a 33% effective rate. Federal-only models systematically underestimate the bill in CA, MN, CO, and CT.

3. **Missing the AMT credit recovery.** AMT paid generates a Minimum Tax Credit (Form 8801) usable against regular tax in future years. A multi-year schedule that exercises in years where you can recover the credit can dramatically reduce lifetime tax.

4. **Exercising past the grant-expiration window or post-termination cliff.** ISOs typically expire 10 years from grant. Leaving the company shrinks the exercise window to 90 days by default. Both deadlines override optimal tax timing if missed.

## Crossover concept

The "AMT crossover point" is the maximum number of shares you can exercise in a tax year before the tentative AMT exceeds the regular tax - the threshold at which the next ISO exercised starts incurring AMT at 26% federal (28% once your alternative minimum taxable income passes the upper breakpoint), plus state. Below the crossover, the bargain element is effectively free of AMT in that year. Above it, every additional share adds 26-28% federal (plus state) to the bill.

The crossover depends on filing status, ordinary income, state, deductions, and any other AMT preference items in the year. It moves year to year.

## What the amt_iso_optimize tool computes

The MCP tool \`amt_iso_optimize\` returns the best multi-year exercise schedule it finds, matching a brute-force maximum to the cent on the published tractable case. It searches over every reasonable per-year share count from year 1 through your chosen horizon (up to 10 years), accounting for:

- Federal regular tax brackets and AMT brackets (2026 inflation-adjusted)
- State regular tax and state AMT in all 50 states + DC
- AMT credit accrual and recovery across years
- Grant-expiration date and post-termination exercise window
- Expected growth rate and volatility drag on held shares
- Cash return rate on tax savings reinvested

Output includes the recommended per-year share count, per-year tax breakdown (federal regular, federal AMT, state, AMT credit used), and net final value vs lump-sum and even-split baselines.

Full article: ${ARTICLE_BASE}/amt-crossover
`,
  },
  {
    uri: `${ARTICLE_BASE}/nso-sell-vs-hold`,
    name: 'Non-qualified stock options (NSOs): sell-at-exercise vs hold-for-LTCG',
    description:
      'When holding NSO shares past exercise for long-term capital gains beats selling immediately, and the six common mistakes that erase the gain. Pair with nso_calculate.',
    mimeType: 'text/markdown',
    contents: `# NSO sell-vs-hold and six common mistakes

A non-qualified stock option (NSO) exercise produces ordinary income on the spread between fair market value and strike, taxed at your marginal rate plus FICA (Social Security + Medicare + Additional Medicare). Two routes after that:

- **Sell at exercise** - lock in the after-tax proceeds, no further market risk.
- **Hold for long-term capital gains (LTCG)** - sell 12+ months later. Any gain above the FMV at exercise is taxed at LTCG rates (0%, 15%, or 20% federal + Net Investment Income Tax). Any loss below the FMV at exercise is a capital loss.

The hold case wins when the stock rises enough that the LTCG-vs-ordinary spread on the gain exceeds the opportunity cost and concentration risk of holding.

## The six common mistakes

1. **Wrong cost basis at sale.** Brokerage 1099-B forms may report only your strike price as basis, not the FMV at exercise (the latter is correct). Filing without an 8949 correction double-taxes the ordinary-income portion.

2. **Underestimating FICA.** Social Security (6.2% up to the $184,500 wage base for 2026), Medicare (1.45%), and Additional Medicare (0.9% above $200K single / $250K joint) all apply to the NSO spread on top of federal and state income tax.

3. **Sell-to-cover vs cash exercise.** Sell-to-cover liquidates enough shares at exercise to fund the tax. Cash exercise uses outside cash and keeps more shares. The right choice depends on liquidity and concentration tolerance, not on which the brokerage default suggests.

4. **Ignoring state tax on the spread.** NSO income is state-taxable in the state where the work was performed during the vesting period, not where you live at exercise. Multi-state employees face apportionment.

5. **Holding for LTCG when the holding-period math doesn't justify it.** At a 35% federal marginal rate, the federal long-term-vs-ordinary spread is 35% - 20% = 15 points on the post-exercise appreciation. But that saving applies only to the gain, while a price drop hits the whole position, so the two are not interchangeable. The tool reports the break-even sale price at which holding actually beats selling.

6. **Forgetting concentration risk.** Holding NSO shares concentrates wealth in a single stock. Most single stocks underperform the broad market over multi-year periods; the optimal hedge is often selling and diversifying, not holding for tax savings.

## What the nso_calculate tool computes

The MCP tool \`nso_calculate\` returns after-tax payouts for both sell-at-exercise and hold-for-LTCG paths under your chosen horizon. It accounts for:

- Federal ordinary brackets and LTCG brackets (single, joint, head-of-household, MFS)
- All 50 states + DC, with state LTCG treatment
- FICA (Social Security + Medicare + Additional Medicare)
- Net Investment Income Tax (3.8% on investment income above $200K/$250K)
- Sell-to-cover vs cash funding
- Expected sale price haircut and broad-market opportunity cost

Output includes the recommendation, dollar-precise after-tax payout under each route, and the break-even sale price at which hold beats sell.

Full article: ${ARTICLE_BASE}/nso-sell-vs-hold
`,
  },
  {
    uri: `${ARTICLE_BASE}/rsu-withholding-gap`,
    name: 'The RSU withholding gap and five April surprises',
    description:
      'Why employer 22% RSU withholding under-withholds for most tech employees, and the five recurring mistakes that turn the gap into a six-figure April surprise. Pair with rsu_sell_vs_hold.',
    mimeType: 'text/markdown',
    contents: `# The RSU withholding gap and five April surprises

A restricted stock unit (RSU) vest is ordinary income equal to (shares vested) x (FMV on vest date). Your employer withholds federal tax on that income at the IRS supplemental rate: 22% for amounts up to $1M, 37% above that. Most tech employees in concentrated equity-comp situations land in the 32% or 35% marginal bracket. The gap between 22% and 32-35% shows up as an April underpayment.

A single filer earning $300K total compensation with $50K of RSU vest in a year is missing about $5,000-7,500 of federal withholding by default, before considering state, NIIT, or FICA.

## The five common mistakes

1. **Assuming the W-2 withholding is "enough."** It rarely is at 22%. Most equity holders need to either submit a W-4 adjustment or make a quarterly estimated payment to avoid Form 2210 underpayment penalties.

2. **Missing state withholding gaps.** Employers withhold state tax on RSU vests at flat supplemental rates that often under-withhold for the actual marginal bracket. California's 10.23% supplemental rate is the most-cited example.

3. **Holding shares past vest without a strategy.** The post-vest "hold" decision is identical to the NSO sell-vs-hold decision: the FMV at vest is your basis. Any further appreciation is short-term capital gains (your ordinary rate) if sold within 12 months, long-term capital gains otherwise. Holding for LTCG saves federal tax but introduces single-stock risk.

4. **Selling at-vest into a wash-sale loss.** Selling shares to cover the withholding tax can trigger wash-sale rules if you also have a tax-loss harvest in the same stock within 30 days.

5. **Concentration creep.** Each quarterly vest adds to the single-stock position. Equity holders who don't sell-to-diversify at-vest accumulate concentration without an explicit decision to do so.

## Sell-at-vest vs hold-for-LTCG

At-vest sale: you receive the after-tax cash immediately. No further market exposure.

Hold for LTCG: you wait 12 months from the vest date. If the stock rises, you owe LTCG (federal 15-20% + NIIT 3.8% + state) on the gain instead of ordinary rates. If it falls, the loss is short-term capital loss for the first 12 months. Holding only beats selling when the expected gain is large enough to overcome the concentration risk and opportunity cost vs the broad market.

## What the rsu_sell_vs_hold tool computes

The MCP tool \`rsu_sell_vs_hold\` returns after-tax payouts for both paths. It accounts for:

- Federal ordinary and LTCG brackets (2026 inflation-adjusted)
- All 50 states + DC
- FICA + Net Investment Income Tax
- The 12-month short-term cliff
- Volatility drag on the held position
- Broad-market opportunity cost via expected market return

Output: per-route after-tax dollar payout, break-even sale price, and the recommendation given the inputs.

Full article: ${ARTICLE_BASE}/rsu-withholding-gap
`,
  },
  {
    uri: `${ARTICLE_BASE}/single-stock-concentration-risk`,
    name: 'Single-stock concentration risk and the diversification trade-off',
    description:
      'Why the top ~4% of stocks have historically created all net wealth while most lag T-bills, the after-tax cost of de-concentrating, and the five common mistakes equity holders make. Pair with concentration_analyze.',
    mimeType: 'text/markdown',
    contents: `# Single-stock concentration risk

Bessembinder (2018) found that just over half of US public stocks underperformed one-month Treasury bills over their lifetimes, and that the entire net wealth creation of the market traced to the top ~4% of stocks; the other ~96% collectively only matched T-bills. The aggregate equity premium is driven by a small tail of winners, so a single stock is far more likely to be a laggard than a winner. This is the foundation of the de-concentration argument.

For equity-compensation holders, the concentration is rarely deliberate. It accumulates through ISO/NSO/RSU vests and exercises, then gets entrenched by tax-cost inertia: selling triggers capital gains tax, and the next vest adds to the position before the prior one is fully diversified.

## The five common mistakes

1. **Anchoring on "my stock is different."** Survivorship bias is strong - the 4% of winners are everywhere in tech culture. The base rate is the other 96%.

2. **Letting the tax tail wag the dog.** A 20% federal LTCG bill (plus state and NIIT) is real money. But a 50% drawdown on a concentrated position is two-and-a-half times bigger. The right framing is: "what is the after-tax cost of de-concentrating vs the expected cost of staying concentrated?"

3. **Treating the holding as binary.** Sell-all-now vs hold-forever is a false choice. A multi-year sell-down (10-20% per year) spreads the capital gains across brackets and decorrelates from any single year's market level.

4. **Skipping hedges when sell-down isn't viable.** When concentration is constrained by lockup, basis, or tax cost, a protective put or zero-cost collar truncates the downside. See \`protective_put_price\` for pricing.

5. **Ignoring sector correlation.** Diversifying within tech is not diversification. A single tech stock paired with a tech-heavy index fund is typically highly correlated, so holding both is not real diversification.

## After-tax cost of de-concentrating

Selling $100K of a $400K position with $200K basis creates $50K of long-term capital gains. A single filer in CA in the 35% federal bracket pays:

- Federal LTCG: 20% x $50K = $10,000
- NIIT: 3.8% x $50K = $1,900
- California: 13.3% x $50K = $6,650
- Total: $18,550 (37% effective on the gain, 18.5% of the proceeds)

Compare that to the expected drawdown from holding: a one-standard-deviation move on a typical mid-cap tech stock is ~30%. The drawdown is much larger than the tax bill, and the drawdown can be repeated.

## What the concentration_analyze tool computes

The MCP tool \`concentration_analyze\` quantifies concentration risk and produces a sell-down vs hold vs hedge schedule. It accounts for:

- Position size, cost basis, holding period (LTCG eligibility)
- Sector (used for historical volatility default and broad-market correlation)
- Federal + state tax on the gain
- Expected position return vs expected market return
- Volatility drag (drawdown impact on compound growth)
- Optional hedge: protective put or zero-cost collar

Output: after-tax dollar value under each strategy (sell now, sell over N years, hold, hold-with-hedge), drawdown exposure at 30/50/70%, and the recommended path.

Full article: ${ARTICLE_BASE}/single-stock-concentration-risk
`,
  },
  {
    uri: `${ARTICLE_BASE}/zero-cost-collars`,
    name: 'Protective puts, zero-cost collars, and put spreads on a concentrated position',
    description:
      'How a protective put, zero-cost collar, or put spread truncates single-stock downside, what the protection actually costs in dollars and forgone upside, and seven common mistakes. Pair with protective_put_price.',
    mimeType: 'text/markdown',
    contents: `# Protective puts, zero-cost collars, and put spreads

A **protective put** is a long put option on a stock you own. If the stock falls below the strike, the put pays the difference. It is insurance: positive expected cost, negative expected return, but it truncates the left tail.

A **zero-cost collar** is a protective put plus a short call at a higher strike. The premium from selling the call funds the put. Net cash outlay at trade is roughly zero. The cost shows up as a cap on upside: any gain above the call strike is forfeited.

A **put spread** is a protective put plus a short put at a lower strike. The premium from selling the lower put reduces the cost of the floor, so it is cheaper than the bare put. The trade-off is a bottom: protection only holds between the two strikes, and below the short strike your losses resume dollar-for-dollar. Because it sells a put rather than a call, it caps nothing on the upside and needs no shares to write calls against, which makes it the one structure of the three that works on unexercised employee options (you cannot sell a covered call on shares you do not yet hold). Size the short strike by the probability you are willing to accept that the stock ends below it, not by a fixed distance.

Typical pricing for a 1-year 10%-out-of-the-money (OTM) put on a 30% implied-volatility stock: ~3% of position value, per year. Over 10 years compounding, that is ~26% of the position - paid for ongoing protection against a tail event.

## The seven common mistakes

1. **Treating "zero-cost" as free.** The premium isn't zero - it's paid in upside. On a stock that returns 25% in a year, a collar capped at +15% gave up 10 points of return for the put protection.

2. **Buying long-dated puts when short-dated rolling is cheaper.** Implied volatility term structure usually has the longest tenors most expensive. Rolling 3-month or 6-month puts can be cheaper than buying a 2-year, though it adds rebalancing complexity.

3. **Ignoring tax treatment.** A protective put on a long position can extend or restart the holding period under Section 1092 straddle rules. Section 1259 constructive-sale rules can trigger a deemed sale on a deep-in-the-money collar.

4. **Mismatched protection level and tenor.** A 30%-OTM 3-month put is cheap and almost worthless. A 5%-OTM 2-year put is expensive and over-insures.

5. **Hedging the wrong reference asset.** A position in a single small-cap stock is not hedged by SPY puts. The basis risk (stock-vs-index divergence) often exceeds the protection.

6. **Forgetting the right tail.** A collar that caps at +15% is fine if you expect ±10% moves. It is a disaster if the stock doubles - you cap a 100% gain at 15%.

7. **Using the broker's default strike grid.** The available strike-tenor combinations on a typical option chain are coarse. The optimal hedge may require multi-leg construction.

## What the protective_put_price tool computes

The MCP tool \`protective_put_price\` prices all three structures - a protective put, a zero-cost collar, and a put spread - against cached implied volatility (a sector-typical volatility when no ticker is supplied). It accounts for:

- Strike (defined as percentage below current price)
- Tenor (months to expiration)
- Sector default volatility, or user-supplied volatility
- Risk-free rate
- \`spreadRiskLevel\`: the probability the stock ends below the put spread's short strike (presets 1 in 5 / 10 / 20 / 100), which sets that short strike

Output: for each structure, annual cost as a percentage of position, dollar cost, max loss with hedge, upside cap (collar only), and bad-year coverage. The \`recommended\` field names the structure whose card carries no warning: the collar unless its cap binds too often, then the bare put unless it is expensive, then the put spread when one is cleanly priced. The put spread reports \`available: false\` only when the chosen risk level leaves no short strike worth selling below the floor, or the short leg does not reduce cost; render \`unavailableReason\` ('floor' or 'no-rebate') rather than the numbers in that case. A spread that is available but merely narrow (a thin protected band) or thin on rebate still returns numbers, and is simply not the recommended structure.

Full article: ${ARTICLE_BASE}/zero-cost-collars
`,
  },
  {
    uri: `${ARTICLE_BASE}/qsbs`,
    name: 'Qualified Small Business Stock (QSBS) and five ways to lose the exclusion',
    description:
      'How Section 1202 zeros out federal capital gains tax on $10-15M of stock gain, the six statutory tests, the OBBBA 2026 tiered exclusion, and five common disqualification traps. Pair with qsbs_check.',
    mimeType: 'text/markdown',
    contents: `# QSBS and five ways to lose the exclusion

Section 1202 of the Internal Revenue Code excludes from federal capital gains tax the first $10 million (or 10x basis, whichever is greater) of gain on Qualified Small Business Stock (QSBS) held for 5+ years. The One Big Beautiful Bill Act (OBBBA) introduced a tiered exclusion structure that expands the cap to $15M for stock acquired after July 4, 2025 and held 5+ years. Both the $15M per-issuer cap and the $75M gross-assets ceiling are indexed for inflation starting in 2027.

The exclusion is the single largest federal tax break available to founders and employees of early-stage C-corps. It is also conditional on six statutory tests, any one of which can disqualify the entire position.

## The six statutory tests

1. **Entity type.** Issuer must be a US C-corp at original issuance. LLCs and S-corps do not qualify.
2. **Acquisition method.** Stock must be acquired at original issuance directly from the corporation (cash, services, or property exchange). Secondary purchases do not qualify; gifts and inheritance transfer the holder's QSBS status.
3. **Holding period.** 5 years for the full (100%) exclusion. For stock acquired after July 4, 2025, OBBBA grants a tiered exclusion: 50% at 3 years, 75% at 4 years, 100% at 5 years.
4. **Gross assets cap.** Issuer's aggregate gross assets must not exceed $50M (pre-OBBBA) / $75M (post-OBBBA) at any point through the date of issuance and immediately after.
5. **Active business requirement.** Issuer must use 80%+ of assets in a qualified trade or business throughout substantially all of the holder's holding period.
6. **Industry exclusion.** Service businesses where the principal asset is employee reputation (law, accounting, consulting, finance, etc.), banking/insurance/financing, farming, extraction, and hospitality are disqualified.

Two further rules shape the dollar result rather than pass/fail qualification: the **per-issuer gain cap** (greater of $10M, or $15M for stock acquired after July 4, 2025, or 10x adjusted basis, per issuer per taxpayer) and the **working-capital limit** (working capital held for use in the business within 2 years counts toward the active-business test). The 50%/75%-era exclusions also carried a 7% AMT preference on the excluded gain; the 100% (post-2010) and OBBBA tiers do not.

## The five common mistakes

1. **Triggering a redemption.** A corporation buying back stock from any shareholder within 2 years before or after a QSBS issuance can disqualify the QSBS.
2. **LLC-to-C-corp conversion without QSBS-clock awareness.** The QSBS 5-year clock starts at the C-corp conversion, not the original LLC formation.
3. **Crossing the gross-assets cap.** A late-stage round that pushes gross assets above the cap disqualifies all subsequent issuances (not retroactive on prior issuances).
4. **Service-business industry classification.** Substance-over-form: a "tech" company whose main asset is consulting hours is treated as a service business.
5. **State non-conformity.** California, Alabama, Pennsylvania, and Mississippi do not conform to Section 1202, so state capital gains tax still applies even when federal is zeroed. New Jersey conforms for sales in 2026 and later; Hawaii and Massachusetts partially conform.

## What the qsbs_check tool computes

The MCP tool \`qsbs_check\` runs all six tests against your facts and computes the dollar exclusion. It accounts for:

- Entity type, acquisition date, sale date, acquisition method
- Asset category (under-50m, 50m-to-75m, over-75m)
- Industry classification with the disqualifying-services list
- Active-business attestation
- Adjusted basis (for 10x basis cap)
- State conformity (CA, AL, PA, MS non-conforming; NJ conforms 2026+; HI, MA partial)
- Filing status and ordinary income (for tax-saved calculation)

Output: verdict (qualifies / partial / too-soon / caveats / disqualified), exclusion percentage, dollar federal tax saved, state tax owed, and per-test pass/fail breakdown.

Full article: ${ARTICLE_BASE}/qsbs
`,
  },
  {
    uri: 'https://optionsahoy.com/tools/equity-funding',
    name: 'Selling equity to fund a cash goal: the after-tax sell-schedule problem',
    description:
      'Why "how many shares do I sell for $X after tax" is a multi-year scheduling problem, how holding period, lot selection, and shortfall risk change the answer, and the common mistakes. Pair with equity_funding_plan.',
    mimeType: 'text/markdown',
    contents: `# Selling equity to fund a cash goal

"I need $400K after tax in three years for a house down payment" sounds like division: target divided by share price. It is not. The cash that lands in your account is sale proceeds minus capital gains tax, and the tax depends on which lots you sell, how long each was held, your other income that year, and your state. Spread the sales across years and each year's tax is computed against that year's bracket stack. The result is a scheduling problem, not a division.

## What moves the answer

1. **Holding period per lot.** Shares held 12+ months get long-term capital gains rates (0/15/20% federal); shares sold earlier are taxed as ordinary income. A lot crossing the 12-month boundary between two candidate sale dates can change which year to sell it in.
2. **Lot selection.** High-basis lots produce less taxable gain per dollar of proceeds. Selling them first nets the target with fewer shares sold, but spends the lots that would shelter future sales.
3. **Bracket stacking.** Capital gains stack on top of ordinary income. Concentrating sales in one year can push gains from the 15% to the 20% federal bracket and trigger the 3.8% Net Investment Income Tax (NIIT); spreading them can keep each year below the thresholds.
4. **State tax.** California taxes capital gains as ordinary income (up to 13.3%); Texas and Florida tax them at zero. The state line can be larger than the federal difference between schedules.
5. **Price risk.** A schedule that sells later keeps more shares growing but risks a drawdown before the deadline. Whether that risk is acceptable depends on the position's volatility and your tolerance for missing the target.

## Common mistakes

1. **Dividing the target by today's price.** Ignores tax entirely; the shortfall surfaces at filing time.
2. **Selling everything in December.** One concentrated tax year at peak rates, when a January/December split would have used two years of brackets.
3. **Ignoring the 12-month cliff on recent grants.** Selling shares at month 11 converts a long-term gain into ordinary income for a few weeks of impatience.
4. **Treating the plan as risk-free.** Projected proceeds assume a growth path. A plan with no buffer and high volatility has a real chance of missing the target.

## What the equity_funding_plan tool computes

The MCP tool \`equity_funding_plan\` takes a target after-tax amount, a deadline, and one or more stacks (ticker, current price, cost-basis lots), plus ordinary income, filing status, and state. It searches candidate sell schedules and returns the one that nets the target with the most wealth remaining at the deadline, with full federal long-term/short-term capital gains, NIIT, and state tax (all 50 states + DC) computed per year, per lot.

Output: a year-by-year sell schedule with per-lot detail, plus a risk-aware comparison of named alternatives (Lock-in-now, Balanced, Hold-for-growth, and a Recommended plan whose chance of shortfall stays under your tolerance, using the position's option-implied volatility when a covered ticker is supplied).

Try it: https://optionsahoy.com/tools/equity-funding
`,
  },
  buildCoveredTickersResource(),
];
