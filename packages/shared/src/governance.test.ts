import { describe, expect, it } from 'vitest';
import { browserFamily, compareRates, decisionThresholdsSchema, labelSimilarity, lightingClass, osFamily, resolutionClass } from './governance';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/115.0.0.0',
};

describe('decision thresholds', () => {
  it('requires the mismatch threshold below the match threshold', () => {
    expect(decisionThresholdsSchema.safeParse({ match: 0.42, mismatch: 0.24, idPhotoMatch: 0.42, idPhotoMismatch: 0.24, mismatchConfirmations: 2 }).success).toBe(true);
    const bad = decisionThresholdsSchema.safeParse({ match: 0.3, mismatch: 0.35, idPhotoMatch: 0.42, idPhotoMismatch: 0.5, mismatchConfirmations: 2 });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => i.path.join('.'))).toEqual(['mismatch', 'idPhotoMismatch']);
  });

  it('labels a similarity the way a sample is labelled', () => {
    const t = { match: 0.42, mismatch: 0.24 };
    expect(labelSimilarity(0.5, t)).toBe('match');
    expect(labelSimilarity(0.42, t)).toBe('match');
    expect(labelSimilarity(0.3, t)).toBe('inconclusive');
    expect(labelSimilarity(0.24, t)).toBe('inconclusive');
    expect(labelSimilarity(0.1, t)).toBe('mismatch');
  });
});

describe('segments', () => {
  it('recognises browsers and operating systems from the User-Agent', () => {
    expect([UA.chromeWin, UA.edge, UA.safari, UA.firefoxLinux, UA.chromebook, UA.opera, ''].map(browserFamily)).toEqual(['Chrome', 'Edge', 'Safari', 'Firefox', 'Chrome', 'Opera', 'Other']);
    expect([UA.chromeWin, UA.safari, UA.firefoxLinux, UA.chromebook, ''].map(osFamily)).toEqual(['Windows', 'macOS', 'Linux', 'ChromeOS', 'Other']);
  });

  it('bands camera resolution and face lighting', () => {
    expect([480, 720, 1080, null].map(resolutionClass)).toEqual(['low (≤ 480p)', 'HD (720p)', 'Full HD+ (≥ 1080p)', 'unknown']);
    expect([30, 70, 140, 220, null].map(lightingClass)).toEqual(['dark', 'dim', 'typical', 'bright', 'unknown']);
  });
});

describe('drift', () => {
  it('flags a large, significant change with enough data on both sides', () => {
    const c = compareRates({ n: 1000, k: 120 }, { n: 4000, k: 200 }); // 12 % vs 5 %
    expect(c.drift).toBe(true);
    expect(c.delta).toBeCloseTo(0.07, 5);
    expect(c.z).toBeGreaterThan(3);
  });

  it('does not flag chance variation, tiny changes or thin data', () => {
    expect(compareRates({ n: 1000, k: 55 }, { n: 4000, k: 200 }).drift).toBe(false); // 5.5 % vs 5 %
    expect(compareRates({ n: 100_000, k: 5_300 }, { n: 400_000, k: 20_000 }).drift).toBe(false); // significant but 0.3 pp
    expect(compareRates({ n: 20, k: 10 }, { n: 4000, k: 200 }).drift).toBe(false); // 50 % but only 20 trials
    expect(compareRates({ n: 0, k: 0 }, { n: 10, k: 1 })).toMatchObject({ delta: null, z: null, drift: false });
  });
});
