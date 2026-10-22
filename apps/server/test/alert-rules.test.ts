/**
 * docs/prometheus-alerts.yml stays usable without promtool in CI: it parses (with a reader for the YAML subset the
 * file uses), every rule has what Prometheus and the on-call need, every series an expression uses is one the server
 * exports, every runbook link resolves to docs/OPERATIONS.md, and every exported series is documented there.
 * (`promtool check rules docs/prometheus-alerts.yml` additionally checks PromQL syntax where promtool is installed.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppMetrics } from '../src/lib/metrics.js';

const DOCS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'docs');

type Yaml = string | Yaml[] | { [k: string]: Yaml };

/**
 * The YAML subset of the rules file: block mappings and sequences by indentation, `|` literal blocks, `{ a: b }`
 * flow mappings, plain / single- / double-quoted scalars, full-line comments. Anything else is an error.
 */
function parseYamlSubset(text: string): Yaml {
  const lines = text
    .split('\n')
    .map((raw, i) => ({ n: i + 1, raw, indent: raw.length - raw.trimStart().length, body: raw.trim() }))
    .filter((l) => l.body !== '' && !l.body.startsWith('#'));
  let pos = 0;
  const fail = (msg: string, l = lines[pos]): never => {
    throw new Error(`line ${l?.n ?? 'end'}: ${msg}`);
  };
  const scalar = (v: string, l: (typeof lines)[number]): Yaml => {
    if (v.startsWith('"')) {
      if (!v.endsWith('"') || v.length < 2) fail('unterminated double-quoted string', l);
      return JSON.parse(v) as string;
    }
    if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2) fail('unterminated single-quoted string', l);
      return v.slice(1, -1).replace(/''/g, "'");
    }
    if (v.startsWith('{')) {
      if (!v.endsWith('}')) fail('unterminated flow mapping', l);
      const out: Record<string, Yaml> = {};
      for (const part of v.slice(1, -1).split(',')) {
        const m = /^\s*([\w.-]+):\s*(.+?)\s*$/.exec(part);
        if (!m) fail(`bad flow mapping entry "${part}"`, l);
        out[m![1]] = scalar(m![2], l);
      }
      return out;
    }
    if (/^[[&*!%@`]/.test(v) || / #/.test(v)) fail(`unsupported YAML in "${v}"`, l);
    return v;
  };
  const literal = (parentIndent: number): string => {
    const block: string[] = [];
    const start = lines[pos];
    if (!start || start.indent <= parentIndent) fail('empty literal block');
    const indent = start.indent;
    // Literal blocks keep their blank lines and comment-looking lines: read the raw text up to the next dedent.
    const all = text.split('\n');
    let i = start.n - 1;
    for (; i < all.length; i++) {
      const raw = all[i];
      if (raw.trim() !== '' && raw.length - raw.trimStart().length < indent) break;
      block.push(raw.slice(indent));
    }
    while (pos < lines.length && lines[pos].n <= i) pos++;
    return block.join('\n').trimEnd() + '\n';
  };
  const mapping = (indent: number, first?: { key: string; rest: string; line: (typeof lines)[number] }): Record<string, Yaml> => {
    const out: Record<string, Yaml> = {};
    const entry = (key: string, rest: string, l: (typeof lines)[number]) => {
      if (key in out) fail(`duplicate key "${key}"`, l);
      if (rest === '') out[key] = block(indent);
      else if (rest === '|' || rest === '|-') out[key] = literal(indent);
      else out[key] = scalar(rest, l);
    };
    if (first) entry(first.key, first.rest, first.line);
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].body.startsWith('- ')) {
      const l = lines[pos++];
      const m = /^([\w.-]+):(?:\s+(.*))?$/.exec(l.body);
      if (!m) fail(`expected "key: value", got "${l.body}"`, l);
      entry(m![1], (m![2] ?? '').trim(), l);
    }
    return out;
  };
  const block = (parentIndent: number): Yaml => {
    const l = lines[pos];
    if (!l || l.indent <= parentIndent) return '';
    if (l.body.startsWith('- ')) {
      const items: Yaml[] = [];
      const indent = l.indent;
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].body.startsWith('- ')) {
        const item = lines[pos++];
        const body = item.body.slice(2);
        const m = /^([\w.-]+):(?:\s+(.*))?$/.exec(body);
        items.push(m ? mapping(indent + 2, { key: m[1], rest: (m[2] ?? '').trim(), line: item }) : scalar(body, item));
      }
      return items;
    }
    return mapping(l.indent);
  };
  const doc = block(-1);
  if (pos < lines.length) fail('unexpected indentation');
  return doc;
}

interface Rule {
  alert: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

const rulesText = readFileSync(join(DOCS, 'prometheus-alerts.yml'), 'utf8');
const operations = readFileSync(join(DOCS, 'OPERATIONS.md'), 'utf8');
const doc = parseYamlSubset(rulesText) as unknown as { groups: { name: string; rules: Rule[] }[] };
const rules = doc.groups.flatMap((g) => g.rules);

/** Anchors in OPERATIONS.md: GitHub heading slugs and explicit <a id="…">. */
function anchors(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of md.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    out.add(
      m[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s/g, '-'),
    );
  }
  for (const m of md.matchAll(/<a id="([^"]+)"><\/a>/g)) out.add(m[1]);
  return out;
}

/** Series the server exports (histograms add _bucket / _sum / _count). */
const exported = new Set(new AppMetrics().registry.getMetricsAsArray().map((m) => m.name));
const seriesBase = (s: string) => (exported.has(s) ? s : s.replace(/_(bucket|sum|count)$/, ''));

describe('docs/prometheus-alerts.yml', () => {
  it('parses into groups of rules (YAML subset reader self-check)', () => {
    expect(parseYamlSubset('a:\n  - b: "x"\n    c: { d: e, f: g }\n    h: |\n      one\n\n      two\n')).toEqual({ a: [{ b: 'x', c: { d: 'e', f: 'g' }, h: 'one\n\ntwo\n' }] });
    expect(() => parseYamlSubset('a: 1\na: 2\n')).toThrow(/duplicate key/);
    expect(() => parseYamlSubset('a:\n  b: 1\n c: 2\n')).toThrow(/indentation|expected/);
    expect(doc.groups.length).toBeGreaterThan(3);
    expect(new Set(doc.groups.map((g) => g.name)).size).toBe(doc.groups.length);
    expect(rules.length).toBeGreaterThan(20);
  });

  it('every rule has a unique name, an expression, a duration, a severity and a summary', () => {
    const problems: string[] = [];
    const names = new Set<string>();
    for (const r of rules) {
      if (!/^SmartProctoring[A-Z]\w+$/.test(r.alert ?? '')) problems.push(`bad alert name ${r.alert}`);
      if (names.has(r.alert)) problems.push(`duplicate alert ${r.alert}`);
      names.add(r.alert);
      if (typeof r.expr !== 'string' || !r.expr.trim()) problems.push(`${r.alert}: no expr`);
      if (r.for !== undefined && !/^\d+[smhd]$/.test(r.for)) problems.push(`${r.alert}: bad for "${r.for}"`);
      if (!['critical', 'warning', 'info'].includes(r.labels?.severity ?? '')) problems.push(`${r.alert}: severity must be critical, warning or info`);
      if (!r.annotations?.summary) problems.push(`${r.alert}: no summary`);
      const opened = (r.expr.match(/\(/g) ?? []).length;
      const closed = (r.expr.match(/\)/g) ?? []).length;
      if (opened !== closed) problems.push(`${r.alert}: unbalanced parentheses`);
      if ((r.expr.match(/\{/g) ?? []).length !== (r.expr.match(/\}/g) ?? []).length) problems.push(`${r.alert}: unbalanced braces`);
    }
    expect(problems).toEqual([]);
  });

  it('uses only series the server exports', () => {
    const unknown = rules.flatMap((r) => [...r.expr.matchAll(/\bsp_[a-z0-9_]+/g)].map((m) => m[0]).filter((s) => !exported.has(seriesBase(s))).map((s) => `${r.alert}: ${s}`));
    expect(unknown).toEqual([]);
  });

  it('links runbooks that exist in docs/OPERATIONS.md', () => {
    const known = anchors(operations);
    const broken = rules
      .filter((r) => r.annotations?.runbook_url)
      .map((r) => [r.alert, r.annotations!.runbook_url] as const)
      .filter(([, url]) => {
        const m = /^docs\/OPERATIONS\.md#(.+)$/.exec(url);
        return !m || !known.has(m[1]);
      });
    expect(broken).toEqual([]);
    expect(rules.filter((r) => r.annotations?.runbook_url).length).toBeGreaterThan(10);
  });

  it('every series the server exports is documented in docs/OPERATIONS.md §5', () => {
    const section = operations.slice(operations.indexOf('## 5. Health and monitoring'), operations.indexOf('## 6.'));
    const undocumented = [...exported].filter((name) => name.startsWith('sp_') && !section.includes(name));
    expect(undocumented).toEqual([]);
  });
});
