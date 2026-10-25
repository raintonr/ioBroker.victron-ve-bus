#!/usr/bin/env node
// Initially ported from https://github.com/j9brown/victron-mk3 with Copilot

'use strict';

const { AC_PHASES_SUPPORTED, Handler, InterfaceFlags, SwitchState, VictronMK3, probe } = require('./lib/victronMk3');

const POLL_INTERVAL_MS = 2000;

class MonitorHandler extends Handler {
    constructor(options) {
        super();
        this.log = options.log;
        this.faulted = false;
    }

    on_response(response) {
        this.log.info(response);
    }

    on_idle() {
        this.log.info('Idle');
    }

    on_fault(fault) {
        this.log.error(`Fault: ${fault}`);
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

function dumpResponse(response) {
    if (response) {
        console.dir(response, { depth: null });
    }
}

async function poll(mk3, handler, flags = null) {
    dumpResponse(await mk3.sendInterfaceRequest(flags));
    dumpResponse(await mk3.sendLEDRequest());
    dumpResponse(await mk3.sendDCRequest());
    for (let phase = 1; phase <= AC_PHASES_SUPPORTED; phase += 1) {
        dumpResponse(await mk3.sendACRequest(phase));
    }
    dumpResponse(await mk3.sendPowerRequest());
    dumpResponse(await mk3.sendConfigRequest());
    if (!handler.faulted) await delay(POLL_INTERVAL_MS);
}

async function runMonitor(options) {
    const handler = new MonitorHandler(options);
    const mk3 = new VictronMK3(options);
    await mk3.start(handler);
    try {
        while (!handler.faulted) await poll(mk3, handler);
    } finally {
        await mk3.stop();
    }
}

async function runControl(options) {
    options.log.info(
        `Setting switch state to ${options.switchName.toUpperCase()} and current limit to ${options.currentLimit} amps`,
    );
    const handler = new MonitorHandler(options);
    const mk3 = new VictronMK3(options);
    await mk3.start(handler);
    const flags = InterfaceFlags.PANEL_DETECT | (options.standby ? InterfaceFlags.STANDBY : 0);
    try {
        let stateResponse = null;
        while (!stateResponse && !handler.faulted) {
            dumpResponse(await mk3.sendInterfaceRequest(flags));
            stateResponse = await mk3.sendStateRequest(options.switchState, options.currentLimit);
            dumpResponse(stateResponse);
            dumpResponse(await mk3.sendConfigRequest());
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

    options.log = {
        error: console.error,
        warn: console.warn,
        info: console.info,
        debug: console.debug,
    };

    switch (options.command) {
        case 'monitor':
            await runMonitor(options);
            break;
        case 'control':
            await runControl(options);
            break;
        default:
            options.log.info(`Result: ${await probe(options)}`);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { parseArgs };
