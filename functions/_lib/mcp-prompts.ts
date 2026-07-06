// AlphaLatitude Inc. © 2026
//
// MCP prompt definitions. Each prompt is a templated user message that
// scaffolds a typical equity-compensation question and directs the model
// to invoke the corresponding calculator tool. Arguments hold the minimum
// inputs that materially change the answer; the model is instructed to
// ask for any other inputs it needs (filing status, state, ordinary
// income) before calling the tool.
//
// In Claude Desktop and ChatGPT, these surface as named slash-commands
// users can pick from. In an agent client, the LLM can list prompts to
// learn the available workflows.
//
// Argument names here are USER-FACING labels, not the calculator's API field
// names. Each `build()` renders them into a natural-language scenario; the model
// then extracts the tool's actual fields from that prose (e.g. the `state` arg
// becomes the `stateCode` field, and `plan-equity-funding`'s `shares` arg seeds
// the prose total while the instruction directs the model to gather per-lot
// `stacks`/`lots`). So an arg label need not match a parser field 1:1.

export type McpPromptArgument = {
  name: string;
  description: string;
  required: boolean;
};

export type McpPromptMessage = {
  role: 'user';
  content: { type: 'text'; text: string };
};

export type McpPrompt = {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
  build: (args: Record<string, string>) => McpPromptMessage[];
};

function arg(args: Record<string, string>, key: string): string {
  return args[key] ?? `<${key}>`;
}

// Shared template for every prompt body: scenario + optional clauses,
// followed by the "Use the X tool. If you need Y, ask one follow-up.
// Report Z." closing that all prompts share verbatim.
function templatePrompt(opts: {
  scenario: string;
  optional?: Array<string | false | undefined>;
  instruction: string;
  followUpFields: string;
  outputs: string;
}): McpPromptMessage[] {
  const optionalText = (opts.optional ?? []).filter(Boolean).join('');
  const text =
    opts.scenario +
    optionalText +
    opts.instruction +
    ` If you need ${opts.followUpFields}, ask me one short follow-up question before invoking the tool. ` +
    `Report ${opts.outputs}.`;
  return [{ role: 'user', content: { type: 'text', text } }];
}

export const PROMPTS: McpPrompt[] = [
  {
    name: 'optimize-iso-exercise',
    description:
      'Plan a multi-year Incentive Stock Option (ISO) exercise schedule that maximizes after-tax Net Final Value (NFV) at the planning horizon, accounting for AMT, AMT credit recovery, and stock-price drag from volatility. Uses the amt_iso_optimize tool.',
    arguments: [
      { name: 'shares', description: 'Total ISO shares available to exercise', required: true },
      { name: 'strike', description: 'Strike price per share, USD', required: true },
      { name: 'fmv', description: 'Current fair market value per share, USD', required: true },
      { name: 'ticker', description: 'Covered public-stock symbol (e.g. NVDA) that auto-resolves volatility and expected growth; an alternative to passing volatility', required: false },
      { name: 'volatility', description: 'Annualized volatility (sigma) as a decimal (e.g. 0.5 for 50%). Optional when you pass a covered ticker', required: false },
      { name: 'state', description: 'Two-letter state code (e.g. CA, NY, TX)', required: false },
      { name: 'ordinaryIncome', description: 'Annual W-2 ordinary income, USD', required: false },
    ],
    build: (a) =>
      templatePrompt({
        scenario: `I have ${arg(a, 'shares')} Incentive Stock Options (ISOs) with a strike of $${arg(a, 'strike')} per share and current fair market value of $${arg(a, 'fmv')} per share. `,
        optional: [
          a.ticker && `The stock ticker is ${a.ticker}. `,
          a.volatility && `Annualized volatility on the stock is ${a.volatility}. `,
          a.state && `I live in ${a.state}. `,
          a.ordinaryIncome && `My annual ordinary income is $${a.ordinaryIncome}. `,
        ],
        instruction:
          `Plan an exercise schedule across the next several years that maximizes my after-tax Net Final Value (NFV) at the planning horizon. Use the amt_iso_optimize tool: if I gave a ticker, pass it so volatility and growth resolve automatically; otherwise pass the volatility I provided and do not compute drag yourself. If neither a covered ticker nor a volatility is available, ask me for volatility first.`,
        followUpFields: 'filing status, state, ordinary income, grant date, idle-cash after-tax return rate, or post-termination status',
        outputs:
          "the optimized schedule's after-tax NFV vs the lump-sum and even-split alternatives, the recommended per-year share count, and the AMT credit carryforward at horizon",
      }),
  },
  {
    name: 'analyze-nso-decision',
    description:
      'Compare sell-at-exercise vs hold-for-long-term-capital-gains on a non-qualified stock option (NSO) exercise, including federal, state, and FICA. Uses the nso_calculate tool.',
    arguments: [
      { name: 'shares', description: 'NSO shares to exercise', required: true },
      { name: 'strike', description: 'Strike price per share, USD', required: true },
      { name: 'currentPrice', description: 'Current share price, USD', required: true },
      { name: 'ticker', description: 'Covered public-stock symbol (e.g. NVDA) that auto-resolves volatility and expected sale price; an alternative to passing volatility', required: false },
      { name: 'volatility', description: 'Annualized volatility (sigma) as a decimal (e.g. 0.4 for 40%). Optional when you pass a covered ticker', required: false },
      { name: 'holdYears', description: 'Years to hold after exercise (minimum 1; the calculator requires it)', required: true },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      templatePrompt({
        scenario: `I'm considering exercising ${arg(a, 'shares')} non-qualified stock options (NSOs) with a strike of $${arg(a, 'strike')} per share. The current share price is $${arg(a, 'currentPrice')}. `,
        optional: [
          a.ticker && `The stock ticker is ${a.ticker}. `,
          a.volatility && `Annualized volatility on the stock is ${a.volatility}. `,
          a.holdYears && `I'm thinking about holding for ${a.holdYears} year(s) after exercise to get long-term capital gains treatment on the appreciation. `,
          a.state && `I live in ${a.state}. `,
        ],
        instruction: `Compare sell-at-exercise vs hold-for-LTCG using the nso_calculate tool. If I gave a ticker, pass it so volatility resolves automatically; otherwise pass the volatility I provided and do not compute the haircut yourself. If neither is available, ask me for volatility first.`,
        followUpFields:
          'my filing status, ordinary income, state, expected sale price, or whether I am still employed at the company',
        outputs: 'after-tax dollar payout under each route, the break-even sale price, and your recommendation',
      }),
  },
  {
    name: 'analyze-rsu-vest',
    description:
      'Compare sell-at-vest vs hold-for-LTCG on a Restricted Stock Unit (RSU) vest, accounting for the 22% employer withholding gap and concentration risk. Uses the rsu_sell_vs_hold tool.',
    arguments: [
      { name: 'shares', description: 'RSU shares vesting', required: true },
      { name: 'currentPrice', description: 'Current share price, USD', required: true },
      { name: 'ticker', description: 'Covered public-stock symbol (e.g. NVDA) that auto-resolves volatility and expected sale price; an alternative to passing volatility', required: false },
      { name: 'volatility', description: 'Annualized volatility (sigma) as a decimal (e.g. 0.4 for 40%). Optional when you pass a covered ticker', required: false },
      { name: 'holdYears', description: 'Years to hold after vest', required: false },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      templatePrompt({
        scenario: `I have ${arg(a, 'shares')} Restricted Stock Units (RSUs) vesting at a current price of $${arg(a, 'currentPrice')} per share. `,
        optional: [
          a.ticker && `The stock ticker is ${a.ticker}. `,
          a.volatility && `Annualized volatility on the stock is ${a.volatility}. `,
          a.holdYears && `I'm thinking about holding for ${a.holdYears} year(s). `,
          a.state && `I live in ${a.state}. `,
        ],
        instruction:
          `Compare selling all shares at vest vs holding for long-term capital gains. Use the rsu_sell_vs_hold tool. If I gave a ticker, pass it so volatility resolves automatically; otherwise pass the volatility I provided and do not compute the haircut yourself. If neither is available, ask me for volatility first.`,
        followUpFields: 'my filing status, ordinary income, state, expected sale price, or whether I am still employed',
        outputs:
          'the after-tax payout under each route, flag the 22% withholding gap (most equity holders under-withhold), and recommend a path',
      }),
  },
  {
    name: 'analyze-concentration',
    description:
      'Score single-stock concentration risk and produce a sell-down vs hold vs hedge schedule with multi-year tax math. Uses the concentration_analyze tool.',
    arguments: [
      { name: 'positionValue', description: 'Current market value of the single-stock position, USD', required: true },
      { name: 'costBasis', description: 'Total cost basis of the position, USD', required: true },
      { name: 'totalAssets', description: 'Total investable assets, USD (for concentration ratio)', required: true },
      { name: 'ticker', description: 'Covered public-stock symbol (e.g. NVDA) that auto-resolves volatility and expected return; an alternative to passing volatility', required: false },
      { name: 'volatility', description: 'Annualized volatility (sigma) as a decimal (e.g. 0.4 for 40%). Optional when you pass a covered ticker', required: false },
      { name: 'sector', description: 'Sector tag (e.g. tech_software, healthcare_biotech, semiconductors)', required: false },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      templatePrompt({
        scenario: `I have a single-stock position worth $${arg(a, 'positionValue')} with a cost basis of $${arg(a, 'costBasis')}. My total investable assets are $${arg(a, 'totalAssets')}. `,
        optional: [
          a.ticker && `The stock ticker is ${a.ticker}. `,
          a.volatility && `Annualized volatility on the stock is ${a.volatility}. `,
          a.sector && `The stock is in the ${a.sector} sector. `,
          a.state && `I live in ${a.state}. `,
        ],
        instruction:
          `Quantify my concentration risk and compare selling down, holding, and hedging using the concentration_analyze tool. If I gave a ticker, pass it so volatility and expected return resolve automatically; otherwise pass the volatility I provided and do not compute drag yourself. If neither is available, ask me for volatility first.`,
        followUpFields:
          'my filing status, ordinary income, expected position return, expected market return, or hedge preference (put vs collar)',
        outputs:
          'after-tax dollar value under each strategy, drawdown exposure at 30/50/70%, and recommend a path',
      }),
  },
  {
    name: 'price-protective-put',
    description:
      'Price a protective put, zero-cost collar, or put spread on a single-stock position against current option-market implied volatility. Uses the protective_put_price tool.',
    arguments: [
      { name: 'positionValue', description: 'Current market value of the position, USD', required: true },
      { name: 'protectionLevel', description: 'Strike as a percentage below current price (e.g. 0.10 for 10% OTM)', required: false },
      { name: 'tenorYears', description: 'Years to expiration (e.g. 1 for 12-month)', required: false },
      { name: 'sector', description: 'Sector tag for default volatility', required: false },
      { name: 'spreadRiskLevel', description: "Put spread's floor breach risk: probability the stock ends below the short strike (e.g. 0.10 for 1 in 10)", required: false },
    ],
    build: (a) =>
      templatePrompt({
        scenario: `Price a hedge on my single-stock position worth $${arg(a, 'positionValue')}. `,
        optional: [
          a.protectionLevel
            ? `Protection level: ${a.protectionLevel} below current price. `
            : 'Use a 10% out-of-the-money strike by default. ',
          a.tenorYears ? `Tenor: ${a.tenorYears} year(s). ` : 'Use a 1-year tenor by default. ',
          a.sector && `Sector: ${a.sector}. `,
          a.spreadRiskLevel
            ? `Put spread floor breach risk: ${a.spreadRiskLevel}. `
            : 'For the put spread, use a 1-in-10 floor breach risk by default. ',
        ],
        instruction:
          `Use the protective_put_price tool to price a protective put, a zero-cost collar, and a put spread, then say which one it recommends and why.`,
        followUpFields: 'the sector or implied volatility for an unusual position',
        outputs:
          'annual cost as a percentage of position, dollar cost, max loss with hedge, upside cap (for the collar), the protected band (for the put spread), and bad-year coverage',
      }),
  },
  {
    name: 'check-qsbs-eligibility',
    description:
      'Check Section 1202 Qualified Small Business Stock (QSBS) qualification against the six statutory tests and compute the OBBBA 2026 tiered exclusion. Uses the qsbs_check tool.',
    arguments: [
      { name: 'acquisitionDate', description: 'Date the stock was acquired (YYYY-MM-DD)', required: true },
      { name: 'saleDate', description: 'Date of planned or actual sale (YYYY-MM-DD)', required: true },
      { name: 'expectedGain', description: 'Expected total gain on sale, USD', required: true },
      { name: 'industry', description: 'Industry classification (e.g. tech-software, biotech-research)', required: false },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      templatePrompt({
        scenario: `I'm checking whether my stock qualifies for the Section 1202 Qualified Small Business Stock (QSBS) exclusion. I acquired the stock on ${arg(a, 'acquisitionDate')} and plan to sell on ${arg(a, 'saleDate')}. Expected gain: $${arg(a, 'expectedGain')}. `,
        optional: [
          a.industry && `Industry: ${a.industry}. `,
          a.state && `I live in ${a.state}. `,
        ],
        instruction: `Run the qsbs_check tool against the six statutory tests.`,
        followUpFields:
          'entity type, acquisition method (original issuance vs secondary vs gift/inheritance), asset category (under-50m / 50m-to-75m / over-75m), active-business attestation, adjusted basis, filing status, or ordinary income',
        outputs:
          'the verdict (qualifies / partial / too-soon / caveats / disqualified), exclusion percentage, federal tax saved in dollars, state tax owed, and per-test pass/fail breakdown',
      }),
  },
  {
    name: 'plan-equity-funding',
    description:
      'Plan the minimum-tax sell schedule to net a target after-tax dollar amount by a target date from existing stock holdings (down payment, tuition, surgery, etc.). Uses the equity_funding_plan tool.',
    arguments: [
      { name: 'targetAfterTax', description: 'Net cash needed in pocket after all taxes, USD', required: true },
      { name: 'targetDate', description: 'Date the cash is needed by (YYYY-MM-DD)', required: true },
      { name: 'shares', description: 'Total shares held across all lots', required: true },
      { name: 'currentPrice', description: 'Current share price, USD', required: true },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      templatePrompt({
        scenario: `I need to net $${arg(a, 'targetAfterTax')} after all taxes by ${arg(a, 'targetDate')}. I have ${arg(a, 'shares')} shares of public stock at a current price of $${arg(a, 'currentPrice')} per share. `,
        optional: [
          a.state && `I live in ${a.state}. `,
        ],
        instruction:
          'Plan the cheapest sell schedule using the equity_funding_plan tool. You will need the per-lot cost basis and acquisition date for each tranche (RSU vest dates and prices, ESPP purchases, open-market buys), filing status, and annual W-2 income. If the user only knows the total shares and an average basis, ask whether to treat the position as a single combined lot.',
        followUpFields:
          'per-lot detail (shares, cost basis per share, acquisition date), filing status, and annual W-2 ordinary income',
        outputs:
          'whether the target is feasible, the per-year sell schedule with lot-by-lot detail, total taxes (federal LTCG + NIIT + state), savings vs liquidating everything in the target year, and any leftover shares plus their market value',
      }),
  },
];
