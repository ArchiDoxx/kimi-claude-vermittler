// Konto-Kennung aus den Upstream-Antwortkopfzeilen (Organisation, Workspace) fuer health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kontoAus } from '../vermittler.mjs';

test('kontoAus: Organisation und Workspace aus den Anthropic-Kopfzeilen', () => {
  const h = new Headers({ 'anthropic-organization-id': 'org-1a2b_C', 'anthropic-workspace-id': 'wrkspc_01ABC' });
  assert.deepEqual(kontoAus(h), { organisation: 'org-1a2b_C', workspace: 'wrkspc_01ABC' });
  assert.deepEqual(kontoAus(new Headers({ 'anthropic-organization-id': 'org1' })), { organisation: 'org1' });
});

test('kontoAus: fehlende, fremde oder ungueltige Werte ergeben null bzw. werden ausgelassen', () => {
  assert.equal(kontoAus(undefined), null);
  assert.equal(kontoAus({}), null);
  assert.equal(kontoAus(new Headers({ 'content-type': 'application/json' })), null);
  assert.equal(kontoAus(new Headers({ 'anthropic-organization-id': 'a b<script>' })), null);
  assert.deepEqual(
    kontoAus(new Headers({ 'anthropic-organization-id': 'x'.repeat(101), 'anthropic-workspace-id': 'w1' })),
    { workspace: 'w1' },
  );
});
