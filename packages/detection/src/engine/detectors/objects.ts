import type { EventType } from '@sp/shared';
import type { DetectorHost, TickContext } from '../context';
import { dur, Span, type FlushReason } from '../span';
import { round } from '../../util/math';

interface Tracked {
  label: string;
  type: EventType;
  minScore: () => number;
  span: Span;
  maxScore: number;
  sumScore: number;
  hits: number;
  ticks: number;
}

/** Labels (COCO names from EfficientDet-Lite) reported as other devices / materials. */
export const UNAUTHORIZED_LABELS = ['book', 'laptop', 'tv'] as const;

const ARTICLE: Record<string, string> = { book: 'a book', laptop: 'a laptop', tv: 'a TV or monitor', 'cell phone': 'a mobile phone' };

/**
 * phone_detected ('cell phone' ≥ phoneMinConfidence) and unauthorized_object ('book', 'laptop', 'tv'
 * ≥ objectMinConfidence; one episode per label). The object detector runs at ~1 Hz: only ticks where
 * it ran (obs.objects !== null) are counted — other ticks are neither presence nor absence. Onset needs
 * the object in ≥ 60% of detector ticks over ≥ objectPersistSec with ≥ 2 hits (a single-frame false
 * detection never flags; one missed detection inside an episode is tolerated). If the detector stops
 * running for 6 s the open episode is closed at the last observation.
 */
export class ObjectDetector {
  private tracked: Tracked[] = [];

  constructor(private host: DetectorHost) {
    const p = host.policy;
    const params = { onsetMs: p.objectPersistSec * 1000, clearMs: Math.max(p.clearSec * 1000, 2500), minFraction: 0.6, gapTolMs: 2500, minTicks: 2 };
    const make = (label: string, type: EventType, key: string, minScore: () => number): Tracked => {
      const tr: Tracked = {
        label,
        type,
        minScore,
        maxScore: 0,
        sumScore: 0,
        hits: 0,
        ticks: 0,
        span: null as unknown as Span,
      };
      tr.span = new Span(host, type, key, params, {
        describe: (d) => {
          const what = ARTICLE[label] ?? `a ${label}`;
          const mean = tr.hits ? tr.sumScore / tr.hits : 0;
          return {
            details: {
              durationSec: d.durationSec,
              label,
              maxScore: round(tr.maxScore, 3),
              meanScore: round(mean, 3),
              detections: tr.hits,
              detectorRuns: tr.ticks,
            },
            observation:
              d.phase === 'close'
                ? `An object resembling ${what} was detected in the camera view for ${dur(d.durationSec)} (highest detector score ${round(tr.maxScore, 2)}).`
                : `An object resembling ${what} is visible in the camera view (detector score ${round(tr.maxScore, 2)}).`,
          };
        },
      });
      if (type === 'phone_detected') {
        tr.span.onBegin = () => host.prompts.set('phone_visible', true, host.signals);
        tr.span.onEnd = () => host.prompts.set('phone_visible', false, host.signals);
      }
      return tr;
    };
    this.tracked.push(make('cell phone', 'phone_detected', 'phone_detected', () => this.host.policy.phoneMinConfidence));
    for (const l of UNAUTHORIZED_LABELS) this.tracked.push(make(l, 'unauthorized_object', `unauthorized_object:${l}`, () => this.host.policy.objectMinConfidence));
  }

  step(ctx: TickContext): void {
    if (!this.host.policy.enabled.objects) return;
    if (!ctx.objectsRan || !ctx.objects) {
      for (const tr of this.tracked) tr.span.expire(ctx.t, 6000);
      return;
    }
    for (const tr of this.tracked) {
      let best = 0;
      if (ctx.visionOk) {
        const min = tr.minScore();
        for (const o of ctx.objects) if (o && o.label === tr.label && o.score >= min && o.score > best) best = o.score;
      }
      const v = ctx.visionOk ? best > 0 : null;
      const sp = tr.span;
      if (v !== null) {
        if (!sp.deb.active && sp.deb.runStart === null && v) {
          tr.maxScore = tr.sumScore = tr.hits = tr.ticks = 0;
        }
        if (sp.deb.active || sp.deb.runStart !== null || v) tr.ticks++;
        if (v) {
          tr.hits++;
          tr.sumScore += best;
          if (best > tr.maxScore) {
            tr.maxScore = best;
            if (sp.deb.active) sp.requestPeak(ctx.t);
          }
        }
      }
      sp.feed(ctx.t, v, best || 1);
    }
  }

  openLabels(): string[] {
    return this.tracked.filter((tr) => tr.span.active).map((tr) => tr.label);
  }

  flush(t: number, reason: FlushReason): void {
    for (const tr of this.tracked) tr.span.flush(t, reason);
    this.host.prompts.set('phone_visible', false, this.host.signals);
    this.reset();
  }

  reset(): void {
    for (const tr of this.tracked) {
      tr.span.reset();
      tr.maxScore = tr.sumScore = tr.hits = tr.ticks = 0;
    }
  }
}
