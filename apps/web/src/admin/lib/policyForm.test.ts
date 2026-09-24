import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, proctoringPolicySchema } from '@sp/shared';
import {
  ALL_POLICY_FIELDS,
  changedFromDefault,
  formatPolicyValue,
  getPath,
  leafPaths,
  normalizePolicy,
  parsePolicyNumber,
  setPath,
  validatePolicy,
} from './policyForm';

describe('policy form metadata', () => {
  it('covers every field of the policy schema exactly once', () => {
    const schemaPaths = leafPaths(DEFAULT_POLICY).sort();
    const formPaths = ALL_POLICY_FIELDS.map((f) => f.path).sort();
    expect(new Set(formPaths).size).toBe(formPaths.length);
    expect(formPaths).toEqual(schemaPaths);
  });

  it('declares enum options that the schema accepts', () => {
    for (const f of ALL_POLICY_FIELDS.filter((x) => x.kind === 'enum')) {
      for (const o of f.options ?? []) {
        const r = proctoringPolicySchema.safeParse(setPath(DEFAULT_POLICY, f.path, o.value));
        expect(r.success, `${f.path}=${o.value}`).toBe(true);
      }
    }
  });

  it('has min/max bounds consistent with the schema', () => {
    for (const f of ALL_POLICY_FIELDS.filter((x) => x.kind !== 'boolean' && x.kind !== 'enum')) {
      if (f.min != null) {
        expect(proctoringPolicySchema.safeParse(setPath(DEFAULT_POLICY, f.path, f.min)).success, `${f.path} min`).toBe(true);
        const below = f.kind === 'number' ? f.min - 0.01 : f.min - 1;
        expect(proctoringPolicySchema.safeParse(setPath(DEFAULT_POLICY, f.path, below)).success, `${f.path} below min`).toBe(false);
      }
      if (f.max != null) expect(proctoringPolicySchema.safeParse(setPath(DEFAULT_POLICY, f.path, f.max)).success, `${f.path} max`).toBe(true);
    }
  });
});

describe('path helpers', () => {
  it('gets and immutably sets nested values', () => {
    const next = setPath(DEFAULT_POLICY, 'detection.enabled.objects', false);
    expect(getPath(next, 'detection.enabled.objects')).toBe(false);
    expect(getPath(DEFAULT_POLICY, 'detection.enabled.objects')).toBe(true);
    expect(next.detection.enabled.absence).toBe(true);
    expect(next.identity).toBe(DEFAULT_POLICY.identity);
    expect(getPath(DEFAULT_POLICY, 'nope.nothing')).toBeUndefined();
  });
});

describe('normalize / validate / diff', () => {
  it('fills defaults for partial stored policies and falls back on invalid ones', () => {
    const p = normalizePolicy({ pause: { requireApproval: true } });
    expect(p.pause.requireApproval).toBe(true);
    expect(p.pause.allowed).toBe(true);
    expect(p.detection.absenceSec).toBe(DEFAULT_POLICY.detection.absenceSec);
    expect(normalizePolicy({ identity: { livenessSteps: 99 } })).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
  });

  it('reports schema errors by dotted path', () => {
    const r = validatePolicy(setPath(DEFAULT_POLICY, 'identity.livenessSteps', 9));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain('identity.livenessSteps');
    expect(validatePolicy(DEFAULT_POLICY).ok).toBe(true);
  });

  it('lists fields changed from defaults', () => {
    expect(changedFromDefault(DEFAULT_POLICY)).toEqual([]);
    const p = setPath(setPath(DEFAULT_POLICY, 'pause.maxPauses', 2), 'browser.requireFullscreen', false);
    expect(changedFromDefault(p).sort()).toEqual(['browser.requireFullscreen', 'pause.maxPauses']);
  });
});

describe('number parsing and display', () => {
  const field = (path: string) => ALL_POLICY_FIELDS.find((f) => f.path === path)!;
  it('parses integers, decimals and nullable values with range checks', () => {
    expect(parsePolicyNumber(field('identity.livenessSteps'), '3')).toEqual({ value: 3 });
    expect(parsePolicyNumber(field('identity.livenessSteps'), '2.5')).toEqual({ error: 'Enter a whole number' });
    expect(parsePolicyNumber(field('identity.livenessSteps'), '5')).toEqual({ error: 'Maximum 4' });
    expect(parsePolicyNumber(field('identity.livenessSteps'), '')).toEqual({ error: 'Required' });
    expect(parsePolicyNumber(field('detection.multiplePeopleSec'), '0.5')).toEqual({ value: 0.5 });
    expect(parsePolicyNumber(field('detection.multiplePeopleSec'), '0.1')).toEqual({ error: 'Minimum 0.3' });
    expect(parsePolicyNumber(field('pause.maxPauses'), '')).toEqual({ value: null });
    expect(parsePolicyNumber(field('pause.maxPauseDurationSec'), '30')).toEqual({ error: 'Minimum 60' });
    expect(parsePolicyNumber(field('pause.maxPauses'), 'abc')).toEqual({ error: 'Enter a number' });
  });
  it('formats values for hints', () => {
    expect(formatPolicyValue(field('pause.maxPauses'), null)).toBe('Unlimited');
    expect(formatPolicyValue(field('pause.allowed'), true)).toBe('On');
    expect(formatPolicyValue(field('identity.onMismatch'), 'flag_only')).toBe('Flag only (exam continues)');
    expect(formatPolicyValue(field('detection.lookAwayYawDeg'), 28)).toBe('28°');
    expect(formatPolicyValue(field('retention.evidenceDays'), 30)).toBe('30 days');
  });
});
