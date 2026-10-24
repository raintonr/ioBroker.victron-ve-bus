#!/usr/bin/env node
// Initially ported from https://github.com/j9brown/victron-mk3 with Copilot

'use strict';

const {
    AC_PHASES_SUPPORTED,
    Handler,
    InterfaceFlags,
    LOG_LEVELS,
    SwitchState,
    VictronMK3,
    logger,
    probe,
} = require('./lib/victronMk3');

const POLL_INTERVAL_MS = 2000;

class MonitorHandler extends Handler {
    constructor() {
        super();
        this.faulted = false;
    }

    on_response(response) {
        response.log(logger, LOG_LEVELS.INFO);
    }

    on_idle() {
        logger.info('Idle');
    }

    on_fault(fault) {
        logger.error(`Fault: ${fault}`);
        this.faulted = true;
    }
}

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
    if (!['monitor', 'control', 'probe'].includes(command)) return null;
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

async function poll(mk3, handler, flags = null) {
    await mk3.sendInterfaceRequest(flags);
    await mk3.sendLEDRequest();
    await mk3.sendDCRequest();
    for (let phase = 1; phase <= AC_PHASES_SUPPORTED; phase += 1) {
        await mk3.sendACRequest(phase);
    }
    await mk3.sendPowerRequest();
    await mk3.sendConfigRequest();
    if (!handler.faulted) await delay(POLL_INTERVAL_MS);
}

async function runMonitor(path) {
    const handler = new MonitorHandler();
    const mk3 = new VictronMK3(path);
    await mk3.start(handler);
    try {
        while (!handler.faulted) await poll(mk3, handler);
    } finally {
        await mk3.stop();
    }
}

async function runControl(options) {
    logger.info(
        `Setting switch state to ${options.switchName.toUpperCase()} and current limit to ${options.currentLimit} amps`,
    );
    const handler = new MonitorHandler();
    const mk3 = new VictronMK3(options.path);
    await mk3.start(handler);
    const flags = InterfaceFlags.PANEL_DETECT | (options.standby ? InterfaceFlags.STANDBY : 0);
    try {
        let stateResponse = null;
        while (!stateResponse && !handler.faulted) {
            await mk3.sendInterfaceRequest(flags);
            stateResponse = await mk3.sendStateRequest(options.switchState, options.currentLimit);
            await mk3.sendConfigRequest();
            if (!stateResponse && !handler.faulted) await delay(POLL_INTERVAL_MS);
        }
        while (options.monitor && !handler.faulted) {
            await poll(mk3, handler, flags);
        }
    } finally {
        await mk3.stop();
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
        usage();
        process.exitCode = 2;
        return;
    }
    logger.setLevel(options.verbose ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO);
    if (options.command === 'monitor') await runMonitor(options.path);
    else if (options.command === 'control') await runControl(options);
    else logger.info(`Result: ${await probe(options.path)}`);
}

if (require.main === module) {
    main().catch(error => {
        logger.error(error);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs };
