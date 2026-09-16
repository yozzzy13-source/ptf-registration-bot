import assert from 'node:assert/strict';
import { isWCrossGroupPair } from '../access.js';
assert.equal(isWCrossGroupPair('Olga Sauer','Masha Geveling','W'),true);
assert.equal(isWCrossGroupPair('Maria Evangelista','Xenia Hors','Division W'),true);
assert.equal(isWCrossGroupPair('Olga Sauer','Elena Ian','W'),false);
assert.equal(isWCrossGroupPair('Olga Sauer','Masha Geveling','A'),false);
console.log('PASS: approved W1/W2 cross-group pairs only.');
