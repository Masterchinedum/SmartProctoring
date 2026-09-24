import { CATEGORY_LABELS, EVENT_CATEGORIES, REVIEW_STATUSES, type Severity } from '@sp/shared';
import { DEFAULT_FILTERS, filtersActive, toggleCategory, type EventFilterState } from '../lib/filters';
import { CATEGORY_SHORT, REVIEW_LABELS } from '../lib/labels';

export function EventFilterBar({
  filters,
  onChange,
  types,
  includeIdentityChecks = false,
  shown,
  total,
}: {
  filters: EventFilterState;
  onChange: (f: EventFilterState) => void;
  types: { type: string; title: string; count: number }[];
  includeIdentityChecks?: boolean;
  shown?: number;
  total?: number;
}) {
  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <div className="filter-cats">
        {EVENT_CATEGORIES.map((c) => {
          const on = filters.categories.includes(c);
          return (
            <button
              key={c}
              type="button"
              className={`chip chip-${c}${on ? ' on' : ''}`}
              aria-pressed={on}
              title={CATEGORY_LABELS[c]}
              onClick={() => onChange(toggleCategory(filters, c))}
            >
              <span className={`cat-dot cat-dot-${c}`} aria-hidden />
              {CATEGORY_SHORT[c]}
            </button>
          );
        })}
      </div>
      <select aria-label="Type" value={filters.type} onChange={(e) => onChange({ ...filters, type: e.target.value })}>
        <option value="">All types</option>
        {includeIdentityChecks ? <option value="identity_check">Identity checks</option> : null}
        {types.map((t) => (
          <option key={t.type} value={t.type}>
            {t.title} ({t.count})
          </option>
        ))}
      </select>
      <select aria-label="Severity" value={filters.minSeverity} onChange={(e) => onChange({ ...filters, minSeverity: e.target.value as Severity | '' })}>
        <option value="">Any severity</option>
        <option value="low">Low and above</option>
        <option value="medium">Medium and above</option>
        <option value="high">High only</option>
      </select>
      <select
        aria-label="Review status"
        value={filters.review}
        onChange={(e) => onChange({ ...filters, review: e.target.value as EventFilterState['review'] })}
      >
        <option value="">Any review status</option>
        {REVIEW_STATUSES.map((r) => (
          <option key={r} value={r}>
            {REVIEW_LABELS[r]}
          </option>
        ))}
      </select>
      <label className="inline">
        <input type="checkbox" checked={filters.hideNeutral} onChange={(e) => onChange({ ...filters, hideNeutral: e.target.checked })} />
        Hide session changes
      </label>
      <label className="inline">
        <input type="checkbox" checked={filters.onlyUnreviewed} onChange={(e) => onChange({ ...filters, onlyUnreviewed: e.target.checked })} />
        Only unreviewed
      </label>
      {filtersActive(filters) ? (
        <button type="button" className="btn btn-sm" onClick={() => onChange(DEFAULT_FILTERS)}>
          Clear filters
        </button>
      ) : null}
      {shown != null && total != null ? (
        <span className="muted small filter-count">
          {shown === total ? `${total} items` : `${shown} of ${total} shown`}
        </span>
      ) : null}
    </div>
  );
}
