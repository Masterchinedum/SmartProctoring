/**
 * Staff API — model governance (services/decision-configs.ts, services/calibration.ts).
 *
 *   GET  /decision-configs                       -> DecisionConfigsDTO          [reviewer]
 *   POST /decision-configs {thresholds,note}     -> DecisionConfigDTO           [admin]  propose
 *   GET  /decision-configs/:id/impact            -> DecisionConfigImpactDTO     [admin]  preview on recent samples
 *   POST /decision-configs/:id/approve {note?}   -> DecisionConfigDTO           [admin, not the proposer]
 *   POST /decision-configs/:id/reject {note?}    -> DecisionConfigDTO           [admin, not the proposer]
 *   POST /decision-configs/:id/withdraw          -> DecisionConfigDTO           [the proposer]
 *   POST /decision-configs/:id/rollback {note}   -> DecisionConfigDTO           [admin]  restore an earlier version now
 *   GET  /metrics/calibration?from=&to=          -> CalibrationDTO              [reviewer]
 *   GET  /metrics/drift                          -> DriftDTO                    [reviewer]
 */
import {
  decideDecisionConfigSchema,
  DEFAULT_IDENTITY_THRESHOLDS,
  proposeDecisionConfigSchema,
  rollbackDecisionConfigSchema,
  type CalibrationDTO,
  type DecisionConfigDTO,
  type DecisionConfigsDTO,
  type DriftDTO,
} from '@sp/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getStaff, requireStaff } from '../../auth/staff.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { calibrationBreakdown, driftReport } from '../../services/calibration.js';
import { decideDecisionConfig, decisionConfigImpact, ensureDecisionConfigs, listDecisionConfigs, proposeDecisionConfig, rollbackDecisionConfig } from '../../services/decision-configs.js';
import { CALIBRATION } from '../../vision/calibration.js';
import { EMBEDDING_MODEL_VERSION } from '../../vision/embeddings.js';
import { blankToUndefined, idParam } from './common.js';

const rangeSchema = z.object({ from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(0).optional() });

export const governanceRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };
  const admin = { preHandler: requireStaff('admin') };

  const one = async (orgId: string, id: string): Promise<DecisionConfigDTO> => {
    const dto = (await listDecisionConfigs(ctx.db, orgId)).find((c) => c.id === id);
    if (!dto) throw notFound('Configuration not found', 'decision_config_not_found');
    return dto;
  };

  app.get('/decision-configs', reviewer, async (req): Promise<DecisionConfigsDTO> => {
    const staff = getStaff(req);
    await ensureDecisionConfigs(ctx.db, staff.orgId, ctx.now());
    return {
      items: await listDecisionConfigs(ctx.db, staff.orgId),
      releaseDefaults: { ...DEFAULT_IDENTITY_THRESHOLDS },
      calibrationVersion: CALIBRATION.version,
      modelVersion: EMBEDDING_MODEL_VERSION,
    };
  });

  app.post('/decision-configs', admin, async (req): Promise<DecisionConfigDTO> => {
    const staff = getStaff(req);
    const body = proposeDecisionConfigSchema.parse(req.body ?? {});
    const row = await ctx.db.transaction((tx) => proposeDecisionConfig(tx, { id: staff.id, orgId: staff.orgId, role: staff.role, ip: req.ip }, body, ctx.now()));
    return one(staff.orgId, row.id);
  });

  app.get('/decision-configs/:id/impact', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Configuration', 'decision_config_not_found');
    return decisionConfigImpact(ctx.db, staff.orgId, id, ctx.now());
  });

  for (const decision of ['approve', 'reject', 'withdraw'] as const) {
    app.post(`/decision-configs/:id/${decision}`, admin, async (req): Promise<DecisionConfigDTO> => {
      const staff = getStaff(req);
      const id = idParam(req, 'id', 'Configuration', 'decision_config_not_found');
      const body = decideDecisionConfigSchema.parse(req.body ?? {});
      await ctx.db.transaction((tx) => decideDecisionConfig(tx, { id: staff.id, orgId: staff.orgId, role: staff.role, ip: req.ip }, id, decision, body.note?.trim() || null, ctx.now()));
      return one(staff.orgId, id);
    });
  }

  app.post('/decision-configs/:id/rollback', admin, async (req): Promise<DecisionConfigDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Configuration', 'decision_config_not_found');
    const body = rollbackDecisionConfigSchema.parse(req.body ?? {});
    const row = await ctx.db.transaction((tx) => rollbackDecisionConfig(tx, { id: staff.id, orgId: staff.orgId, role: staff.role, ip: req.ip }, id, body.note, ctx.now()));
    return one(staff.orgId, row.id);
  });

  app.get('/metrics/calibration', reviewer, async (req): Promise<CalibrationDTO> => {
    const staff = getStaff(req);
    const q = rangeSchema.parse(blankToUndefined(req.query));
    const to = q.to ?? ctx.now();
    const from = q.from ?? to - 30 * 86_400_000;
    if (from >= to) throw badRequest('`from` must be before `to`');
    return calibrationBreakdown(ctx.db, staff.orgId, from, to);
  });

  app.get('/metrics/drift', reviewer, async (req): Promise<DriftDTO> => driftReport(ctx.db, getStaff(req).orgId, ctx.now()));
};
