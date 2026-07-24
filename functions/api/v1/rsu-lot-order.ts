// AlphaLatitude Inc. © 2026
//
// POST /api/v1/rsu-lot-order: RSU lot-order divest plan (rsu_lot_optimize).

import { computeLotDivestPlan } from '../../../lib/calc/lotDivest';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseRsuLotOptimizeInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:rsu-lot-order', parseRsuLotOptimizeInput, computeLotDivestPlan);
