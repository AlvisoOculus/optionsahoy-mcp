// AlphaLatitude Inc. © 2026
//
// POST /api/v1/amt-iso — multi-year ISO exercise schedule optimization.

import { computeAmtIso } from '../../../lib/calc/amtIso';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseAmtIsoInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async ({ request }) =>
  runCalc(request, parseAmtIsoInput, computeAmtIso);
