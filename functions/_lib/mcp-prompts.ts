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

function userMessage(text: string): McpPromptMessage[] {
  return [{ role: 'user', content: { type: 'text', text } }];
}

export const PROMPTS: McpPrompt[] = [
  {
    name: 'optimize-iso-exercise',
    description:
      'Plan a multi-year Incentive Stock Option (ISO) exercise schedule that minimizes federal and state Alternative Minimum Tax with credit recovery. Uses the amt_iso_optimize tool.',
    arguments: [
      { name: 'shares', description: 'Total ISO shares available to exercise', required: true },
      { name: 'strike', description: 'Strike price per share, USD', required: true },
      { name: 'fmv', description: 'Current fair market value per share, USD', required: true },
      { name: 'state', description: 'Two-letter state code (e.g. CA, NY, TX)', required: false },
      { name: 'ordinaryIncome', description: 'Annual W-2 ordinary income, USD', required: false },
    ],
    build: (a) =>
      userMessage(
        `I have ${arg(a, 'shares')} Incentive Stock Options (ISOs) with a strike of $${arg(a, 'strike')} per share and current fair market value of $${arg(a, 'fmv')} per share. ` +
          (a.state ? `I live in ${a.state}. ` : '') +
          (a.ordinaryIncome ? `My annual ordinary income is $${a.ordinaryIncome}. ` : '') +
          `Plan an exercise schedule across the next several years that minimizes my total Alternative Minimum Tax (AMT) and recovers AMT credits where possible. ` +
          `Use the amt_iso_optimize tool. If you need filing status, state, ordinary income, grant date, or post-termination status, ask me one short follow-up question before invoking the tool. ` +
          `Report the recommended per-year share count, total AMT paid, AMT credit recovered, and net final value vs lump-sum and even-split alternatives.`,
      ),
  },
  {
    name: 'analyze-nso-decision',
    description:
      'Compare sell-at-exercise vs hold-for-long-term-capital-gains on a non-qualified stock option (NSO) exercise, including federal, state, and FICA. Uses the nso_calculate tool.',
    arguments: [
      { name: 'shares', description: 'NSO shares to exercise', required: true },
      { name: 'strike', description: 'Strike price per share, USD', required: true },
      { name: 'currentPrice', description: 'Current share price, USD', required: true },
      { name: 'holdYears', description: 'Years to hold after exercise (1 minimum for LTCG)', required: false },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      userMessage(
        `I'm considering exercising ${arg(a, 'shares')} non-qualified stock options (NSOs) with a strike of $${arg(a, 'strike')} per share. The current share price is $${arg(a, 'currentPrice')}. ` +
          (a.holdYears ? `I'm thinking about holding for ${a.holdYears} year(s) after exercise to get long-term capital gains treatment on the appreciation. ` : '') +
          (a.state ? `I live in ${a.state}. ` : '') +
          `Compare sell-at-exercise vs hold-for-LTCG using the nso_calculate tool. ` +
          `If you need my filing status, ordinary income, state, expected sale price, or whether I'm still employed at the company, ask me one short follow-up question before invoking the tool. ` +
          `Report after-tax dollar payout under each route, the break-even sale price, and your recommendation.`,
      ),
  },
  {
    name: 'analyze-rsu-vest',
    description:
      'Compare sell-at-vest vs hold-for-LTCG on a Restricted Stock Unit (RSU) vest, accounting for the 22% employer withholding gap and concentration risk. Uses the rsu_sell_vs_hold tool.',
    arguments: [
      { name: 'shares', description: 'RSU shares vesting', required: true },
      { name: 'currentPrice', description: 'Current share price, USD', required: true },
      { name: 'holdYears', description: 'Years to hold after vest', required: false },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      userMessage(
        `I have ${arg(a, 'shares')} Restricted Stock Units (RSUs) vesting at a current price of $${arg(a, 'currentPrice')} per share. ` +
          (a.holdYears ? `I'm thinking about holding for ${a.holdYears} year(s). ` : '') +
          (a.state ? `I live in ${a.state}. ` : '') +
          `Compare selling all shares at vest vs holding for long-term capital gains. Use the rsu_sell_vs_hold tool. ` +
          `If you need my filing status, ordinary income, state, expected sale price, or whether I'm still employed, ask me one short follow-up question. ` +
          `Report the after-tax payout under each route, flag the 22% withholding gap (most equity holders under-withhold), and recommend a path.`,
      ),
  },
  {
    name: 'analyze-concentration',
    description:
      'Score single-stock concentration risk and produce a sell-down vs hold vs hedge schedule with multi-year tax math. Uses the concentration_analyze tool.',
    arguments: [
      { name: 'positionValue', description: 'Current market value of the single-stock position, USD', required: true },
      { name: 'costBasis', description: 'Total cost basis of the position, USD', required: true },
      { name: 'totalAssets', description: 'Total investable assets, USD (for concentration ratio)', required: true },
      { name: 'sector', description: 'Sector tag (e.g. tech_software, healthcare_biotech, semiconductors)', required: false },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      userMessage(
        `I have a single-stock position worth $${arg(a, 'positionValue')} with a cost basis of $${arg(a, 'costBasis')}. My total investable assets are $${arg(a, 'totalAssets')}. ` +
          (a.sector ? `The stock is in the ${a.sector} sector. ` : '') +
          (a.state ? `I live in ${a.state}. ` : '') +
          `Quantify my concentration risk and compare selling down, holding, and hedging using the concentration_analyze tool. ` +
          `If you need my filing status, ordinary income, expected position return, expected market return, or hedge preference (put vs collar), ask me one short follow-up question. ` +
          `Report after-tax dollar value under each strategy, drawdown exposure at 30/50/70%, and recommend a path.`,
      ),
  },
  {
    name: 'price-protective-put',
    description:
      'Price a protective put or zero-cost collar on a single-stock position using Black-Scholes against a daily-refreshed implied-volatility surface. Uses the protective_put_price tool.',
    arguments: [
      { name: 'positionValue', description: 'Current market value of the position, USD', required: true },
      { name: 'protectionLevel', description: 'Strike as a percentage below current price (e.g. 0.10 for 10% OTM)', required: false },
      { name: 'tenorYears', description: 'Years to expiration (e.g. 1 for 12-month)', required: false },
      { name: 'sector', description: 'Sector tag for default volatility', required: false },
    ],
    build: (a) =>
      userMessage(
        `Price a hedge on my single-stock position worth $${arg(a, 'positionValue')}. ` +
          (a.protectionLevel ? `Protection level: ${a.protectionLevel} below current price. ` : 'Use a 10% out-of-the-money strike by default. ') +
          (a.tenorYears ? `Tenor: ${a.tenorYears} year(s). ` : 'Use a 1-year tenor by default. ') +
          (a.sector ? `Sector: ${a.sector}. ` : '') +
          `Use the protective_put_price tool to price both a protective put and a zero-cost collar. Report annual cost as a percentage of position, dollar cost, max loss with hedge, upside cap (for the collar), and bad-year coverage. ` +
          `If you need the sector or implied volatility for an unusual position, ask me one short follow-up question.`,
      ),
  },
  {
    name: 'check-qsbs-eligibility',
    description:
      'Check Section 1202 Qualified Small Business Stock (QSBS) qualification against the eight statutory tests and compute the OBBBA 2026 tiered exclusion. Uses the qsbs_check tool.',
    arguments: [
      { name: 'acquisitionDate', description: 'Date the stock was acquired (YYYY-MM-DD)', required: true },
      { name: 'saleDate', description: 'Date of planned or actual sale (YYYY-MM-DD)', required: true },
      { name: 'expectedGain', description: 'Expected total gain on sale, USD', required: true },
      { name: 'industry', description: 'Industry classification (e.g. tech-software, biotech-research)', required: false },
      { name: 'state', description: 'Two-letter state code', required: false },
    ],
    build: (a) =>
      userMessage(
        `I'm checking whether my stock qualifies for the Section 1202 Qualified Small Business Stock (QSBS) exclusion. I acquired the stock on ${arg(a, 'acquisitionDate')} and plan to sell on ${arg(a, 'saleDate')}. Expected gain: $${arg(a, 'expectedGain')}. ` +
          (a.industry ? `Industry: ${a.industry}. ` : '') +
          (a.state ? `I live in ${a.state}. ` : '') +
          `Run the qsbs_check tool against the eight statutory tests. ` +
          `If you need entity type, acquisition method (original issuance vs secondary vs gift/inheritance), asset category (under-50m / 50m-to-75m / over-75m), active-business attestation, adjusted basis, filing status, or ordinary income, ask me one short follow-up question. ` +
          `Report the verdict (qualified / disqualified / partial), exclusion percentage, federal tax saved in dollars, state tax owed, and per-test pass/fail breakdown.`,
      ),
  },
];
