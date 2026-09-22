/**
 * Static consistency checks on the content script.
 *
 * content.js is a single IIFE that only runs inside a page, so it cannot be
 * imported and exercised here. That gap is not theoretical: a merge dropped
 * `resetQualities` from the panel object while leaving the call site intact,
 * and the result — "panel.resetQualities is not a function" on every in-page
 * navigation — reached a real browser because nothing checked.
 *
 * These read the source and assert the things that merge broke.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'content.js'), 'utf8');

/** The keys of the object literal `createPanel` returns. */
function panelKeys() {
  const start = SRC.indexOf('const panel = {');
  assert.ok(start > 0, 'could not find the panel literal');

  // Walk braces so nested arrow-function bodies do not end the match early.
  let depth = 0;
  let end = -1;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > start, 'panel literal is unbalanced');

  const body = SRC.slice(start, end);
  const keys = new Set();
  for (const m of body.matchAll(/^\s{6}([a-zA-Z_$][\w$]*)\s*[:,]/gm)) keys.add(m[1]);
  return keys;
}

describe('the panel object', () => {
  test('defines every method the script calls on it', () => {
    const keys = panelKeys();
    const called = new Set(
      [...SRC.matchAll(/\bpanel\.([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    );

    for (const name of called) {
      assert.ok(
        keys.has(name),
        `panel.${name}() is called but the panel object does not define it ` +
          `(defines: ${[...keys].join(', ')})`,
      );
    }
  });

  test('still carries the methods the rest of the script depends on', () => {
    const keys = panelKeys();
    for (const required of ['render', 'place', 'resetQualities']) {
      assert.ok(keys.has(required), `panel.${required} went missing`);
    }
  });
});

describe('panel behaviour that a merge has dropped before', () => {
  test('clicking the bar falls back to the quality list', () => {
    // With nothing sniffable — every modern streaming site — a bar that only
    // handles `items.length > 0` does nothing at all when clicked.
    const handler = SRC.slice(
      SRC.indexOf("bar.addEventListener('click'"),
      SRC.indexOf("root.querySelector('.caret')"),
    );
    assert.match(handler, /renderQualities\(\)/, 'bar click must offer the quality list');
  });

  test('the caret opens the quality list too', () => {
    const handler = SRC.slice(
      SRC.indexOf("root.querySelector('.caret')"),
      SRC.indexOf("root.querySelector('.close')"),
    );
    assert.match(handler, /renderQualities\(\)/);
  });

  test('"Download all" is hidden when there is nothing listable to take', () => {
    // Over a quality list every row is the same video at a different size, and
    // rows that carry no name, size or quality are not a choice either.
    assert.match(SRC, /head\.hidden\s*=\s*informative\.length === 0/);
  });

  test('rows are filtered by whether they say anything', () => {
    assert.match(SRC, /items\.filter\(isInformative\)/);
  });
});

describe('no dead code left by a merge', () => {
  test('every local function declared in the panel is used', () => {
    // `sendPage` survived a merge as an unreferenced definition.
    for (const m of SRC.matchAll(/^\s{4}const ([a-zA-Z_$][\w$]*) = \(\) => \{/gm)) {
      const name = m[1];
      const uses = [...SRC.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
      assert.ok(uses > 1, `${name} is defined but never called`);
    }
  });
});
