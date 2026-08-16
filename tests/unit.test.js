/**
 * Node unit tests for the shared logic. Run: node tests/unit.test.js
 */
'use strict';
const assert = require('assert');
const { formatTime, hashString, truncate } = require('../shared/util.js');

// formatTime — spec example: 00:42 / 12:31 style durations
assert.strictEqual(formatTime(0), '0:00');
assert.strictEqual(formatTime(42), '0:42');
assert.strictEqual(formatTime(751), '12:31');
assert.strictEqual(formatTime(3671), '1:01:11');
assert.strictEqual(formatTime(NaN), '0:00');     // defensive
assert.strictEqual(formatTime(-5), '0:00');      // defensive
assert.strictEqual(formatTime(59.6), '1:00');    // rounds

// hashString — deterministic, distinct keys for distinct URLs
assert.strictEqual(hashString('abc'), hashString('abc'));
assert.notStrictEqual(hashString('https://a.com/v.mp4'), hashString('https://a.com/v2.mp4'));
assert.ok(/^[0-9a-z]+$/.test(hashString('anything')));

// truncate
assert.strictEqual(truncate('hello', 10), 'hello');
assert.strictEqual(truncate('hello world', 6), 'hello…');
assert.strictEqual(truncate(null, 5), '');

console.log('✔ tests/unit.test.js — all assertions passed');
