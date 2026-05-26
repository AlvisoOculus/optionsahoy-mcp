// AlphaLatitude Inc. © 2026
//
// POST /api/v1/protective-put — protective put / zero-cost collar pricing.

import { calculateProtectivePut } from '../../../lib/calc/protectivePut';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseProtectivePutInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async ({ request }) =>
  runCalc(request, parseProtectivePutInput, calculateProtectivePut);
