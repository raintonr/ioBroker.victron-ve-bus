#!/usr/bin/env node
// Initially ported from https://github.com/j9brown/victron-mk3 with Copilot
// ... but then most of that binned because turns out Python ported to JS
// by an AI is almost as bad as the original!

'use strict';

const { AC_PHASES_SUPPORTED, HEARTBEAT_EVENT, VARS, VictronMK3 } = require('./lib/victronMk3');
const { inspect } = require('util');

const POLL_INTERVAL_MS = 5000;

const log = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
};

function usage() {
    console.error(`Usage:
  victron-mk3 [-v|--verbose] monitor <serial-path>
  victron-mk3 [-v|--verbose] control <serial-path> <on|off|charger_only|inverter_only> [--current-limit <amps>] [--monitor|--no-monitor] [--standby|--no-standby]
  victron-mk3 [-v|--verbose] probe <serial-path>`);
}

function parseArgs(args) {
    const verbose = args[0] === '-v' || args[0] === '--verbose';
    if (verbose) args = args.slice(1);
    const command = args[0];
    if (!['monitor', 'probe'].includes(command)) return null;
    const path = args[1];
    if (!path) return null;
    if (command !== 'control') {
        if (args.length !== 2) return null;
        return { command, path, verbose };
    }

    const switchName = args[2];
    const switchState = SwitchState[switchName?.toUpperCase()];
    if (!switchState) return null;
    let currentLimit = null;
    let monitor = false;
    let standby = false;
    for (let i = 3; i < args.length; i += 1) {
        switch (args[i]) {
            case '--current-limit': {
                const value = Number(args[++i]);
                if (!Number.isFinite(value)) return null;
                currentLimit = value;
                break;
            }
            case '--monitor':
                monitor = true;
                break;
            case '--no-monitor':
                monitor = false;
                break;
            case '--standby':
                standby = true;
                break;
            case '--no-standby':
                standby = false;
                break;
            default:
                return null;
        }
    }
    return { command, path, switchName, switchState, currentLimit, monitor, standby, verbose };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function dumpObject(obj) {
    return inspect(obj, { colors: Boolean(process.stdout.isTTY), depth: null, compact: false });
}

function dumpResponse(response) {
    if (response) {
        log.info(dumpObject(response));
    } else {
        log.warn('No response');
    }
}

async function poll(mk3) {
    log.info('sendLedRequest...');
    dumpResponse(await mk3.sendLedRequest());

    log.info('sendDcRequest...');
    dumpResponse(await mk3.sendDcRequest());

    for (let phase = 1; phase <= AC_PHASES_SUPPORTED; phase += 1) {
        log.info(`sendAcRequest (phase ${phase})...`);
        const response = await mk3.sendAcRequest(phase);
        dumpResponse(response);
        if (!response || phase <= response?.acPhases) {
            break;
        }
    }

    log.info('sendPowerRequest...');
    dumpResponse(await mk3.sendVarRequest(VARS.power));

    log.info('sendConfigRequest...');
    dumpResponse(await mk3.sendConfigRequest());
}

async function runMonitor(options) {
    const mk3 = new VictronMK3(options);
    await mk3.start();
    mk3.on(HEARTBEAT_EVENT, () => {
        log.debug('**** Heartbeat ****');
    });
    try {
        while (true) {
            await poll(mk3);
            await delay(POLL_INTERVAL_MS);
        }
    } finally {
        await mk3.stop();
    }
}

async function probe(options) {
    const mk3 = new VictronMK3(options);
    await mk3.start();
    const out = await mk3.sendVersionRequest();
    await mk3.stop();
    return out;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
        usage();
        process.exitCode = 2;
        return;
    }

    // Change debug for dummy if not verbose
    if (!options.verbose) {
        log.debug = () => {};
    }
    options.log = log;

    switch (options.command) {
        case 'monitor':
            await runMonitor(options);
            break;
        case 'probe':
            log.info(dumpObject(await probe(options)));
            break;
        default:
            log.error(`Unknown command: ${options.command}`);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs };
