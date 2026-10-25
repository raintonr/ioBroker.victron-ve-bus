'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_INTERFACE_FLAGS,
  InterfaceFlags,
  LEDState,
  SwitchState,
  VictronMK3,
  VersionResponse,
  encodeFrame,
} = require('../lib/victronMk3');
const { parseArgs } = require('../cli');

test('encodes protocol frames with expected length and checksum', () => {
  const frame = encodeFrame('H', [InterfaceFlags.PANEL_DETECT]);
  assert.deepEqual([...frame], [3, 0xff, 0x48, 1, 0xb5]);
  assert.equal([...frame].reduce((sum, byte) => sum + byte, 0) & 0xff, 0);
});

test('exports protocol constants and response payloads', () => {
  assert.equal(DEFAULT_INTERFACE_FLAGS, InterfaceFlags.PANEL_DETECT | InterfaceFlags.UNDOCUMENTED_04);
  assert.equal(SwitchState.ON, 3);
  assert.equal(LEDState.FLOAT, 8);
  assert.equal(new VersionResponse(1234).version, 1234);
});

test('requires an injected log object with all supported methods', () => {
  const log = {
    error() {},
    warn() {},
    info() {},
    debug() {},
  };
  assert.doesNotThrow(() => new VictronMK3({ path: '/dev/ttyUSB0', log }));
  assert.throws(() => new VictronMK3({ path: '/dev/ttyUSB0' }), /log must provide/);
});

test('parses monitor, probe, and control CLI commands', () => {
  assert.deepEqual(parseArgs(['monitor', '/dev/ttyUSB0']), {
    command: 'monitor',
    path: '/dev/ttyUSB0',
    verbose: false,
  });
  assert.equal(parseArgs(['probe', '/dev/ttyUSB0']).command, 'probe');
  const control = parseArgs([
    '--verbose',
    'control',
    '/dev/ttyUSB0',
    'charger_only',
    '--current-limit',
    '12.5',
    '--standby',
    '--monitor',
  ]);
  assert.equal(control.switchState, SwitchState.CHARGER_ONLY);
  assert.equal(control.currentLimit, 12.5);
  assert.equal(control.standby, true);
  assert.equal(control.monitor, true);
  assert.equal(control.verbose, true);
  const controlWithoutMonitoring = parseArgs([
    'control',
    '/dev/ttyUSB0',
    'off',
    '--monitor',
    '--no-monitor',
    '--standby',
    '--no-standby',
  ]);
  assert.equal(controlWithoutMonitoring.monitor, false);
  assert.equal(controlWithoutMonitoring.standby, false);
  assert.equal(parseArgs(['control', '/dev/ttyUSB0', 'off', '--current-limit', 'NaN']), null);
  assert.equal(parseArgs(['control', '/dev/ttyUSB0', 'nonsense']), null);
});
