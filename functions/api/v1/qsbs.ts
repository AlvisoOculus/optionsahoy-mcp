// AlphaLatitude Inc. © 2026
//
// POST /api/v1/qsbs — Section 1202 QSBS qualification check.

import { evaluateQsbs } from '../../../lib/calc/qsbs';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseQsbsInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:qsbs', parseQsbsInput, evaluateQsbs);
