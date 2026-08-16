// Removes the stylesheet rules for markup that no longer exists.
//
//   node scripts/prune-css.mjs [--write]
//
// Deleting these by hand is where the damage happens: several are shared rules
// like `.side-btn, .soc, .nav-btn { transition: … }`, and cutting the whole
// block to be rid of the first two silently takes the transition off the nav as
// well. So this works per selector — a rule loses only its dead parts, and is
// dropped only when nothing is left.
//
// Dry run by default. Read what it says it will remove before passing --write.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILE = join(ROOT, 'public/css/style.css');

// The features that were taken out: Support, Advertise, the ad slots and
// overlay, and the social row.
const DEAD = [
  /\.side-(row|btn|support|ads)\b/,
  /\.social-(block|label|row)\b/,
  /\.soc(-(ig|tt|yt))?\b/,
  /\.ad-(slot|slot-lg|overlay|box|head|label|close|note)\b/,
  /\.ads-(page|hero|stats|stat|cta|mail|copy)\b/,
  /\.fmt(-list|-ico)?\b/,
  /\.opt-(card|head|ico|sub|foot)\b/,
  /#(ad-video-slot|overlay-ad|overlay-support|screen-ads)\b/,
  /#(btn-open-support|btn-open-ads|support-watch|support-close|ads-contact|ads-email-copy)\b/,
];

const isDead = (sel) => DEAD.some(re => re.test(sel));

/* Splits a stylesheet into { prelude, body } at the top level, keeping @media
   and friends intact so their contents can be walked the same way. A real CSS
   parser would be the right tool; this file has no strings containing braces,
   so brace counting is enough and brings in no dependency. */
function blocks(css) {
  const out = [];
  let depth = 0, start = 0, preludeEnd = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {           // skip comments wholesale
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (c === '{') {
      if (depth === 0) preludeEnd = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        out.push({
          prelude: css.slice(start, preludeEnd),
          body: css.slice(preludeEnd + 1, i),
          raw: css.slice(start, i + 1),
          start, end: i + 1,
        });
        start = i + 1;
      }
    }
  }
  return out;
}

const removed = [];
const trimmed = [];

function prune(css, depth = 0) {
  let out = '';
  let cursor = 0;
  for (const b of blocks(css)) {
    out += css.slice(cursor, b.start);
    cursor = b.end;
    const prelude = b.prelude.trim();

    if (prelude.startsWith('@')) {
      // at-rule: keep the wrapper, prune inside it
      const inner = prune(b.body, depth + 1);
      // an @media left with nothing in it is noise
      if (inner.trim()) out += `${b.prelude}{${inner}}`;
      else removed.push(prelude + ' (emptied)');
      continue;
    }

    /* The prelude carries the rule's leading comments as well as its selectors,
       and those comments are prose — full of commas. Splitting the raw prelude
       on "," therefore chops sentences into fragments, none of which match a
       dead pattern, and every commented rule survives as "live". Comments come
       out before the split and go back in on the way out. */
    const comments = prelude.match(/\/\*[\s\S]*?\*\//g) || [];
    const selectorText = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim();

    const parts = selectorText.split(',').map(s => s.trim()).filter(Boolean);
    const live = parts.filter(s => !isDead(s));
    if (!live.length) {
      removed.push(selectorText.replace(/\s+/g, ' '));
      continue;
    }
    if (live.length !== parts.length) {
      trimmed.push(`${selectorText.replace(/\s+/g, ' ')}  ->  ${live.join(', ')}`);
      const indent = b.prelude.match(/^\s*/)[0];
      const head = comments.length ? comments.join('\n') + '\n' + indent.replace(/^\n+/, '') : '';
      out += `${indent}${head}${live.join(',\n')} {${b.body}}`;
      continue;
    }
    out += b.raw;
  }
  return out + css.slice(cursor);
}

const before = readFileSync(FILE, 'utf8');
let after = prune(before);
// collapse the runs of blank lines the deletions leave behind
after = after.replace(/\n{3,}/g, '\n\n');

console.log(`rules removed: ${removed.length}`);
for (const r of removed) console.log('  - ' + r);
if (trimmed.length) {
  console.log(`\nshared rules trimmed rather than removed: ${trimmed.length}`);
  for (const t of trimmed) console.log('  ~ ' + t);
}
console.log(`\n${before.length} -> ${after.length} bytes (${before.length - after.length} saved)`);

if (process.argv.includes('--write')) {
  writeFileSync(FILE, after);
  console.log('written');
} else {
  console.log('dry run — pass --write to apply');
}
