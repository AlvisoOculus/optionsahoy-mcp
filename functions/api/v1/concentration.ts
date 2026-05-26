// AlphaLatitude Inc. © 2026
//
// POST /api/v1/concentration — single-stock concentration risk analysis.

import { calculate } from '../../../lib/calc/concentration';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseConcentrationInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async ({ request }) =>
  runCalc(request, parseConcentrationInput, calculate);
