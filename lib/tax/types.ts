// AlphaLatitude Inc. © 2026

export type FilingStatus = 'single' | 'married_joint' | 'head_household';

export type Bracket = {
  min: number;
  rate: number;
};

export type Brackets = Record<FilingStatus, Bracket[]>;

// Loosened shape for the vendored state JSONs:
//   - head_household may be missing (we fall back to single)
//   - notes is informational ("Flat tax" / "No state income tax")
export type YearData = {
  single?: Bracket[];
  married_joint?: Bracket[];
  head_household?: Bracket[];
  notes?: string;
};

export type StateTaxData = {
  name: string;
  source: string;
  years: Record<string, YearData>;
};
