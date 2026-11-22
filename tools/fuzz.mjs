// fuzz.mjs — differential fuzzer: baseline vs ref vs mine on generated cases biased at the
// rewritten semantics (inline emphasis/code/links/escapes, slugify Unicode, wordsOf whitespace,
// front matter, templates incl. for-loop scope reuse, lex block dispatch, links).
// Usage: node tools/fuzz.mjs [seeds] [perSeed]   (default 20 x 200 = 4000 cases)
// Failures are saved to /tmp/sitegen/fuzz-fail-<seed>-<n>.json (input + which side differed).
import { mkdirSync, writeFileSync } from 'node:fs';

const KIT = process.env.KIT ?? '/home/hatch/workspace/makefun/site-generator-speed-01-run-20261122-kit/site-generator-speed-01-run-20261122-kit';
const ROOT = new URL('..', import.meta.url).pathname;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'echo', 'São', 'Paulo', 'smörgåsbord', 'naïve', 'café', 'a', 'I', 'x', '123', 'hello-world', 'under_score', 'MiXeD', 'Ωμέγα', 'λ', '🎉', 'é', 'ﬀ'];
const WS = [' ', ' ', ' ', '\t', '\u00a0', '\u2003', '\u2028', '\u2029', '\u3000', '\x0b', '\x0c', '\x00', '\x01'];

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
function maybe(r, p) { return r() < p; }
function word(r) { return pick(r, WORDS); }
function words(r, n) { return Array.from({ length: n }, () => word(r)).join(pick(r, [' ', ' ', ' ', '  ', '\t'])); }

// Inline fragments biased at the rewritten inline() + finders.
function inlineFrag(r, depth) {
  const k = Math.floor(r() * 16);
  switch (k) {
    case 0: return `*${word(r)}*`;
    case 1: return `**${word(r)}**`;
    case 2: return `*${word(r)}**${word(r)}*`; // **-skip-both trap
    case 3: return `**${word(r)}*${word(r)}**`;
    case 4: return `\\*${word(r)}\\*`; // escaped stars
    case 5: return `\\\\*${word(r)}*`; // backslash-backslash star
    case 6: return `\`${word(r)} ${word(r)}\``;
    case 7: return `\`${word(r)}`; // unclosed backtick
    case 8: return `[${word(r)}](target-${Math.floor(r() * 3)}.md)`;
    case 9: return `[${word(r)}](${word(r)} ${word(r)})`; // whitespace target: not a link
    case 10: return `[${word(r)}](https://example.com/${word(r)})`;
    case 11: return `[${word(r)}](#frag)`;
    case 12: return `*${word(r)}*${word(r)}*`; // star after em
    case 13: return `**${word(r)}**${word(r)}**`;
    case 14: return depth < 2 ? `*a ${inlineFrag(r, depth + 1)} b*` : word(r); // nested emphasis
    default: return `${words(r, 1 + Math.floor(r() * 3))} & < > " ' _${word(r)}_`;
  }
}

function bodyLine(r) {
  const k = Math.floor(r() * 12);
  switch (k) {
    case 0: return `${'#'.repeat(1 + Math.floor(r() * 7))} ${words(r, 2)}${maybe(r, 0.3) ? '   ' : ''}`;
    case 1: return `${'#'.repeat(1 + Math.floor(r() * 3))}${words(r, 1)}`; // no space: not a heading
    case 2: { const lang = pick(r, ['', 'js', 'py', 'c++', 'a-b_c']); return `\`\`\`${lang}`; }
    case 3: return '```';
    case 4: return pick(r, ['---', '***', '---   ', '***\t', '--', '****']);
    case 5: return `${pick(r, ['>', '> ', '>>', '>', '>'])}${maybe(r, 0.5) ? ' ' : ''}${inlineFrag(r, 0)}`;
    case 6: return `${pick(r, ['- ', '* ', '1. ', '2. ', '12. ', '1234567890. '])}${inlineFrag(r, 0)}`;
    case 7: return `  ${inlineFrag(r, 0)}`; // continuation-looking line
    case 8: return '';
    case 9: return `   ${inlineFrag(r, 0)}   `; // indented paragraph line
    case 10: return `${inlineFrag(r, 0)} ${inlineFrag(r, 0)}`;
    default: return `${words(r, 1 + Math.floor(r() * 5))}${maybe(r, 0.2) ? ' \\' : ''}`;
  }
}

function body(r) {
  const lines = [];
  const n = 1 + Math.floor(r() * 14);
  for (let i = 0; i < n; i++) lines.push(bodyLine(r));
  let text = lines.join(maybe(r, 0.15) ? '\r\n' : '\n');
  if (maybe(r, 0.1)) text += '\r\n';
  return text;
}

function frontMatter(r) {
  const lines = ['---'];
  if (maybe(r, 0.05)) return 'no front matter\n' + body(r); // no fm at all
  if (maybe(r, 0.05)) lines.push('# a comment', '   ');
  const keys = [];
  if (maybe(r, 0.95)) keys.push(`title: ${maybe(r, 0.3) ? `"${word(r)} \\"q\\" ${word(r)}"` : words(r, 1 + Math.floor(r() * 3))}`);
  if (maybe(r, 0.6)) keys.push(`date: 20${String(26 + Math.floor(r() * 5))}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`);
  if (maybe(r, 0.1)) keys.push(`date: 2026-02-30`); // invalid day
  if (maybe(r, 0.1)) keys.push(`date: not-a-date`);
  if (maybe(r, 0.5)) keys.push(`tags: [${Array.from({ length: Math.floor(r() * 4) }, () => word(r)).join(', ')}]`);
  if (maybe(r, 0.08)) keys.push('tags: []');
  if (maybe(r, 0.05)) keys.push('tags: [a, , b]');
  if (maybe(r, 0.1)) keys.push(`draft: ${pick(r, ['true', 'false', 'yes'])}`);
  if (maybe(r, 0.4)) keys.push(`layout: ${pick(r, ['post', 'page', 'custom', 'nope', 'UPPER', 'a-b'])}`);
  if (maybe(r, 0.3)) keys.push(`slug: ${pick(r, ['ok-slug', 'Bad_Slug', 'a'.repeat(65), 'a--b', '-a', 'a-'])}`);
  if (maybe(r, 0.2)) keys.push(`summary: ${words(r, 3)}`);
  if (maybe(r, 0.05)) keys.push('bogus: 1'); // unknown key
  if (maybe(r, 0.05)) keys.push('title: dup'); // duplicate title
  if (maybe(r, 0.05)) keys.push('title:'); // no value
  if (maybe(r, 0.05)) keys.push('notakeyvalue'); // not "key: value"
  for (const k of keys) lines.push(k);
  if (maybe(r, 0.05)) return lines.join('\n'); // unclosed fm
  lines.push('---');
  return lines.join('\n') + '\n' + body(r);
}

const TEMPLATES = [
  '<html><head><title>{{ site.title }}</title></head><body>{{ page.content }}</body></html>',
  '{% for p in posts %}<a href="{{ p.url }}">{{ p.title }}</a>{% endfor %}',
  '{% for p in posts %}{{ loop.index }}:{{ p.title }},{% endfor %}',
  '{% for loop in posts %}{{ loop }}{% endfor %}', // loop var named "loop"
  '{% for x in tags %}{{ x.name }}({{ x.count }}){% endfor %}',
  '{% if page.is_post %}POST{% else %}PAGE{% endif %}',
  '{% if not page.is_post %}NOTPOST{% endif %}',
  '{{ page.title }}|{{ page.date_long }}|{{ page.reading_minutes }}|{{ page.excerpt }}',
  '{% include "head" %}<main>{{ page.content }}</main>',
  '{% for p in recent %}{{ p.title }};{% endfor %}{{ site.base_url }}',
  '{{ page.toc }}{% for h in page.toc %}{{ h.level }}-{{ h.id }};{% endfor %}',
  '{{ missing.deep.path }}|{{ page.tags }}|{{ page.newer }}|{{ page.older }}',
  '{{{ page.content }}}',
  '{% for p in posts %}{% for t in p.tags %}{{ t.slug }} {% endfor %}{% endfor %}',
  'plain text, no tags at all',
  '{{ unclosed',
  '{% for p in posts %}never closed',
  '{% if page %}x{% endif %}{% endfor %}',
  '{% include "missing" %}after',
  '{% include "self" %}',
  'a\n{% for p in posts %}\n{{ p.title }}\n{% endfor %}\nb',
  '{{ page.title }}',
];

function genCase(r) {
  const files = [];
  const nFiles = 3 + Math.floor(r() * 12);
  const dirs = ['posts', 'posts/2023', 'docs', 'docs/a', 'about', '', 'tags', 'page'];
  for (let i = 0; i < nFiles; i++) {
    const dir = pick(r, dirs);
    const name = `${word(r).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}.md`;
    const path = dir === '' ? name : `${dir}/${name}`;
    files.push({ path, content: frontMatter(r) });
  }
  // Some static files, sometimes shadowing a built path.
  for (let i = 0; i < Math.floor(r() * 3); i++) {
    files.push({ path: pick(r, ['style.css', 'robots.txt', 'img/logo.png', 'index.html']), content: `static ${i} ${words(r, 3)}` });
  }
  const templates = {};
  const names = ['post', 'page', 'index', 'tag', 'tags', 'custom', 'head', 'self'];
  for (const n of names) if (maybe(r, 0.85)) templates[n] = pick(r, TEMPLATES);
  return {
    site: {
      title: words(r, 2),
      base_url: pick(r, ['https://x.example/blog', 'https://x.example/blog/', 'https://x.example/blog///']),
      per_page: 1 + Math.floor(r() * 8),
      recent: Math.floor(r() * 5),
    },
    templates,
    files,
  };
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const seeds = Number(process.argv[2] ?? 20);
const perSeed = Number(process.argv[3] ?? 200);
const baseline = (await import(`${KIT}/baselines/makefun-site/solve.js`)).run;
const ref = (await import(`${ROOT}solve.ref.js`)).run;
const mine = (await import(`${ROOT}solve.js`)).run;

mkdirSync('/tmp/sitegen', { recursive: true });
let ran = 0, failed = 0;
for (let seed = 1; seed <= seeds && failed < 5; seed++) {
  const r = mulberry32(seed);
  for (let n = 0; n < perSeed && failed < 5; n++) {
    const input = genCase(r);
    ran++;
    let b, f, m;
    try { b = canonical(baseline(input)); } catch (e) { b = `THREW ${e}`; }
    try { f = canonical(ref(input)); } catch (e) { f = `THREW ${e}`; }
    try { m = canonical(mine(input)); } catch (e) { m = `THREW ${e}`; }
    if (b !== f || b !== m) {
      failed++;
      const file = `/tmp/sitegen/fuzz-fail-${seed}-${n}.json`;
      writeFileSync(file, JSON.stringify({ seed, n, input, base: b, ref: f, mine: m }, null, 2));
      console.log(`FAIL seed=${seed} n=${n} ref==base:${f === b} mine==base:${m === b} -> ${file}`);
    }
  }
}
console.log(`fuzz: ${ran} cases, ${failed} failures`);
process.exit(failed === 0 ? 0 : 1);
