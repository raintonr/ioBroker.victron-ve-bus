// Initially ported from https://github.com/j9brown/victron-mk3 with Copilot

'use strict';

const { SerialPort } = require('serialport');

const AC_PHASES_SUPPORTED = 4;
const HACK_OVERRIDE_AC_INVERTER_CURRENT_SIGNEDNESS = true;
const REQUEST_TIMEOUT_MS = 500;
const CONFIG_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 5000;

const SwitchState = Object.freeze({
    CHARGER_ONLY: 1,
    INVERTER_ONLY: 2,
    ON: 3,
    OFF: 4,
});

const LEDState = Object.freeze({
    OFF: 0,
    MAINS: 0x01,
    ABSORPTION: 0x02,
    BULK: 0x04,
    FLOAT: 0x08,
    INVERTER: 0x10,
    OVERLOAD: 0x20,
    LOW_BATTERY: 0x40,
    TEMPERATURE: 0x80,
});

const DeviceState = Object.freeze({
    DOWN: 0,
    STARTUP: 1,
    OFF: 2,
    SLAVE: 3,
    INVERT_FULL: 4,
    INVERT_HALF: 5,
    INVERT_AES: 6,
    POWER_ASSIST: 7,
    BYPASS: 8,
    STATE_CHARGE: 9,
});

const SwitchRegister = Object.freeze({
    DIRECT_REMOTE_SWITCH_CHARGE: 0x01,
    DIRECT_REMOTE_SWITCH_INVERT: 0x02,
    FRONT_SWITCH_UP: 0x04,
    FRONT_SWITCH_DOWN: 0x08,
    SWITCH_CHARGE: 0x10,
    SWITCH_INVERT: 0x20,
    ONBOARD_REMOTE_SWITCH_INVERT: 0x40,
    REMOTE_GENERATOR_SELECTED: 0x80,
});

const InterfaceFlags = Object.freeze({
    PANEL_DETECT: 0x01,
    STANDBY: 0x02,
    UNDOCUMENTED_04: 0x04,
});

const DEFAULT_INTERFACE_FLAGS = InterfaceFlags.PANEL_DETECT | InterfaceFlags.UNDOCUMENTED_04;

const Fault = Object.freeze({
    INACCESSIBLE: 'INACCESSIBLE',
    IO_ERROR: 'IO_ERROR',
    EXCEPTION: 'EXCEPTION',
});

const ProbeResult = Object.freeze({
    OK: 'OK',
    INACCESSIBLE: 'INACCESSIBLE',
    IO_ERROR: 'IO_ERROR',
    UNRESPONSIVE: 'UNRESPONSIVE',
    EXCEPTION: 'EXCEPTION',
});

const LOG_METHODS = ['error', 'warn', 'info', 'debug'];

function validateLog(log) {
    if (!log || !LOG_METHODS.every(method => typeof log[method] === 'function')) {
        throw new TypeError('log must provide error, warn, info, and debug methods');
    }
}

class VersionResponse extends Response {
    constructor(version) {
        super();
        this.version = version;
    }
}

class LEDResponse extends Response {
    constructor(on, blink) {
        super();
        this.on = on;
        this.blink = blink;
    }
}

class ConfigResponse extends Response {
    constructor(
        last_active_ac_input,
        current_limit_overridden_by_panel,
        digital_multi_control_dedicated,
        num_ac_inputs,
        remote_panel_detected,
        minimum_current_limit,
        maximum_current_limit,
        actual_current_limit,
        switch_register,
    ) {
        super();
        Object.assign(this, {
            last_active_ac_input,
            current_limit_overridden_by_panel,
            digital_multi_control_dedicated,
            num_ac_inputs,
            remote_panel_detected,
            minimum_current_limit,
            maximum_current_limit,
            actual_current_limit,
            switch_register,
        });
    }
}

class DCResponse extends Response {
    constructor(dc_voltage, dc_current_to_inverter, dc_current_from_charger, ac_inverter_frequency) {
        super();
        Object.assign(this, {
            dc_voltage,
            dc_current_to_inverter,
            dc_current_from_charger,
            ac_inverter_frequency,
        });
    }
}

class ACResponse extends Response {
    constructor(
        ac_phase,
        ac_num_phases,
        device_state,
        ac_mains_voltage,
        ac_mains_current,
        ac_inverter_voltage,
        ac_inverter_current,
        ac_mains_frequency,
    ) {
        super();
        Object.assign(this, {
            ac_phase,
            ac_num_phases,
            device_state,
            ac_mains_voltage,
            ac_mains_current,
            ac_inverter_voltage,
            ac_inverter_current,
            ac_mains_frequency,
        });
    }
}

class PowerResponse extends Response {
    constructor(dc_power, ac_mains_power, ac_inverter_power) {
        super();
        Object.assign(this, { dc_power, ac_mains_power, ac_inverter_power });
    }
}

class StateResponse extends Response {}

class InterfaceResponse extends Response {
    constructor(flags) {
        super();
        this.flags = flags;
    }
}

class Handler {
    on_response(_response) {}
    on_idle() {}
    on_fault(_fault) {}
}

function encodeFrame(command, data = []) {
    const frame = Buffer.alloc(data.length + 4);
    frame[0] = data.length + 2;
    frame[1] = 0xff;
    frame[2] = typeof command === 'number' ? command : command.charCodeAt(0);
    data.forEach((byte, index) => {
        frame[index + 3] = byte;
    });
    let sum = 0;
    for (let i = 0; i < frame.length - 1; i += 1) sum += frame[i];
    frame[frame.length - 1] = (256 - sum) & 0xff;
    return frame;
}

class VariableInfo {
    constructor(signed, scale, offset) {
        this.signed = signed;
        this.scale = scale;
        this.offset = offset;
    }

    parse(raw) {
        if (raw.length < 1 || raw.length > 3) {
            throw new RangeError('Variable data must contain between one and three bytes');
        }
        let value = 0;
        for (let index = 0; index < raw.length; index += 1) {
            value += raw[index] * 2 ** (index * 8);
        }
        const bits = raw.length * 8;
        if (this.signed && value >= 2 ** (bits - 1)) value -= 2 ** bits;
        return this.scale * (value + this.offset);
    }
}

class VictronMK3Driver {
    constructor(options) {
        validateLog(options.log);
        this.log = options.log;
        this.options = options;

        this.port = null;
        this.buffer = Buffer.alloc(0);
        this.idleTimer = null;
        this.waiters = new Set();
        this.wNonce = 0;
        this.wCompletion = null;
        this.variableIdQueue = [0, 1, 2, 3, 4, 5, 7, 8, 14, 15, 16];
        this.variableInfo = new Map();
        this.variableInfoRequestTime = 0;
        this.faulted = false;
    }

    async start() {
        let port;
        try {
            port = new SerialPort({
                path: this.options.path,
                baudRate: 2400,
                parity: 'none',
                stopBits: 1,
                autoOpen: false,
            });
        } catch (error) {
            this.reportFault(Fault.INACCESSIBLE, error);
            return;
        }
        this.port = port;

        await new Promise(resolve => {
            try {
                port.open(error => {
                    if (error) {
                        this.reportFault(Fault.INACCESSIBLE, error);
                        resolve();
                        return;
                    }
                    port.on('data', data => this.onData(data));
                    port.on('error', readError => this.reportFault(Fault.IO_ERROR, readError));
                    port.on('close', () => {
                        if (!this.faulted && this.port === port) {
                            this.reportFault(Fault.IO_ERROR, new Error('Serial port closed'));
                        }
                    });
                    this.touchIdleTimer();
                    this.sendFrame('V', []);
                    this.sendFrame('S', [0x00, 0x00, 0x00, 0x01, 0x90, 0x00, 0x01, 0x00]);
                    this.populateNextVariableInfo();
                    resolve();
                });
            } catch (error) {
                this.reportFault(Fault.INACCESSIBLE, error);
                resolve();
            }
        });
    }

    async stop() {
        clearTimeout(this.idleTimer);
        this.faulted = true;
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(null);
        }
        this.waiters.clear();
        const port = this.port;
        this.port = null;
        if (port?.isOpen) {
            await new Promise(resolve => port.close(() => resolve()));
        }
    }

    sendFrame(command, data) {
        if (!this.port?.isOpen) return;
        const frame = encodeFrame(command, data);
        this.log.debug(`>> ${frame.toString('hex')}`);
        this.port.write(frame, error => {
            if (error) this.reportFault(Fault.IO_ERROR, error);
        });
    }

    async waitForResponse(ResponseType, timeout, predicate = null) {
        if (!this.port?.isOpen) return null;
        return new Promise(resolve => {
            const waiter = { ResponseType, predicate, resolve, timer: null };
            waiter.timer = setTimeout(() => {
                this.waiters.delete(waiter);
                resolve(null);
            }, timeout);
            this.waiters.add(waiter);
        });
    }

    request(ResponseType, timeout, command, data, predicate = null) {
        if (!this.port?.isOpen) return Promise.resolve(null);
        const result = this.waitForResponse(ResponseType, timeout, predicate);
        if (command !== null) this.sendFrame(command, data);
        return result;
    }

    sendVersionRequest() {
        return this.request(VersionResponse, REQUEST_TIMEOUT_MS, 'V', []);
    }

    sendInterfaceRequest(flags = null) {
        return this.request(InterfaceResponse, REQUEST_TIMEOUT_MS, 'H', flags === null ? [] : [flags]);
    }

    sendLEDRequest() {
        return this.request(LEDResponse, REQUEST_TIMEOUT_MS, 'L', []);
    }

    sendDCRequest() {
        return this.request(DCResponse, REQUEST_TIMEOUT_MS, 'F', [0]);
    }

    sendACRequest(phase) {
        if (!Number.isInteger(phase) || phase < 1 || phase > AC_PHASES_SUPPORTED) {
            throw new RangeError(`phase must be an integer from 1 to ${AC_PHASES_SUPPORTED}`);
        }
        return this.request(ACResponse, REQUEST_TIMEOUT_MS, 'F', [phase], response => response.ac_phase === phase);
    }

    sendConfigRequest() {
        return this.request(ConfigResponse, CONFIG_TIMEOUT_MS, 'F', [5]);
    }

    sendStateRequest(switchState, currentLimit = null) {
        if (!Object.values(SwitchState).includes(switchState)) {
            throw new RangeError('switchState is not a valid SwitchState');
        }
        if (currentLimit !== null && currentLimit !== undefined && !Number.isFinite(currentLimit)) {
            throw new TypeError('currentLimit must be a finite number or null');
        }
        let value;
        if (currentLimit === null || currentLimit === undefined) value = 0x8000;
        else if (currentLimit <= 0) value = 0;
        else value = Math.min(Math.trunc(currentLimit * 10), 0x7fff);
        return this.request(StateResponse, REQUEST_TIMEOUT_MS, 'S', [
            switchState,
            value & 0xff,
            value >> 8,
            0x01,
            0x80,
        ]);
    }

    sendPowerRequest() {
        if (!this.port?.isOpen) return Promise.resolve(null);
        const result = this.waitForResponse(PowerResponse, REQUEST_TIMEOUT_MS);
        this.sendWRequest([0x30, 14, 15, 16], (handler, message) => {
            if (this.ensureVariableInfoAvailable() && message.length >= 9 && message[2] === 0x85) {
                handler.on_response(
                    new PowerResponse(
                        this.variableInfo.get(14).parse(message.subarray(3, 5)),
                        -this.variableInfo.get(15).parse(message.subarray(5, 7)),
                        this.variableInfo.get(16).parse(message.subarray(7, 9)),
                    ),
                );
            }
        });
        return result;
    }

    onData(data) {
        try {
            this.touchIdleTimer();
            this.buffer = Buffer.concat([this.buffer, data]);
            while (this.buffer.length >= 2) {
                const messageLength = this.buffer[0] + 1;
                if (this.buffer.length < messageLength + 1) return;
                const message = this.buffer.subarray(1, messageLength + 1);
                let checksum = this.buffer[0];
                for (const byte of message) checksum += byte;
                if ((checksum & 0xff) !== 0) {
                    this.buffer = this.buffer.subarray(1);
                    continue;
                }
                this.log.debug(`<< ${this.buffer.subarray(0, messageLength + 1).toString('hex')}`);
                this.handleFrame(message.subarray(0, message.length - 1));
                this.buffer = this.buffer.subarray(messageLength + 1);
            }
        } catch (error) {
            this.reportFault(Fault.EXCEPTION, error);
        }
    }

    touchIdleTimer() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (!this.port || this.faulted) return;
            this.log.debug('** Read timeout (interface is idle)');
            try {
                this.options.handler?.on_idle();
            } catch (error) {
                this.reportFault(Fault.EXCEPTION, error);
                return;
            }
            this.touchIdleTimer();
        }, IDLE_TIMEOUT_MS);
    }

    handleFrame(message) {
        if (message.length >= 2 && message[0] === 0xff) {
            const command = String.fromCharCode(message[1]);
            if (command === 'V' && message.length >= 6) {
                this.deliverResponse(new VersionResponse(message.readUInt32LE(2)));
            } else if (command === 'H' && message.length >= 3) {
                this.deliverResponse(new InterfaceResponse(message[2]));
            } else if (command === 'L' && message.length >= 4) {
                this.deliverResponse(new LEDResponse(message[2], message[3]));
            } else if (command === 'S') {
                this.deliverResponse(new StateResponse());
            } else if (command === 'X' || command === 'Y' || command === 'Z') {
                this.handleWResponse({ X: 0, Y: 1, Z: 2 }[command], message);
            }
        } else if (message.length >= 15 && message[0] === 0x20) {
            if (!this.ensureVariableInfoAvailable()) return;
            if (message[5] === 0x0c) {
                this.deliverResponse(
                    new DCResponse(
                        this.variableInfo.get(4).parse(message.subarray(6, 8)),
                        this.variableInfo.get(5).parse(message.subarray(8, 11)),
                        this.variableInfo.get(5).parse(message.subarray(11, 14)),
                        this.periodToFrequency(this.variableInfo.get(7).parse(message.subarray(14, 15))),
                    ),
                );
            } else if (message[5] >= 0x05 && message[5] <= 0x0b) {
                const inverterCurrentInfo = this.variableInfo.get(3);
                const current = inverterCurrentInfo.parse(message.subarray(12, 14));
                this.deliverResponse(
                    new ACResponse(
                        Math.max(9 - message[5], 1),
                        Math.max(message[5] - 7, 0),
                        message[4],
                        this.variableInfo.get(0).parse(message.subarray(6, 8)),
                        this.variableInfo.get(1).parse(message.subarray(8, 10)) * message[1],
                        this.variableInfo.get(2).parse(message.subarray(10, 12)),
                        current * message[2],
                        this.periodToFrequency(this.variableInfo.get(8).parse(message.subarray(14, 15))),
                    ),
                );
            }
        } else if (message.length >= 13 && message[0] === 0x41) {
            this.deliverResponse(
                new ConfigResponse(
                    message[5] & 0x03,
                    (message[5] & 0x04) !== 0,
                    (message[5] & 0x08) !== 0,
                    (message[5] & 0x70) >> 4,
                    (message[5] & 0x80) !== 0,
                    message.readUInt16LE(6) / 10,
                    message.readUInt16LE(8) / 10,
                    message.readUInt16LE(10) / 10,
                    message[12],
                ),
            );
        }
    }

    deliverResponse(response) {
        for (const waiter of this.waiters) {
            if (response instanceof waiter.ResponseType && (!waiter.predicate || waiter.predicate(response))) {
                this.waiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(response);
                break;
            }
        }
        this.handler?.on_response(response);
    }

    ensureVariableInfoAvailable() {
        if (this.variableIdQueue.length === 0) return true;
        this.populateNextVariableInfo();
        return false;
    }

    populateNextVariableInfo() {
        if (this.variableIdQueue.length === 0 || !this.port?.isOpen) return;
        if (Date.now() - this.variableInfoRequestTime < REQUEST_TIMEOUT_MS) return;
        this.variableInfoRequestTime = Date.now();
        const id = this.variableIdQueue[0];
        this.sendFrame('A', [1, 0]);
        this.sendWRequest([0x36, id & 0xff, id >> 8], this.handleVariableInfoResponse.bind(this));
    }

    handleVariableInfoResponse(handler, message) {
        this.variableInfoRequestTime = 0;
        if (message.length < 8 || message[2] !== 0x8e || message[5] !== 0x8f) return;
        let scale = message.readUInt16LE(3);
        let signed = false;
        if (scale >= 0x8000) {
            scale = 0x10000 - scale;
            signed = true;
        }
        if (scale >= 0x4000) scale = 1 / (0x8000 - scale);
        let offset = message.readUInt16LE(6);
        if (offset >= 0x8000) offset -= 0x10000;
        const id = this.variableIdQueue.shift();
        if (HACK_OVERRIDE_AC_INVERTER_CURRENT_SIGNEDNESS && id === 3) signed = true;
        this.variableInfo.set(id, new VariableInfo(signed, scale, offset));
        this.populateNextVariableInfo();
    }

    sendWRequest(message, completion) {
        this.wNonce = (this.wNonce + 1) % 3;
        this.wCompletion = completion;
        this.sendFrame(['X', 'Y', 'Z'][this.wNonce], message);
    }

    handleWResponse(nonce, message) {
        if (this.wNonce !== nonce || !this.wCompletion) return;
        const completion = this.wCompletion;
        this.wCompletion = null;
        completion(this.options.handler, message);
    }

    reportFault(fault, error) {
        if (this.faulted) return;
        this.faulted = true;
        clearTimeout(this.idleTimer);
        this.log.error(`Fault: ${fault}`);
        this.options.handler?.on_fault(fault);
    }

    periodToFrequency(period) {
        return period === 0 ? 0 : Math.round((10 / period) * 100) / 100;
    }
}

class VictronMK3 {
    constructor(options) {
        if (!options?.path) throw new TypeError('A serial port path is required');
        validateLog(options.log);
        this.log = options.log;
        this.options = options;
        this.driver = null;
    }

    async start(handler = new Handler()) {
        if (this.driver) throw new Error('VictronMK3 is already running');
        this.driver = new VictronMK3Driver({ ...this.options, handler });
        await this.driver.start();
    }

    async stop() {
        if (!this.driver) throw new Error('VictronMK3 is not running');
        const driver = this.driver;
        this.driver = null;
        await driver.stop();
    }

    sendInterfaceRequest(flags = null) {
        return this.driver?.sendInterfaceRequest(flags) ?? Promise.resolve(null);
    }

    sendVersionRequest() {
        return this.driver?.sendVersionRequest() ?? Promise.resolve(null);
    }

    sendLEDRequest() {
        return this.driver?.sendLEDRequest() ?? Promise.resolve(null);
    }

    sendDCRequest() {
        return this.driver?.sendDCRequest() ?? Promise.resolve(null);
    }

    sendACRequest(phase) {
        return this.driver?.sendACRequest(phase) ?? Promise.resolve(null);
    }

    sendConfigRequest() {
        return this.driver?.sendConfigRequest() ?? Promise.resolve(null);
    }

    sendStateRequest(switchState, currentLimit = null) {
        return this.driver?.sendStateRequest(switchState, currentLimit) ?? Promise.resolve(null);
    }

    sendPowerRequest() {
        return this.driver?.sendPowerRequest() ?? Promise.resolve(null);
    }
}

class ProbeHandler extends Handler {
    constructor(options) {
        super();
        validateLog(options.log);
        this.log = options.log;
        this.result = ProbeResult.INACCESSIBLE;
        this.finished = new Promise(resolve => {
            this.finish = resolve;
        });
    }

    on_response(response) {
        this.log.debug(response);
        this.result = ProbeResult.OK;
        this.finish();
    }

    on_idle() {
        this.result = ProbeResult.UNRESPONSIVE;
        this.finish();
    }

    on_fault(fault) {
        this.result = {
            [Fault.INACCESSIBLE]: ProbeResult.INACCESSIBLE,
            [Fault.IO_ERROR]: ProbeResult.IO_ERROR,
            [Fault.EXCEPTION]: ProbeResult.EXCEPTION,
        }[fault];
        this.finish();
    }
}

async function probe(options) {
    const handler = new ProbeHandler(options);
    const mk3 = new VictronMK3(options);
    await mk3.start(handler);
    await handler.finished;
    await mk3.stop();
    return handler.result;
}

module.exports = {
    AC_PHASES_SUPPORTED,
    DEFAULT_INTERFACE_FLAGS,
    DeviceState,
    Fault,
    Handler,
    InterfaceFlags,
    LEDState,
    ProbeResult,
    Response,
    SwitchRegister,
    SwitchState,
    ACResponse,
    ConfigResponse,
    DCResponse,
    InterfaceResponse,
    LEDResponse,
    PowerResponse,
    StateResponse,
    VersionResponse,
    VictronMK3,
    encodeFrame,
    probe,
};
