import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesFilters } from '../src/rules';

test('sender filters accept operator ids and number prefixes, case-insensitively', () => {
  assert.ok(matchesFilters('OrangeMoney', []));
  assert.ok(matchesFilters('OrangeMoney', ['orangemoney']));
  assert.ok(matchesFilters('Orange Money', ['OrangeMoney']));
  assert.ok(matchesFilters('+243890000100', ['+24389']));
  assert.ok(!matchesFilters('MPESA', ['OrangeMoney', 'AirtelMoney']));
  assert.ok(!matchesFilters('+254700000000', ['OrangeMoney']));
});
