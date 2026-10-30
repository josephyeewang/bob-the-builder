import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePmset, readPowerSource, POWER_FACT } from './power-source.mjs';
import { makeFactWriter } from './facts.mjs';
import { memoryRecord } from '../../shared/record.mjs';

const UPS_ON_AC = "Now drawing from 'AC Power'\n -Back-UPS 900 (id=1234)\t100%; AC attached; not charging present: true\n";
const UPS_ON_BATTERY = "Now drawing from 'UPS Power'\n -Back-UPS 900 (id=1234)\t84%; discharging; 0:31 remaining present: true\n";
const NO_UPS = "Now drawing from 'AC Power'\n";
const LAPTOP = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=5678)\t71%; discharging; 4:02 remaining present: true\n";

test('pmset output: a UPS is battery backup; a laptop\'s own battery is not; no UPS is no', () => {
  assert.deepEqual(parsePmset(UPS_ON_AC), { source: 'AC Power', ups_present: true, on_ups_power: false, internal_battery: false });
  assert.equal(parsePmset(UPS_ON_BATTERY).on_ups_power, true);
  assert.equal(parsePmset(NO_UPS).ups_present, false);
  assert.deepEqual(parsePmset(LAPTOP), { source: 'Battery Power', ups_present: false, on_ups_power: false, internal_battery: true });
  assert.equal(parsePmset('garbage'), null);
});

test('the fact is written without the UPS model; a failed read records unknown (null), never false', async () => {
  const rec = memoryRecord();
  const writer = makeFactWriter(rec, { actor: 'sensors' });
  await readPowerSource({ run: async () => UPS_ON_AC, writer });
  assert.equal(writer.get(POWER_FACT).ups_present, true);
  assert.equal(JSON.stringify(writer.get(POWER_FACT)).includes('Back-UPS'), false);
  await readPowerSource({ run: async () => { throw new Error('no pmset'); }, writer });
  assert.equal(writer.get(POWER_FACT).ups_present, null);
  await readPowerSource({ run: async () => '', writer });
  assert.equal(writer.get(POWER_FACT).ups_present, null);
});
