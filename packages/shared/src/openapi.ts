/**
 * OpenAPI 3.1 document of the integration API (/api/v1), generated from the zod schemas and the endpoint catalogue in
 * ./integrations.ts. Served at GET /api/v1/openapi.json (no API key needed) and committed as docs/openapi.json
 * (`pnpm --filter @sp/server openapi -- --out ../../docs/openapi.json`; a server test fails when that file is out of date).
 *
 * zodToJsonSchema converts the zod features the contract uses into JSON Schema 2020-12 (the dialect of OpenAPI 3.1):
 * objects, arrays, strings (length, email, url, uuid, regex), numbers (int, bounds), booleans, enums, literals, null,
 * nullable / optional / default, records, unions, intersections, refinements (as their inner schema), unknown / any.
 * Anything else throws, so a new zod feature cannot silently produce a wrong document.
 */
import { ZodFirstPartyTypeKind, type ZodTypeAny } from 'zod';
import {
  accommodationKindSchema,
  API_KEY_SCOPE_INFO,
  API_KEY_SCOPES,
  endReasonSchema,
  eventCategorySchema,
  eventTypeSchema,
  sessionStatusSchema,
  severitySchema,
  IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SEC,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_KEY_TTL_HOURS,
  IDEMPOTENT_REPLAYED_HEADER,
  INTEGRATION_API_VERSION,
  INTEGRATION_ENDPOINTS,
  integrationAssignmentDtoSchema,
  integrationAssignSchema,
  integrationCandidateDtoSchema,
  integrationCandidateSchema,
  integrationCandidateUpsertDtoSchema,
  integrationErrorSchema,
  integrationEventDtoSchema,
  integrationExamDtoSchema,
  integrationHoldDtoSchema,
  integrationSessionDtoSchema,
  integrationSessionReportDtoSchema,
  sessionWindowDtoSchema,
  type IntegrationEndpoint,
} from './integrations';
import { rescheduleRequestSchema, sessionWindowInputSchema } from './scheduling';

export type JsonSchema = { [key: string]: unknown };

export interface JsonSchemaOptions {
  /** Named schemas, emitted as `$ref` wherever they are used (except when converting that schema itself). */
  refs?: ReadonlyMap<ZodTypeAny, string>;
  /** Default `#/components/schemas/`. */
  refPrefix?: string;
}

/** JSON Schema 2020-12 for a zod schema (request bodies: fields with a default or `.optional()` are not required). */
export function zodToJsonSchema(schema: ZodTypeAny, opts: JsonSchemaOptions = {}): JsonSchema {
  return convert(schema, opts, true);
}

function convert(schema: ZodTypeAny, opts: JsonSchemaOptions, root = false): JsonSchema {
  const name = root ? undefined : opts.refs?.get(schema);
  if (name) return { $ref: `${opts.refPrefix ?? '#/components/schemas/'}${name}` };
  const out = convertType(schema, opts);
  if (!schema.description) return out;
  // The outermost description is the most specific (wrappers such as .optional() otherwise repeat the inner one).
  const { description: _inner, ...rest } = out;
  return { description: schema.description, ...rest };
}

/** `null` added to a schema. */
function nullable(s: JsonSchema): JsonSchema {
  if (Object.keys(s).filter((k) => k !== 'description').length === 0) return s; // {} already accepts null
  if (typeof s.type === 'string' && s.$ref === undefined && s.const === undefined) {
    return { ...s, type: [s.type, 'null'], ...(Array.isArray(s.enum) ? { enum: [...s.enum, null] } : {}) };
  }
  const { description, ...rest } = s;
  const options = Object.keys(rest).length === 1 && Array.isArray(rest.anyOf) ? (rest.anyOf as JsonSchema[]) : [rest];
  return { ...(description !== undefined ? { description } : {}), anyOf: [...options, { type: 'null' }] };
}

/** zod v3 internals: `_def` is untyped per kind. */
function convertType(schema: ZodTypeAny, opts: JsonSchemaOptions): JsonSchema {
  const def = schema._def as any;
  switch (def.typeName as ZodFirstPartyTypeKind) {
    case ZodFirstPartyTypeKind.ZodString: {
      const s: JsonSchema = { type: 'string' };
      for (const c of def.checks as { kind: string; value?: number; regex?: RegExp }[]) {
        if (c.kind === 'min') s.minLength = c.value;
        else if (c.kind === 'max') s.maxLength = c.value;
        else if (c.kind === 'length') s.minLength = s.maxLength = c.value;
        else if (c.kind === 'email') s.format = 'email';
        else if (c.kind === 'url') s.format = 'uri';
        else if (c.kind === 'uuid') s.format = 'uuid';
        else if (c.kind === 'datetime') s.format = 'date-time';
        else if (c.kind === 'regex') s.pattern = c.regex!.source;
        else if (c.kind !== 'trim' && c.kind !== 'toLowerCase' && c.kind !== 'toUpperCase') throw new Error(`zodToJsonSchema: unsupported string check '${c.kind}'`);
      }
      return s;
    }
    case ZodFirstPartyTypeKind.ZodNumber: {
      const checks = def.checks as { kind: string; value?: number; inclusive?: boolean }[];
      const s: JsonSchema = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') s[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
        else if (c.kind === 'max') s[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
        else if (c.kind === 'multipleOf') s.multipleOf = c.value;
        else if (c.kind !== 'int' && c.kind !== 'finite') throw new Error(`zodToJsonSchema: unsupported number check '${c.kind}'`);
      }
      return s;
    }
    case ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case ZodFirstPartyTypeKind.ZodNull:
      return { type: 'null' };
    case ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...(def.values as string[])] };
    case ZodFirstPartyTypeKind.ZodLiteral: {
      const v = def.value as unknown;
      if (v === null) return { type: 'null' };
      if (!['string', 'number', 'boolean'].includes(typeof v)) throw new Error('zodToJsonSchema: unsupported literal');
      return { type: typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v, const: v };
    }
    case ZodFirstPartyTypeKind.ZodArray: {
      const s: JsonSchema = { type: 'array', items: convert(def.type, opts) };
      if (def.exactLength) s.minItems = s.maxItems = def.exactLength.value;
      if (def.minLength) s.minItems = def.minLength.value;
      if (def.maxLength) s.maxItems = def.maxLength.value;
      return s;
    }
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(shape)) {
        properties[key] = convert(field, opts);
        if (!field.isOptional()) required.push(key);
      }
      const s: JsonSchema = { type: 'object', properties };
      if (required.length) s.required = required;
      const catchall = def.catchall as ZodTypeAny | undefined;
      if (catchall && catchall._def.typeName !== ZodFirstPartyTypeKind.ZodNever) s.additionalProperties = convert(catchall, opts);
      else if (def.unknownKeys === 'strict') s.additionalProperties = false;
      return s;
    }
    case ZodFirstPartyTypeKind.ZodRecord: {
      const s: JsonSchema = { type: 'object', additionalProperties: convert(def.valueType, opts) };
      const key = def.keyType as ZodTypeAny;
      if (key._def.typeName === ZodFirstPartyTypeKind.ZodEnum) s.propertyNames = convert(key, opts);
      return s;
    }
    case ZodFirstPartyTypeKind.ZodOptional:
      return convert(def.innerType, opts);
    case ZodFirstPartyTypeKind.ZodNullable:
      return nullable(convert(def.innerType, opts));
    case ZodFirstPartyTypeKind.ZodDefault:
      return { ...convert(def.innerType, opts), default: def.defaultValue() };
    case ZodFirstPartyTypeKind.ZodEffects:
      return convert(def.schema, opts);
    case ZodFirstPartyTypeKind.ZodUnion:
      return { anyOf: (def.options as ZodTypeAny[]).map((o) => convert(o, opts)) };
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return { oneOf: [...(def.options as Iterable<ZodTypeAny>)].map((o) => convert(o, opts)) };
    case ZodFirstPartyTypeKind.ZodIntersection:
      return { allOf: [convert(def.left, opts), convert(def.right, opts)] };
    case ZodFirstPartyTypeKind.ZodLazy:
      return convert(def.getter(), opts);
    case ZodFirstPartyTypeKind.ZodReadonly:
    case ZodFirstPartyTypeKind.ZodCatch:
      return convert(def.innerType, opts);
    case ZodFirstPartyTypeKind.ZodBranded:
      return convert(def.type, opts);
    case ZodFirstPartyTypeKind.ZodUnknown:
    case ZodFirstPartyTypeKind.ZodAny:
      return {};
    default:
      throw new Error(`zodToJsonSchema: unsupported zod type ${String(def.typeName)}`);
  }
}

/* ------------------------------------------------------------------ the document */

/** Component names of the named schemas (the order of components.schemas). */
export const INTEGRATION_SCHEMA_NAMES: ReadonlyMap<ZodTypeAny, string> = new Map<ZodTypeAny, string>([
  [integrationErrorSchema, 'Error'],
  [eventTypeSchema, 'EventType'],
  [eventCategorySchema, 'EventCategory'],
  [severitySchema, 'Severity'],
  [sessionStatusSchema, 'SessionStatus'],
  [endReasonSchema, 'EndReason'],
  [accommodationKindSchema, 'AccommodationKind'],
  [integrationExamDtoSchema, 'Exam'],
  [integrationCandidateSchema, 'CandidateInput'],
  [integrationCandidateDtoSchema, 'Candidate'],
  [integrationCandidateUpsertDtoSchema, 'CandidateUpsertResult'],
  [integrationAssignSchema, 'AssignmentRequest'],
  [integrationAssignmentDtoSchema, 'Assignment'],
  [integrationHoldDtoSchema, 'Hold'],
  [sessionWindowDtoSchema, 'Window'],
  [sessionWindowInputSchema, 'WindowInput'],
  [rescheduleRequestSchema, 'RescheduleRequest'],
  [integrationSessionDtoSchema, 'Session'],
  [integrationEventDtoSchema, 'Event'],
  [integrationSessionReportDtoSchema, 'SessionReport'],
]);

const ERROR_TEXT: Record<string, string> = {
  validation_failed: 'the request does not match the schema (`details`: a list of `{ path, message }`)',
  invalid_idempotency_key: `the ${IDEMPOTENCY_KEY_HEADER} header is malformed (1–255 characters: letters, digits and \`- _ . : ~ + / =\`)`,
  exam_not_found: 'no such exam in your organisation',
  session_not_found: 'no such session in your organisation',
  exam_not_published: 'the exam is a draft or archived',
  already_started: 'the exam has started, so its window can no longer be changed',
  invalid_state: 'the attempt has ended',
  idempotency_key_in_use: `a request with this ${IDEMPOTENCY_KEY_HEADER} is still being processed: retry after \`Retry-After\` seconds`,
};

/** `/exams/:examId/assignments` → `/exams/{examId}/assignments` */
export function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

const ref = (kind: 'schemas' | 'responses' | 'parameters' | 'headers', name: string) => ({ $ref: `#/components/${kind}/${name}` });
/** A `$ref` for a named schema, else the schema inline. */
const schemaOrRef = (schema: ZodTypeAny, refs: ReadonlyMap<ZodTypeAny, string>): JsonSchema => (refs.has(schema) ? ref('schemas', refs.get(schema)!) : zodToJsonSchema(schema, { refs }));
const json = (schema: JsonSchema) => ({ 'application/json': { schema } });

function errorResponse(status: number, codes: string[]) {
  const label = status === 400 ? 'Bad request' : status === 404 ? 'Not found' : status === 409 ? 'Conflict' : 'Error';
  const list = codes.map((c) => `\`${c}\`${ERROR_TEXT[c] ? ` — ${ERROR_TEXT[c]}` : ''}`).join('; ');
  return { description: `${label}: ${list}.`, ...(status === 409 && codes.includes('idempotency_key_in_use') ? { headers: { 'Retry-After': ref('headers', 'RetryAfter') } } : {}), content: json(ref('schemas', 'Error')) };
}

function operation(e: IntegrationEndpoint, refs: ReadonlyMap<ZodTypeAny, string>): JsonSchema {
  const parameters: JsonSchema[] = [];
  for (const p of pathParams(e.path)) {
    const description = e.params?.[p];
    if (!description) throw new Error(`${e.operationId}: describe the path parameter ${p}`);
    parameters.push({ name: p, in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });
  }
  for (const [name, field] of Object.entries(e.query?.shape ?? {}) as [string, ZodTypeAny][]) {
    const { description, ...schema } = zodToJsonSchema(field, { refs });
    parameters.push({ name, in: 'query', required: !field.isOptional(), ...(description ? { description } : {}), schema });
  }
  if (e.idempotent) parameters.push(ref('parameters', 'IdempotencyKey'));

  const rateHeaders = { 'X-RateLimit-Limit': ref('headers', 'RateLimitLimit'), 'X-RateLimit-Remaining': ref('headers', 'RateLimitRemaining'), 'X-RateLimit-Reset': ref('headers', 'RateLimitReset') };
  const responses: Record<string, unknown> = {};
  for (const r of e.responses) {
    responses[String(r.status)] = {
      description: r.description,
      headers: { ...rateHeaders, ...(e.idempotent ? { [IDEMPOTENT_REPLAYED_HEADER]: ref('headers', 'IdempotentReplayed') } : {}) },
      content: json(r.schema ? schemaOrRef(r.schema, refs) : { type: 'object' }),
    };
  }
  const codes = (status: 400 | 404 | 409) => [...(e.errors.find((x) => x.status === status)?.codes ?? [])];
  const bad = [...codes(400), ...(e.idempotent ? ['invalid_idempotency_key'] : [])];
  if (bad.length) responses['400'] = errorResponse(400, bad);
  if (e.scope) {
    responses['401'] = ref('responses', 'Unauthorized');
    responses['403'] = ref('responses', 'Forbidden');
  }
  if (codes(404).length) responses['404'] = errorResponse(404, codes(404));
  const conflicts = [...codes(409), ...(e.idempotent ? ['idempotency_key_in_use'] : [])];
  if (conflicts.length) responses['409'] = errorResponse(409, conflicts);
  if (e.idempotent) responses['422'] = ref('responses', 'IdempotencyKeyReused');
  responses['429'] = ref('responses', 'RateLimited');

  const notes = [
    e.description,
    e.scope ? `Requires the \`${e.scope}\` scope.` : 'No API key needed.',
    e.idempotent ? `Send an \`${IDEMPOTENCY_KEY_HEADER}\` header to make retries safe: a repeat with the same key and request within ${IDEMPOTENCY_KEY_TTL_HOURS} hours returns the stored response.` : '',
    e.audited ? 'Recorded in the organisation’s audit log (actor: the API key).' : '',
  ].filter(Boolean);
  return {
    operationId: e.operationId,
    summary: e.summary,
    description: notes.join('\n\n'),
    tags: [e.tag],
    security: e.scope ? [{ apiKey: [e.scope] }] : [],
    ...(parameters.length ? { parameters } : {}),
    ...(e.body ? { requestBody: { required: true, content: json(schemaOrRef(e.body, refs)) } } : {}),
    responses,
  };
}

export interface IntegrationOpenApiOptions {
  /** `servers[0].url`: the API base URL. Default `/api/v1` (relative to where the document is served). */
  serverUrl?: string;
}

/** The OpenAPI 3.1 document (plain JSON-serialisable object, deterministic key order). */
export function buildIntegrationOpenApi(opts: IntegrationOpenApiOptions = {}): JsonSchema {
  const refs = INTEGRATION_SCHEMA_NAMES;
  const schemas: Record<string, JsonSchema> = {};
  for (const [schema, name] of refs) schemas[name] = zodToJsonSchema(schema, { refs });
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const e of INTEGRATION_ENDPOINTS) (paths[openApiPath(e.path)] ??= {})[e.method.toLowerCase()] = operation(e, refs);

  const scopeList = API_KEY_SCOPES.map((s) => `* \`${s}\` — ${API_KEY_SCOPE_INFO[s].description}`).join('\n');
  return {
    openapi: '3.1.0',
    info: {
      title: 'SmartProctoring Integration API',
      version: INTEGRATION_API_VERSION,
      description: [
        'Connect an LMS, HR system or other back office: list exams, create or update candidates, assign them to exams (you receive their personal exam links), and read attempts, final reports and event lists. Webhooks (notifications we send to you) are described in docs/INTEGRATION_API.md §3.',
        'Conventions: JSON in and out; timestamps are epoch milliseconds (UTC); errors are `{ error, message, details? }` with a specific `error` code; lists take `limit` / `offset`. Responses may gain new fields at any time: ignore fields you do not know.',
        'Privacy: responses never contain images, face templates or face-similarity scores; evidence stays behind staff sign-in (`staffUrl` links).',
      ].join('\n\n'),
    },
    servers: [{ url: opts.serverUrl ?? '/api/v1' }],
    security: [{ apiKey: [] }],
    tags: [
      { name: 'Exams', description: 'Exams and assigning candidates to them.' },
      { name: 'Candidates', description: 'The people who take exams.' },
      { name: 'Sessions', description: 'Attempts: status, results, reports and events.' },
      { name: 'Meta', description: 'About the API itself.' },
    ],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'sp_live_ followed by 43 characters',
          description: `An organisation API key (Settings → Integrations → API keys), sent as \`Authorization: Bearer sp_live_…\`. Each key has scopes; each operation lists the one it requires:\n\n${scopeList}`,
        },
      },
      schemas,
      parameters: {
        IdempotencyKey: {
          name: IDEMPOTENCY_KEY_HEADER,
          in: 'header',
          required: false,
          description: `Optional. A unique value per logical request (a random UUID is ideal), so a retry cannot apply the request twice. The first successful (2xx) response is stored for ${IDEMPOTENCY_KEY_TTL_HOURS} hours, per organisation: a repeat with the same key and the same request returns it again with \`${IDEMPOTENT_REPLAYED_HEADER}: true\`. A failed request (4xx / 5xx) changed nothing and stores nothing, so it may be retried with the same key. The same key with a different method, path or body is refused (422 \`idempotency_key_reused\`); while the first request is still running, a repeat gets 409 \`idempotency_key_in_use\` (a request interrupted for more than ${IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SEC} s no longer blocks its key).`,
          schema: { type: 'string', minLength: 1, maxLength: 255, pattern: IDEMPOTENCY_KEY_PATTERN.source },
        },
      },
      headers: {
        RateLimitLimit: { description: 'Requests allowed per minute for this API key.', schema: { type: 'integer' } },
        RateLimitRemaining: { description: 'Requests left in the current window.', schema: { type: 'integer' } },
        RateLimitReset: { description: 'Seconds until the window resets.', schema: { type: 'integer' } },
        RetryAfter: { description: 'Seconds to wait before retrying.', schema: { type: 'integer' } },
        IdempotentReplayed: { description: `\`true\` when this is the stored response of an earlier request with the same \`${IDEMPOTENCY_KEY_HEADER}\`.`, schema: { type: 'string', enum: ['true'] } },
        WwwAuthenticate: { description: 'Bearer challenge (RFC 6750).', schema: { type: 'string' } },
      },
      responses: {
        Unauthorized: {
          description: 'No valid API key: `invalid_api_key` — missing, malformed, unknown or revoked; `api_key_expired` — the key is past its expiry date (an administrator creates a new one).',
          headers: { 'WWW-Authenticate': ref('headers', 'WwwAuthenticate') },
          content: json(ref('schemas', 'Error')),
        },
        Forbidden: {
          description: '`insufficient_scope` — the API key does not have the scope this operation requires (`details.requiredScope`).',
          headers: { 'WWW-Authenticate': ref('headers', 'WwwAuthenticate') },
          content: json(ref('schemas', 'Error')),
        },
        IdempotencyKeyReused: {
          description: `\`idempotency_key_reused\` — this ${IDEMPOTENCY_KEY_HEADER} was used for a different request (method, path or body) in the last ${IDEMPOTENCY_KEY_TTL_HOURS} hours. Use a new key for a new request.`,
          content: json(ref('schemas', 'Error')),
        },
        RateLimited: {
          description: '`rate_limited` — too many requests for this API key; wait `Retry-After` seconds.',
          headers: { 'Retry-After': ref('headers', 'RetryAfter') },
          content: json(ref('schemas', 'Error')),
        },
      },
    },
  };
}

/** The committed / served form: 2-space indented JSON with a final newline. */
export function integrationOpenApiJson(opts: IntegrationOpenApiOptions = {}): string {
  return `${JSON.stringify(buildIntegrationOpenApi(opts), null, 2)}\n`;
}
