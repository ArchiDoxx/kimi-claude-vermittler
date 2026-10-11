import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setzeHaltezeit, glaetteSchemas, transformiere, modusFuer, zaehleMarken } from '../lib/transform.mjs';
import { tiefFrieren } from './hilfen.mjs';

const EPH = () => ({ type: 'ephemeral' });

function kimiBody() {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    stream: true,
    metadata: { user_id: 'sitzung-1' },
    system: [{ type: 'text', text: 'System', cache_control: EPH() }],
    tools: [
      { name: 'a', description: 'A', input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
      { name: 'b', description: 'B', input_schema: { type: 'object', properties: {} }, cache_control: EPH() },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hallo' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'Weiter', cache_control: EPH() }] },
    ],
  };
}

function alleMarken(body) {
  const marken = [];
  (body.tools ?? []).forEach((t) => t.cache_control && marken.push(['tools', t.cache_control]));
  (Array.isArray(body.system) ? body.system : []).forEach((b) => b.cache_control && marken.push(['system', b.cache_control]));
  (body.messages ?? []).forEach((m) => Array.isArray(m.content) && m.content.forEach((b) => {
    if (b.cache_control) marken.push(['messages', b.cache_control]);
    if (Array.isArray(b.content)) b.content.forEach((c) => c.cache_control && marken.push(['messages', c.cache_control]));
  }));
  return marken;
}

// ---------- T1 ----------

test('T1 ttl1h: setzt ttl 1h auf alle ephemeral-Marken ohne ttl', () => {
  const aus = setzeHaltezeit(tiefFrieren(kimiBody()), 'ttl1h');
  const marken = alleMarken(aus);
  assert.equal(marken.length, 3);
  for (const [, m] of marken) assert.deepEqual(m, { type: 'ephemeral', ttl: '1h' });
});

test('T1 ist rein: Eingabe bleibt unveraendert', () => {
  const roh = kimiBody();
  const vorher = JSON.stringify(roh);
  setzeHaltezeit(roh, 'ttl1h');
  setzeHaltezeit(roh, 'sockel1h');
  assert.equal(JSON.stringify(roh), vorher);
});

test('T1 laesst vorhandenes ttl stehen', () => {
  const body = kimiBody();
  const ein = tiefFrieren({ ...body, system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral', ttl: '1h' } }] });
  const aus = setzeHaltezeit(ein, 'ttl1h');
  assert.deepEqual(aus.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('T1 Reihenfolge-Regel: hinter einer kuerzeren vorhandenen Marke wird nichts auf 1h gehoben', () => {
  const body = kimiBody();
  const ein = tiefFrieren({ ...body, system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral', ttl: '5m' } }] });
  const marken = alleMarken(setzeHaltezeit(ein, 'ttl1h'));
  assert.deepEqual(marken[0], ['tools', { type: 'ephemeral', ttl: '1h' }]);
  assert.deepEqual(marken[1], ['system', { type: 'ephemeral', ttl: '5m' }]);
  assert.deepEqual(marken[2], ['messages', { type: 'ephemeral' }]);
  let kuerzer = false;
  for (const [, m] of marken) {
    if (m.ttl !== '1h') kuerzer = true;
    else assert.equal(kuerzer, false, '1h-Marke hinter kuerzerer Marke');
  }
});

test('T1 laesst nicht-ephemeral Marken unberuehrt', () => {
  const body = kimiBody();
  const ein = tiefFrieren({ ...body, system: [{ type: 'text', text: 'S', cache_control: { type: 'anders' } }] });
  assert.deepEqual(setzeHaltezeit(ein, 'ttl1h').system[0].cache_control, { type: 'anders' });
});

test('T1 sockel1h: nur tools und system bekommen 1h, messages bleiben', () => {
  const marken = alleMarken(setzeHaltezeit(tiefFrieren(kimiBody()), 'sockel1h'));
  assert.deepEqual(marken.map(([ort, m]) => [ort, m.ttl]), [['tools', '1h'], ['system', '1h'], ['messages', undefined]]);
});

test('T1 ping und aus aendern nichts (gleiche Referenz)', () => {
  const ein = tiefFrieren(kimiBody());
  assert.equal(setzeHaltezeit(ein, 'ping'), ein);
  assert.equal(setzeHaltezeit(ein, 'aus'), ein);
});

test('T1 erreicht Marken in tool_result-Inhalten', () => {
  const body = kimiBody();
  const ein = tiefFrieren({
    ...body,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'r', cache_control: EPH() }] }] }],
  });
  const aus = setzeHaltezeit(ein, 'ttl1h');
  assert.deepEqual(aus.messages[0].content[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('T1 vertraegt system als String und fehlende Felder', () => {
  const ein = tiefFrieren({ model: 'm', system: 'nur Text', messages: [{ role: 'user', content: 'Text' }] });
  assert.deepEqual(setzeHaltezeit(ein, 'ttl1h'), ein);
});

test('zaehleMarken zaehlt alle cache_control-Marken in tools, system, messages', () => {
  assert.equal(zaehleMarken(kimiBody()), 3);
  assert.equal(zaehleMarken({ messages: [] }), 0);
});

// ---------- T2 ----------

const ONEOF_OHNE_PROPS = {
  name: 'cu',
  description: 'Computer use',
  input_schema: {
    oneOf: [
      { properties: { pid: { type: 'integer', description: 'Prozess' } }, required: ['pid'] },
      { properties: { app: { type: 'string' } }, required: ['app'] },
      { properties: { window_id: { type: 'integer' } }, required: ['window_id'] },
    ],
  },
};

test('T2 oneOf ohne eigene properties: properties enthaelt jeden Schluessel jedes Zweigs', () => {
  const s = glaetteSchemas(tiefFrieren({ tools: [ONEOF_OHNE_PROPS], messages: [] })).tools[0].input_schema;
  assert.deepEqual(Object.keys(s.properties).sort(), ['app', 'pid', 'window_id']);
  assert.equal(s.properties.pid.description, 'Prozess');
  assert.equal(s.type, 'object');
  assert.equal(s.oneOf, undefined);
  assert.equal(s.required, undefined);
  assert.match(s.description, /Genau eine dieser Feldgruppen angeben: \(pid\) \| \(app\) \| \(window_id\)/);
});

test('T2 Vereinigung: oberste Ebene gewinnt, erster Treffer je Schluessel, required oben bleibt', () => {
  const tool = {
    name: 't',
    input_schema: {
      type: 'object',
      description: 'Grund',
      additionalProperties: false,
      properties: { modus: { type: 'string', description: 'oben' } },
      required: ['modus'],
      anyOf: [
        { properties: { modus: { type: 'number' }, a: { type: 'string', description: 'erst' } }, required: ['a'] },
        { properties: { a: { type: 'number' }, b: { type: 'string' } } },
      ],
    },
  };
  const s = glaetteSchemas(tiefFrieren({ tools: [tool] })).tools[0].input_schema;
  assert.equal(s.properties.modus.description, 'oben');
  assert.equal(s.properties.a.description, 'erst');
  assert.ok(s.properties.b);
  assert.deepEqual(s.required, ['modus']);
  assert.equal(s.additionalProperties, false);
  assert.equal(s.type, 'object');
  assert.equal(s.anyOf, undefined);
  assert.ok(s.description.startsWith('Grund '));
  assert.match(s.description, /Mindestens eine dieser Feldgruppen angeben: \(a\) \| \(a, b\)/);
});

test('T2 allOf: Satz nennt alle Gruppen', () => {
  const tool = { name: 't', input_schema: { allOf: [{ properties: { x: {} }, required: ['x'] }, { properties: { y: {} }, required: ['y'] }] } };
  const s = glaetteSchemas(tiefFrieren({ tools: [tool] })).tools[0].input_schema;
  assert.deepEqual(Object.keys(s.properties), ['x', 'y']);
  assert.match(s.description, /Alle Felder der Gruppen angeben: \(x\) \| \(y\)/);
  assert.equal(s.allOf, undefined);
});

test('T2 verschachteltes oneOf bleibt unangetastet', () => {
  const tool = {
    name: 't',
    input_schema: { type: 'object', properties: { ziel: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } },
  };
  const ein = tiefFrieren({ tools: [tool] });
  const aus = glaetteSchemas(ein);
  assert.equal(aus, ein, 'ohne oberstes oneOf bleibt der Body dieselbe Referenz');
  assert.deepEqual(aus.tools[0].input_schema.properties.ziel.oneOf, [{ type: 'string' }, { type: 'integer' }]);
});

test('T2 Schema ohne oneOf bleibt bytegleich', () => {
  const ein = tiefFrieren(kimiBody());
  const vorher = JSON.stringify(ein);
  assert.equal(JSON.stringify(glaetteSchemas(ein)), vorher);
});

test('T2 nie weniger Parameter als die Vereinigung der Zweige', () => {
  const zweige = [
    { properties: { a: {}, b: {} } },
    { properties: { c: {} }, required: ['c'] },
    { properties: { a: {}, d: {} } },
  ];
  const tool = { name: 't', input_schema: { properties: { e: {} }, oneOf: zweige } };
  const s = glaetteSchemas(tiefFrieren({ tools: [tool] })).tools[0].input_schema;
  for (const k of ['a', 'b', 'c', 'd', 'e']) assert.ok(k in s.properties, `fehlt: ${k}`);
});

test('K11: Property namens constructor oder toString ueberlebt die Glaettung', () => {
  const tool = { name: 't', input_schema: { oneOf: [{ properties: { constructor: { type: 'string' } } }, { properties: { toString: { type: 'string' } } }] } };
  const s = glaetteSchemas(tiefFrieren({ tools: [tool] })).tools[0].input_schema;
  assert.ok(Object.hasOwn(s.properties, 'constructor'));
  assert.ok(Object.hasOwn(s.properties, 'toString'));
  assert.deepEqual(s.properties.constructor, { type: 'string' });
});

test('T2 ist rein und laesst Tools ohne input_schema stehen', () => {
  const roh = { tools: [ONEOF_OHNE_PROPS, { type: 'web_search_20250305', name: 'web_search' }] };
  const vorher = JSON.stringify(roh);
  const aus = glaetteSchemas(roh);
  assert.equal(JSON.stringify(roh), vorher);
  assert.equal(aus.tools[1], roh.tools[1]);
});

// ---------- transformiere / modusFuer ----------

test('transformiere: geaendert=false und gleiche Referenz, wenn nichts zu tun ist', () => {
  const ein = tiefFrieren(kimiBody());
  const erg = transformiere(ein, 'aus');
  assert.equal(erg.geaendert, false);
  assert.equal(erg.body, ein);
  assert.equal(erg.marken, 3);
  assert.equal(erg.geglaettet, 0);
});

test('transformiere: T1 und T2 zusammen, geaendert=true', () => {
  const ein = tiefFrieren({ ...kimiBody(), tools: [ONEOF_OHNE_PROPS, ...kimiBody().tools] });
  const erg = transformiere(ein, 'ttl1h');
  assert.equal(erg.geaendert, true);
  assert.equal(erg.geglaettet, 1);
  assert.equal(erg.body.tools[0].input_schema.oneOf, undefined);
  assert.equal(erg.body.system[0].cache_control.ttl, '1h');
});

test('modusFuer: Praefix-Treffer in modeByModel, laengster gewinnt, sonst mode', () => {
  const konfig = { mode: 'ttl1h', modeByModel: { 'claude-fable': 'ping', 'claude-fable-5-1': 'aus' } };
  assert.equal(modusFuer(konfig, 'claude-fable-5-1-20261001'), 'aus');
  assert.equal(modusFuer(konfig, 'claude-fable-5'), 'ping');
  assert.equal(modusFuer(konfig, 'claude-opus-5-5'), 'ttl1h');
  assert.equal(modusFuer(konfig, undefined), 'ttl1h');
});
