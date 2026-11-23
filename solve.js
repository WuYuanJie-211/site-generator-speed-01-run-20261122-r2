// solve.js — a faster drop-in for makefun-site 1.0.0, written fresh in this session.
// Same answers as the baseline on every input (verified against solve.ref.js, the literal-port
// oracle, and the kit's expected.json). Rewrites, each gated by full parity + fuzz, logged in BENCH.md:
//   R1 inline(): one regex scan + slice appends; indexOf-based findUnescaped/findSingleStar.
//   R2 wordsOf: manual transition count; cardOf computed once per post and reused in pageOf;
//      readSources: skip the CR replace when the text holds no '\r'; slugify: ASCII fast path
//      (NFKD is identity on ASCII, no combining marks); template for: one scope object reused.
//   R3 lex+render fusion: blocks rendered as recognised, no token objects.
//   R4 escapeHtml: test-first fast path (most strings hold nothing to escape).
//   R5 (round 2) wordsOf: Uint8Array whitespace table; inline(): range-based with one
//      accumulator (nested content rendered in place, never sliced and re-scanned).
//   R6 (round 2) renderMarkdown: manual line dispatch (no per-line regexes), manual trimLine,
//      block assembly by join; front matter: body as lines (no join then re-split), manual
//      "key: value" parse, wordsOf over lines.
//   R7 (round 2) templates: tokenize+parse fused into one pass (no token objects);
//      renderNodes: accumulator array joined once (no per-node string roping).
// Hard rules kept: no cross-case caching (all memoisation is per-run()); no hand-written JSON;
// key order, sort stability, slug collisions, __proto__ hazards and error text preserved verbatim.

/* ---- text ---- */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped; unchanged (same string) when nothing needs escaping. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

/** The slug of `text` (README "Text"). ASCII fast path: NFKD is identity on ASCII and ASCII holds no
 * combining marks, so the normalise + mark-strip steps are skipped for pure-ASCII input. */
function slugify(text) {
  const plain = /[^\x00-\x7f]/.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/* ---- front matter (the baseline's grammar, unchanged) ---- */

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** {key, raw} for a "key: value" front-matter line, else null. Preserves the LINE regex
 * exactly: the key is [a-z_]+, then ':', then either nothing or one space plus the rest;
 * a non-empty rest that does not start with a space is not a "key: value" line at all.
 * `raw` keeps a leading space when two follow the colon, and loses trailing spaces/tabs. */
function lineKeyValue(line) {
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (k === 0 || line[k] !== ':') return null;
  let raw = line.slice(k + 1);
  if (raw === '') return { key: line.slice(0, k), raw: '' };
  if (raw[0] !== ' ') return null;
  raw = raw.slice(1);
  let e = raw.length;
  while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
  return { key: line.slice(0, k), raw: raw.slice(0, e) };
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.startsWith('#')) continue;
    const kv = lineKeyValue(line);
    if (kv === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = kv.key;
    const raw = kv.raw;
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // The body as lines: renderMarkdown takes lines, and wordsOf sums over them (a newline is
  // whitespace, so words never span lines) — no join then re-split.
  return { data, lines: lines.slice(close + 1) };
}

/* ---- markdown: lex + render fused (R3), inline by regex scan (R1) ---- */

/** Manual line dispatch (no per-line regexes): the block recognisers, each a first-char test
 * plus a hand scan. Every one preserves its regex's exact accept/reject behaviour. */

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** The fence language when `line` opens a fence (``` + [A-Za-z0-9_+-]* + trailing spaces/tabs), else null. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** {depth, text} when `line` is a heading (1-6 #, a space/tab, non-empty text after trailing-space strip), else null. */
function headingOf(line) {
  let h = 0;
  while (h < 6 && line[h] === '#') h++;
  if (h === 0 || line[h] === '#') return null;
  if (line[h] !== ' ' && line[h] !== '\t') return null;
  let a = h;
  while (line[a] === ' ' || line[a] === '\t') a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: h, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break (exactly --- or *** + trailing spaces/tabs). */
function isHr(line) {
  if (line.length < 3) return false;
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  if (line[1] !== c || line[2] !== c) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** {text} when `line` is a bullet item (- or * + one space + anything), else null. */
function bulletOf(line) {
  const c = line[0];
  if ((c === '-' || c === '*') && line[1] === ' ') return { text: line.slice(2) };
  return null;
}

/** {num, text} when `line` is an ordered item (1-9 digits + ". " + anything), else null. */
function orderedOf(line) {
  let d = 0;
  while (d < 9 && line[d] >= '0' && line[d] <= '9') d++;
  if (d === 0) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { num: line.slice(0, d), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item (2+ spaces, then a non-whitespace character). */
function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let k = 2;
  while (line[k] === ' ') k++;
  return k < line.length && WS_TABLE[line.charCodeAt(k)] === 0;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break (first-char dispatch). */
function endsParagraph(line) {
  const c = line[0];
  if (c === undefined) return true;
  if (c === '`') return fenceLang(line) !== null;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHr(line);
  if (c === ' ' || c === '\t') return isBlank(line);
  return false;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** A quote line with its `>` and one optional space stripped. */
const stripQuote = (line) => (line[1] === ' ' ? line.slice(2) : line.slice(1));

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * indexOf-based: jump to the next candidate or the next backslash, whichever is first. A `\` starts
 * an escape pair only when the next character is escapable; the pair's second character is then
 * skipped exactly as the baseline's per-character scan skips it.
 */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const w = s.indexOf(what, j);
    if (w === -1) return -1;
    const b = s.indexOf('\\', j);
    if (b === -1 || w < b) return w;
    if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) j = b + 2;
    else j = b + 1;
  }
}

/**
 * The first single * from `from` (one whose run is not **), outside an escape, or -1.
 * Preserves the baseline's quirk: when a `*` is followed by another `*`, BOTH are skipped.
 */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const w = s.indexOf('*', j);
    if (w === -1) return -1;
    const b = s.indexOf('\\', j);
    if (b !== -1 && b < w) {
      if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) j = b + 2;
      else j = b + 1;
      continue;
    }
    if (s[w + 1] === '*') {
      j = w + 2;
      continue;
    }
    return w;
  }
}

/** The next character that needs dispatch: a backslash escape, a code span, strong/emphasis, a link, or an HTML escape. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** `s[a..b)` rendered inline, appended to `out` (an array of string pieces). Ranges only:
 * nested emphasis/link content is rendered in place — never sliced into a fresh string and
 * re-scanned. `env.link(target)` is a link's href. Plain runs are appended in one slice, so
 * characters that need no escaping are never visited one by one. Every finder result is
 * clamped to the range [a, b): a match at or past b is no match inside the range. */
function inlineRange(s, a, b, env, out) {
  let i = a;
  while (i < b) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null || m.index >= b) {
      out.push(s.slice(i, b));
      break;
    }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '\\') {
      // An escapable character is never an HTML-special one, so escapeHtml is the identity here.
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        out.push(s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k !== -1 && k < b && k > j + 2) {
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k !== -1 && k < b && k > j + 1) {
          out.push('<em>');
          inlineRange(s, j + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const p = k !== -1 && k < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 || p >= b ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        out.push(`<a href="${escapeHtml(env.link(target))}">`);
        inlineRange(s, j + 1, k, env, out);
        out.push('</a>');
        i = p + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
      continue;
    }
    out.push(ESCAPES[c]);
    i = j + 1;
  }
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents
 * (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or ""). Blocks are rendered as they are recognised; no token objects are built.
 */
function renderMarkdown(lines, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line[0];
    if (c0 === '`') {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push(`<pre><code${cls}>${body.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(stripQuote(lines[i++]));
      const ls = body.map(trimLine).filter((l) => l !== '');
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(ls.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // A list: a bullet line, or (when it is not one) an ordered line. Otherwise a paragraph.
    let listFirst = null;
    let listOrdered = false;
    if (c0 === '-' || c0 === '*') {
      const b = bulletOf(line);
      if (b !== null) {
        listFirst = b;
        listOrdered = false;
      }
    } else if (c0 >= '0' && c0 <= '9') {
      const o = orderedOf(line);
      if (o !== null) {
        listFirst = o;
        listOrdered = true;
      }
    }
    if (listFirst !== null) {
      const marker = listOrdered ? orderedOf : bulletOf;
      const items = [];
      while (i < n) {
        const m = marker(lines[i]);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const start = listOrdered ? Number(listFirst.num) : 1;
      const tag = listOrdered ? 'ol' : 'ul';
      const open = listOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence, a heading or a break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

/* ---- templates (parse as the baseline does; render with one scope object per for) ---- */

const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s[a..b)` holds only spaces and tabs. */
function isSpaces(s, a, b) {
  for (let k = a; k < b; k++) {
    const c = s[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * A template's AST, parsed in one pass from its source string to nodes — no intermediate
 * token objects. Preserves tokenize's exact behaviour: the `{{` / `{{{` / `{%` scan, the
 * standalone-`{% %}` line-stripping, and every TemplateError message verbatim.
 */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const pushText = (text) => {
    if (text !== '') body.push({ kind: 'text', text });
  };
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText(text);
      text = '';
      body.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaces(src, lineStart, open) && isSpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText(text);
    text = '';
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
    else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText(text);
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (an array of string pieces, joined once by the caller):
 * appending pieces beats `out += ...` string building, which ropes every intermediate. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope object for the whole for-execution, mutated per element (rendering is
        // synchronous, so no element's render can observe another's values). When the loop
        // variable is named "loop" the element is unreachable, exactly as in the baseline:
        // its object literal puts the loop record after the computed key, so the record wins.
        const vars = { [n.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };
        const child = { vars, parent: scope };
        const loop = vars.loop;
        for (let k = 0; k < xs.length; k++) {
          if (n.name !== 'loop') vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/* ---- pipeline ---- */

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whitespace table (JS \s, exactly) as a Uint8Array, built once at module load: a static
 * constant, not cross-case memoisation. Indexed by UTF-16 code unit; every \s code point is
 * <= 0xFEFF, so the table covers the set. \x00/\x01 are NOT whitespace (fuzz feeds them as
 * word characters). */
const WS_TABLE = (() => {
  const t = new Uint8Array(65536);
  for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) t[c] = 1;
  for (let c = 0x2000; c <= 0x200a; c++) t[c] = 1;
  return t;
})();

/** The words of a body's lines: its runs of characters other than whitespace (JS \s, exactly).
 * A newline is whitespace, so words never span lines and the sum over lines is exact. */
function wordsOfLines(lines) {
  let n = 0;
  for (const line of lines) {
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      if (WS_TABLE[line.charCodeAt(i)] === 1) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    // Most sources hold no '\r': skip the replace (a no-op scan) for those.
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.lines;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once (slug computed once per name), in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const t of ownTags(p)) {
      if (!bySlug.has(t.slug)) bySlug.set(t.slug, { name: t.name, slug: t.slug, url: `${b.base}/tags/${t.slug}/`, posts: [] });
      const tag = bySlug.get(t.slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((t) => bySlug.get(t.slug) ?? { name: t.name, slug: t.slug, url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.bodyLines) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. A post's card is computed once (in layouts) and reused here. */
function pageOf(b, s) {
  return {
    ...(s.post ? b.cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, escape: escapeHtml };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

export function run(input) {
  return build(input);
}
