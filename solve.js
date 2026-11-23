// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Reimplements make.fun's reference static site generator with byte-identical output,
// optimized for CPU time:
//  - inline Markdown rendered in segments (one escape pass per plain run, no per-character
//    escaping), finders built on indexOf instead of per-character scans;
//  - fence bodies escaped in one pass;
//  - slugs cached per case, with an ASCII fast path that skips NFKD normalisation;
//  - template rendering over prototype-chain scopes (no scope-walk loop per lookup),
//    output collected in an array, loop scopes reused across iterations;
//  - cards / neighbour links / toc views computed once per source and shared read-only.
//
// No state is kept between run() calls: every cache is created fresh inside build().
// The template parser below is makefun-site's own (lib/template.js), kept verbatim:
// parsing is once per template and its exact error strings are part of the output.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const WS_TEST = /\s/;

/** `text` with & < > " and ' escaped. (A pre-test is slower than the replace itself.) */
export function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

export const SLUG_MAX = 64;

/** The slug of `text`, exactly as makefun-site's lib/text.js computes it. */
function slugifyRaw(text) {
  // ASCII fast path: no NFKD normalisation or combining-mark stripping can change it.
  if (!/[^\x00-\x7F]/.test(text)) {
    let out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let keep = -1;
      if (code >= 65 && code <= 90) keep = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
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

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = 2;
  let out;
  do {
    out = `${slug}-${n}`;
    n++;
  } while (taken.has(out));
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
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

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
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

/**
 * A source's front matter and body: { data, body }, or { error }. The closing `---` line is
 * found by scanning for a line that is exactly `---` (never by splitting the whole file).
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeIdx = -1;
  // The search starts at index 3, the newline ending the opening `---` line: when the
  // front matter is empty the closing fence sits at index 4, preceded by that newline.
  let searchFrom = 3;
  for (;;) {
    const idx = text.indexOf('\n---', searchFrom);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text[after] === '\n') {
      closeIdx = idx;
      break;
    }
    searchFrom = idx + 1;
  }
  if (closeIdx === -1) return { error: 'the front matter is not closed' };
  const body = closeIdx + 4 === text.length ? '' : text.slice(closeIdx + 5);
  const region = text.slice(4, closeIdx);
  const data = {};
  if (region !== '') {
    const lines = region.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
      const m = LINE.exec(line);
      if (!m) return { error: `line ${j + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A line that is blank (spaces and tabs only). */
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  return BLANK.test(line);
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const w = s.indexOf(what, j);
    if (w === -1) return -1;
    const b = s.indexOf('\\', j);
    if (b !== -1 && b < w) {
      if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) j = b + 2;
      else j = b + 1;
      continue;
    }
    return w;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
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

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = s.indexOf('\\', i);
    let k = s.indexOf('`', i);
    if (k !== -1 && (j === -1 || k < j)) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && (j === -1 || k < j)) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && (j === -1 || k < j)) j = k;
    if (j === -1) {
      out += escapeHtml(s.slice(i));
      break;
    }
    if (j > i) out += escapeHtml(s.slice(i, j));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        out += escapeHtml(s[j + 1]);
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k2 = s.indexOf('`', j + 1);
      if (k2 > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k2))}</code>`;
        i = k2 + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k2 = findUnescaped(s, '**', j + 2);
        if (k2 > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k2), env)}</strong>`;
          i = k2 + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      const k2 = findSingleStar(s, j + 1);
      if (k2 > j + 1) {
        out += `<em>${inline(s.slice(j + 1, k2), env)}</em>`;
        i = k2 + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    const k2 = findUnescaped(s, ']', j + 1);
    const m = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
    const target = m === -1 ? '' : s.slice(k2 + 2, m);
    if (target !== '' && !WS_TEST.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k2), env)}</a>`;
      i = m + 1;
      continue;
    }
    out += '[';
    i = j + 1;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading) and its excerpt (the first paragraph's inline HTML).
 * `slugify` is the build's cached slug function.
 */
function renderMarkdown(src, env, slugify) {
  const ids = new Set();
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let fence = null;
    if (line.charCodeAt(0) === 96) fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
      continue;
    }
    let heading = null;
    if (line.charCodeAt(0) === 35) heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    let bullet = false;
    let ordered = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = true;
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        let m = null;
        let text = null;
        if (isOrdered) {
          if (l.charCodeAt(0) >= 48 && l.charCodeAt(0) <= 57) {
            const mm = ORDERED.exec(l);
            if (mm !== null) {
              m = mm;
              text = mm[2];
            }
          }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          m = true;
          text = l.slice(2);
        }
        if (m !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (CONTINUED.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const item of items) html += `<li>${inline(item.join('\n'), env)}</li>\n`;
      html += `</${tag}>\n`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
// makefun-site's template dialect (README.md, "Templates"). The parser is the reference's
// own, kept as it is; only the renderer is rewritten for speed.

export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
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
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
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
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * The value at `path` in the scope chain. Scopes are plain objects linked by prototype:
 * the first name is read from the nearest scope holding it (a prototype lookup), each next
 * name is an own property of the value so far. All scope objects are null-prototype, so no
 * Object.prototype member can ever answer a lookup.
 */
function lookup(scope, path) {
  let v = scope[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * Free first-names of a node tree: the names its rendering reads that no `for` inside the
 * tree binds. An include contributes the included template's free names, minus the names
 * bound at the include site (a name bound there takes its value from the enclosing for's
 * path, which is itself a free name of this tree). `freeOf` holds the previous
 * iteration's sets; the caller iterates to a fixpoint over the include graph.
 */
function analyzeFreeNames(nodes, freeOf) {
  const free = new Set();
  const walk = (ns, bound) => {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        walk(n.then, bound);
        if (n.else !== null) walk(n.else, bound);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 'include') {
        const sub = freeOf.get(n.name);
        if (sub !== undefined) for (const x of sub) if (!bound.has(x)) free.add(x);
      }
    }
  };
  walk(nodes, new Set());
  return free;
}

/** The longest include chain inside a node tree (0 when it includes nothing; Infinity on a cycle). */
function maxIncludeDepth(nodes, templates, seen) {
  let m = 0;
  for (const n of nodes) {
    if (n.kind === 'for') {
      m = Math.max(m, maxIncludeDepth(n.body, templates, seen));
    } else if (n.kind === 'if') {
      m = Math.max(m, maxIncludeDepth(n.then, templates, seen));
      if (n.else !== null) m = Math.max(m, maxIncludeDepth(n.else, templates, seen));
    } else if (n.kind === 'include') {
      if (seen.has(n.name)) return Infinity;
      const sub = templates.get(n.name);
      const d = sub === undefined ? 0 : 1 + maxIncludeDepth(sub, templates, new Set(seen).add(n.name));
      if (d > m) m = d;
    }
  }
  return m;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`, appending to `out`. `ctx.templates` holds the parsed templates. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
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
        const child = Object.create(scope);
        const loop = { index: 0, first: false, last: false, length: xs.length };
        for (let k = 0; k < xs.length; k++) {
          child[n.name] = xs[k];
          child.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        if (ctx.constTemplates.has(n.name) && depth + ctx.constDepth.get(n.name) <= INCLUDE_DEPTH) {
          let cached = ctx.constCache.get(n.name);
          if (cached === undefined) {
            const t = ctx.templates.get(n.name);
            if (t === undefined) break;
            const tmp = [];
            renderNodes(t, scope, ctx, depth + 1, tmp);
            cached = tmp.join('');
            ctx.constCache.set(n.name, cached);
          }
          out.push(cached);
          break;
        }
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** One site's output tree: path -> text. */
export function build(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    const hit = slugCache.get(text);
    if (hit !== undefined) return hit;
    const out = slugifyRaw(text);
    slugCache.set(text, out);
    return out;
  };

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
    output: {},
    slugify,
  };

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
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

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
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

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
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
      const md = renderMarkdown(s.body, env, slugify);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
    for (const s of b.sources) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      s.link = linkOf(s);
      s.tocView = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    }
    const pageOf = (s) => ({
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.tocView,
      newer: s.newer === null || s.newer === undefined ? null : s.newer.link,
      older: s.older === null || s.older === undefined ? null : s.older.link,
      is_post: s.post,
    });
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => p.card);
    const baseVars = Object.create(null);
    baseVars.site = site;
    baseVars.tags = allTags;
    baseVars.recent = recent;
    // Templates whose rendering reads only the case constants (site, tags, recent):
    // their output is the same for every page of this case, so it is rendered once and
    // reused. Free names are computed to a fixpoint over the include graph; a template
    // is cached only when rendering it can never hit the include-depth cutoff
    // (depth + its longest include chain <= 8), so the cached text is depth-independent.
    const freeOf = new Map();
    for (const name of b.templates.keys()) freeOf.set(name, new Set());
    let changedFree = true;
    for (let guard = 0; changedFree && guard < 64; guard++) {
      changedFree = false;
      for (const [tName, nodes] of b.templates) {
        const s = analyzeFreeNames(nodes, freeOf);
        const old = freeOf.get(tName);
        let grew = s.size !== old.size;
        if (!grew) for (const x of s) if (!old.has(x)) { grew = true; break; }
        if (grew) {
          freeOf.set(tName, s);
          changedFree = true;
        }
      }
    }
    const constTemplates = new Set();
    const constDepth = new Map();
    for (const [tName, free] of freeOf) {
      let ok = true;
      for (const x of free) if (x !== 'site' && x !== 'tags' && x !== 'recent') { ok = false; break; }
      if (!ok) continue;
      const d = maxIncludeDepth(b.templates.get(tName), b.templates, new Set([tName]));
      if (d === Infinity) continue;
      constTemplates.add(tName);
      constDepth.set(tName, d);
    }
    const ctx = { templates: b.templates, constTemplates, constDepth, constCache: new Map() };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      const scope = Object.create(baseVars);
      if (vars !== undefined) Object.assign(scope, vars);
      const out = [];
      renderNodes(nodes, scope, ctx, 0, out);
      return out.join('');
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => p.card),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
