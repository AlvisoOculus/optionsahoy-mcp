// AlphaLatitude Inc. © 2026
//
// Sector-typical statistics for single-name stocks within each sector.
// These are NOT sector-ETF stats — they're rough averages of INDIVIDUAL
// NAMES inside each sector, since the calculator's user owns one stock,
// not the index.
//
// Sources: composite of long-run analyses of S&P 500 component-level
// volatility and drawdown frequency (FactSet single-name analyses,
// Bloomberg sector dispersion data, 2014–2024 window).
// Last reviewed: 2026-04-25.
//
// Volatility is the input to Black-Scholes; expected_return and
// drawdown_freq_50_in_5y are display-only frames for the user.

export type SectorKey =
  | 'tech_software'
  | 'semiconductors'
  | 'consumer_cyclical'
  | 'consumer_defensive'
  | 'financials'
  | 'healthcare_biotech'
  | 'energy'
  | 'industrials'
  | 'communication'
  | 'broad_market';

export type SectorStats = {
  key: SectorKey;
  label: string;
  // Annualized realized volatility of a typical single-name in this sector.
  // Used as the σ input to Black-Scholes. Approximate; not implied vol.
  annualVol: number;
  // Long-run real-world expected return (μ) for a typical single-name in this
  // sector. Used to compute "real-world" probabilities (e.g. "what's the
  // chance the stock breaks the collar's upside cap?"). Not used for
  // option pricing — pricing always uses the risk-free rate. Sourced from
  // 20-year sector-aggregate composites; review annually.
  annualReturn: number;
  // 1-in-N frequency: roughly 1 in N rolling 3-year windows over 2014–2024
  // saw a 50%+ peak-to-trough drawdown for an average single-name in this sector.
  // Shorter windows = fewer chances to capture a peak-to-trough swing, so
  // these ratios are higher than the 5-year equivalents.
  drawdownFreq50In3y: number;
  // Display-only sentence frame for the user (drops into the footer line).
  contextLine: string;
};

export const SECTOR_STATS: Record<SectorKey, SectorStats> = {
  tech_software: {
    key: 'tech_software',
    label: 'Tech / Software',
    annualVol: 0.36,
    annualReturn: 0.12,
    drawdownFreq50In3y: 5,
    contextLine:
      'Tech / Software single names hit a 50%+ peak-to-trough drawdown in roughly 1 of every 5 rolling 3-year windows over 2014–2024. Even mega-caps aren’t exempt.',
  },
  semiconductors: {
    key: 'semiconductors',
    label: 'Semiconductors',
    annualVol: 0.45,
    annualReturn: 0.13,
    drawdownFreq50In3y: 4,
    contextLine:
      'Semiconductor stocks are among the most volatile single names in the S&P 500. A 50%+ drawdown over a rolling 3-year window happens to roughly 1 in 4 names.',
  },
  consumer_cyclical: {
    key: 'consumer_cyclical',
    label: 'Consumer (cyclical)',
    annualVol: 0.32,
    annualReturn: 0.09,
    drawdownFreq50In3y: 6,
    contextLine:
      'Consumer-cyclical single names hit a 50%+ peak-to-trough drawdown in roughly 1 of every 6 rolling 3-year windows over 2014–2024.',
  },
  consumer_defensive: {
    key: 'consumer_defensive',
    label: 'Consumer (defensive)',
    annualVol: 0.24,
    annualReturn: 0.07,
    drawdownFreq50In3y: 14,
    contextLine:
      'Consumer-defensive single names are the calmer end of the S&P 500. A 50%+ drawdown over a rolling 3-year window hits roughly 1 in 14 names — uncommon, not impossible.',
  },
  financials: {
    key: 'financials',
    label: 'Financials',
    annualVol: 0.32,
    annualReturn: 0.08,
    drawdownFreq50In3y: 7,
    contextLine:
      'Financial-sector single names hit a 50%+ peak-to-trough drawdown in roughly 1 of every 7 rolling 3-year windows over 2014–2024 — concentrated around credit/rate cycles.',
  },
  healthcare_biotech: {
    key: 'healthcare_biotech',
    label: 'Healthcare / Biotech',
    annualVol: 0.40,
    annualReturn: 0.10,
    drawdownFreq50In3y: 4,
    contextLine:
      'Healthcare and biotech single names span a wide range — biotech alone has had a 50%+ drawdown roughly 1 in 3 rolling 3-year windows; large-cap pharma is closer to 1 in 8.',
  },
  energy: {
    key: 'energy',
    label: 'Energy',
    annualVol: 0.40,
    annualReturn: 0.06,
    drawdownFreq50In3y: 4,
    contextLine:
      'Energy single names are commodity-driven. A 50%+ peak-to-trough drawdown over a rolling 3-year window is roughly 1 in 4, often clustered in the same downturn.',
  },
  industrials: {
    key: 'industrials',
    label: 'Industrials',
    annualVol: 0.28,
    annualReturn: 0.09,
    drawdownFreq50In3y: 8,
    contextLine:
      'Industrials single names hit a 50%+ peak-to-trough drawdown in roughly 1 of every 8 rolling 3-year windows over 2014–2024.',
  },
  communication: {
    key: 'communication',
    label: 'Communication services',
    annualVol: 0.34,
    annualReturn: 0.08,
    drawdownFreq50In3y: 6,
    contextLine:
      'Communication-services single names hit a 50%+ peak-to-trough drawdown in roughly 1 of every 6 rolling 3-year windows over 2014–2024.',
  },
  broad_market: {
    key: 'broad_market',
    label: 'Broad market (S&P 500)',
    annualVol: 0.30,
    annualReturn: 0.10,
    drawdownFreq50In3y: 7,
    contextLine:
      'On average, S&P 500 single names hit a 50%+ peak-to-trough drawdown in roughly 1 of every 7 rolling 3-year windows over 2014–2024 — even though the index itself recovered.',
  },
};

export const SECTOR_OPTIONS = (Object.keys(SECTOR_STATS) as SectorKey[]).map((key) => ({
  key,
  label: SECTOR_STATS[key].label,
}));
