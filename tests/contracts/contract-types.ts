// AlphaLatitude Inc. © 2026
//
// Per-tool answer contracts — the spine of the agent-output test audit
// (docs/test-audit-plan.md, Phase 0). One contract per tool declares, once:
//
//   - requiredFacts: every datum the rendered answer MUST surface, as a
//     predicate pair (does it apply to this result, and does the text show it).
//   - discriminants: every engine field that branches the answer, with its full
//     value set, so coverage can be asserted exhaustively.
//   - scenarios: concrete engine inputs that drive each discriminant value,
//     each declaring how its headline must read and what it must never say.
//
// The Phase 1 (completeness), Phase 2 (branch-exhaustiveness + no-contradiction)
// and later test files all read from these so coverage is declared in one place.
// A contract binds the answer string to the engine: an answer cannot become
// incomplete, self-contradictory, or land in the generic fallback without a
// scenario here failing.

export interface RequiredFact {
  // Short name for failure messages.
  name: string;
  // Whether this datum is applicable to the given result (skip when not).
  applies: (result: any) => boolean;
  // Whether the rendered answer surfaces it.
  present: (text: string, result: any) => boolean;
}

export interface Discriminant {
  // The engine field that branches the answer.
  field: string;
  // Its full enumerated value set. Every value must be covered by a scenario.
  values: string[];
  // Pull the field's value out of an engine result.
  read: (result: any) => string;
}

export interface Scenario<I> {
  name: string;
  // Engine inputs that drive this scenario.
  inputs: I;
  // The discriminant values this scenario is expected to produce, keyed by
  // Discriminant.field. Asserted against the actual engine result so the
  // scenario can't silently drift off the branch it claims to cover.
  expect: Record<string, string>;
  // The rendered answer must match this (the state is framed correctly).
  headlineMatches: RegExp;
  // The rendered answer must NOT match any of these (no contradiction, no wrong
  // branch, no parenthetical that does not apply).
  answerRejects?: RegExp[];
}

export interface ToolContract<I = any, R = any> {
  tool: string;
  // Run the engine for a scenario's inputs.
  run: (inputs: I) => R;
  // Render the answer the way the Poe bot does: headline(tool, result).
  format: (result: R) => string;
  requiredFacts: RequiredFact[];
  discriminants: Discriminant[];
  scenarios: Scenario<I>[];
  // The generic / fallback headline line that NO enumerated scenario may hit,
  // except where a scenario explicitly expects it (see allowFallbackFor).
  fallback: RegExp;
  // Discriminant value(s) for which the fallback line is the correct answer
  // (e.g. qsbs 'disqualified' legitimately renders "does not appear to
  // qualify"). Keyed by "<field>:<value>".
  allowFallbackFor?: string[];
}
