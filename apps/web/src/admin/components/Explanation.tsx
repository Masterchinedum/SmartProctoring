import type { EventExplanation, ExplanationFactor } from '@sp/shared';

const EFFECT: Record<ExplanationFactor['effect'], { label: string; cls: string }> = {
  supports: { label: 'Supports', cls: 'factor-supports' },
  weakens: { label: 'Less reliable', cls: 'factor-weakens' },
  explains: { label: 'May explain it', cls: 'factor-explains' },
  context: { label: 'Context', cls: 'factor-context' },
};

/** "Why this was recorded": the rule with this exam's settings, what was measured, and what weighs for / against. */
export function ExplanationPanel({ explanation }: { explanation: EventExplanation }) {
  const { rule, measured, factors, notConcluded, confidence } = explanation;
  if (!rule && !measured.length && !factors.length && !notConcluded) return null;
  return (
    <section className="explanation" aria-labelledby="explanation-title" data-testid="explanation">
      <h3 id="explanation-title">Why this was recorded</h3>
      {rule ? <p className="explanation-rule">{rule}</p> : null}
      {measured.length || confidence ? (
        <ul className="explanation-measured">
          {measured.map((m) => (
            <li key={m}>{m}</li>
          ))}
          {confidence ? (
            <li>
              Detector confidence: {confidence.label.toLowerCase()} ({Math.round(confidence.value * 100)} %).
            </li>
          ) : null}
        </ul>
      ) : null}
      {factors.length ? (
        <ul className="explanation-factors">
          {factors.map((f) => (
            <li key={`${f.effect}:${f.text}`} className={EFFECT[f.effect].cls}>
              <span className="factor-label">{EFFECT[f.effect].label}</span> {f.text}
            </li>
          ))}
        </ul>
      ) : null}
      {notConcluded ? (
        <div className="banner banner-info small" role="note">
          <strong>What this is not:</strong> {notConcluded}
        </div>
      ) : null}
    </section>
  );
}
