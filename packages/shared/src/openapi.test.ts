import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  API_KEY_READ_ONLY_SCOPES,
  API_KEY_SCOPE_INFO,
  API_KEY_SCOPES,
  apiKeyCreateSchema,
  apiKeyState,
  IDEMPOTENCY_KEY_PATTERN,
  INTEGRATION_API_VERSION,
  INTEGRATION_ENDPOINTS,
  INTEGRATION_OPERATION_IDS,
  normaliseApiKeyScopes,
} from './integrations';
import { buildIntegrationOpenApi, integrationOpenApiJson, openApiPath, zodToJsonSchema } from './openapi';

describe('zodToJsonSchema', () => {
  it('converts strings, numbers, booleans, enums, literals and null', () => {
    expect(zodToJsonSchema(z.string().min(1).max(5).email())).toEqual({ type: 'string', minLength: 1, maxLength: 5, format: 'email' });
    expect(zodToJsonSchema(z.string().url())).toEqual({ type: 'string', format: 'uri' });
    expect(zodToJsonSchema(z.string().uuid().describe('An id.'))).toEqual({ description: 'An id.', type: 'string', format: 'uuid' });
    expect(zodToJsonSchema(z.string().regex(/^a+$/).trim())).toEqual({ type: 'string', pattern: '^a+$' });
    expect(zodToJsonSchema(z.number().int().min(1).max(10))).toEqual({ type: 'integer', minimum: 1, maximum: 10 });
    expect(zodToJsonSchema(z.number().gt(0).lt(1))).toEqual({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 });
    expect(zodToJsonSchema(z.coerce.number().int().default(3))).toEqual({ type: 'integer', default: 3 });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(zodToJsonSchema(z.literal('x'))).toEqual({ type: 'string', const: 'x' });
    expect(zodToJsonSchema(z.literal(2))).toEqual({ type: 'integer', const: 2 });
    expect(zodToJsonSchema(z.null())).toEqual({ type: 'null' });
    expect(zodToJsonSchema(z.unknown())).toEqual({});
  });

  it('marks nullable values and required fields (optional, default and unknown fields are not required)', () => {
    expect(zodToJsonSchema(z.string().nullable())).toEqual({ type: ['string', 'null'] });
    expect(zodToJsonSchema(z.enum(['a']).nullable())).toEqual({ type: ['string', 'null'], enum: ['a', null] });
    // `properties` / `required` only apply to objects, so null passes.
    expect(zodToJsonSchema(z.object({ a: z.string() }).nullable())).toEqual({ type: ['object', 'null'], properties: { a: { type: 'string' } }, required: ['a'] });
    expect(zodToJsonSchema(z.union([z.string(), z.number()]).nullable())).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] });
    expect(zodToJsonSchema(z.object({ req: z.string(), opt: z.string().optional(), def: z.number().default(1), any: z.unknown(), nul: z.string().nullable() }))).toEqual({
      type: 'object',
      properties: { req: { type: 'string' }, opt: { type: 'string' }, def: { type: 'number', default: 1 }, any: {}, nul: { type: ['string', 'null'] } },
      required: ['req', 'nul'],
    });
    expect(zodToJsonSchema(z.object({}).strict())).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('converts arrays, records, unions, intersections and refinements', () => {
    expect(zodToJsonSchema(z.array(z.string()).min(1).max(3))).toEqual({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 });
    expect(zodToJsonSchema(z.record(z.number()))).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
    expect(zodToJsonSchema(z.record(z.enum(['x', 'y']), z.number()))).toEqual({ type: 'object', additionalProperties: { type: 'number' }, propertyNames: { type: 'string', enum: ['x', 'y'] } });
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(zodToJsonSchema(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })))).toEqual({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    });
    expect(zodToJsonSchema(z.object({ a: z.string() }).refine(() => true).describe('Refined.'))).toEqual({ description: 'Refined.', type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
  });

  it('references named schemas (except the one being converted) and refuses features it cannot express', () => {
    const named = z.object({ id: z.string() });
    const refs = new Map([[named, 'Thing']]);
    expect(zodToJsonSchema(z.object({ thing: named, maybe: named.nullable(), list: z.array(named) }), { refs })).toEqual({
      type: 'object',
      properties: { thing: { $ref: '#/components/schemas/Thing' }, maybe: { anyOf: [{ $ref: '#/components/schemas/Thing' }, { type: 'null' }] }, list: { type: 'array', items: { $ref: '#/components/schemas/Thing' } } },
      required: ['thing', 'maybe', 'list'],
    });
    expect(zodToJsonSchema(named, { refs })).toEqual({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
    expect(() => zodToJsonSchema(z.date())).toThrow(/unsupported zod type ZodDate/);
    expect(() => zodToJsonSchema(z.string().ip())).toThrow(/unsupported string check 'ip'/);
  });
});

describe('the integration API catalogue and its OpenAPI document', () => {
  it('has unique operations; every POST and PUT accepts an Idempotency-Key; every endpoint but the document needs a known scope', () => {
    expect(INTEGRATION_ENDPOINTS.map((e) => e.operationId).sort()).toEqual([...INTEGRATION_OPERATION_IDS].sort());
    expect(new Set(INTEGRATION_ENDPOINTS.map((e) => `${e.method} ${e.path}`)).size).toBe(INTEGRATION_ENDPOINTS.length);
    for (const e of INTEGRATION_ENDPOINTS) {
      expect(e.idempotent === true, e.operationId).toBe(e.method !== 'GET');
      if (e.operationId === 'getOpenApiDocument') expect(e.scope).toBeNull();
      else expect(API_KEY_SCOPES).toContain(e.scope);
    }
    // Every scope is used by some endpoint.
    for (const s of API_KEY_SCOPES) expect(INTEGRATION_ENDPOINTS.some((e) => e.scope === s), s).toBe(true);
  });

  it('is deterministic OpenAPI 3.1 with every operation, its scope and its parameters', () => {
    const doc = buildIntegrationOpenApi() as { openapi: string; info: { version: string }; servers: { url: string }[]; paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string }[] }>> };
    expect(integrationOpenApiJson()).toBe(integrationOpenApiJson());
    expect(integrationOpenApiJson().endsWith('}\n')).toBe(true);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe(INTEGRATION_API_VERSION);
    expect(doc.servers).toEqual([{ url: '/api/v1' }]);
    expect((buildIntegrationOpenApi({ serverUrl: 'https://proctor.example.com/api/v1' }) as typeof doc).servers).toEqual([{ url: 'https://proctor.example.com/api/v1' }]);
    expect(openApiPath('/exams/:examId/assignments')).toBe('/exams/{examId}/assignments');
    const assign = doc.paths['/exams/{examId}/assignments'].post;
    expect(assign.operationId).toBe('assignCandidates');
    expect(assign.parameters).toEqual([expect.objectContaining({ name: 'examId', in: 'path' }), { $ref: '#/components/parameters/IdempotencyKey' }]);
    expect(doc.paths['/sessions'].get.parameters!.map((p) => p.name)).toEqual(['examId', 'candidateId', 'externalId', 'status', 'limit', 'offset']);
  });
});

describe('API key helpers', () => {
  it('scopes: canonical order, read-only preset, labels for each', () => {
    expect(normaliseApiKeyScopes(['events:read', 'bogus', 'exams:read', 'events:read'])).toEqual(['exams:read', 'events:read']);
    expect(API_KEY_READ_ONLY_SCOPES).toEqual(['exams:read', 'candidates:read', 'sessions:read', 'reports:read', 'events:read']);
    for (const s of API_KEY_SCOPES) expect(API_KEY_SCOPE_INFO[s].label.length).toBeGreaterThan(0);
    expect(apiKeyCreateSchema.parse({ name: ' LMS ' })).toEqual({ name: 'LMS', scopes: [...API_KEY_SCOPES], expiresAt: null });
  });

  it('state: revoked > expired > expiring (within 14 days) > active', () => {
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    expect(apiKeyState({ revokedAt: now - 1, expiresAt: now - day }, now)).toBe('revoked');
    expect(apiKeyState({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
    expect(apiKeyState({ revokedAt: null, expiresAt: now + 14 * day }, now)).toBe('expiring');
    expect(apiKeyState({ revokedAt: null, expiresAt: now + 14 * day + 1 }, now)).toBe('active');
    expect(apiKeyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
  });

  it('Idempotency-Key format', () => {
    for (const ok of ['a', '3f1d7a0e-5b1c-4f7e-9d67-2d4b1c0a9e11', 'order:42/attempt=1+x~y_z.w', 'k'.repeat(255)]) expect(IDEMPOTENCY_KEY_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', 'k'.repeat(256), 'with space', 'ä', 'a,b']) expect(IDEMPOTENCY_KEY_PATTERN.test(bad), bad).toBe(false);
  });
});
