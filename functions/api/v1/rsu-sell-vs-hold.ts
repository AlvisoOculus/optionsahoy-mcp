// AlphaLatitude Inc. © 2026
//
// POST /api/v1/rsu-sell-vs-hold — RSU sell-at-vest vs. hold-for-LTCG.

import { computeRsuResult } from '../../../lib/calc/rsu';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseRsuInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:rsu-sell-vs-hold', parseRsuInput, computeRsuResult);
