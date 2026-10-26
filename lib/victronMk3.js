// Initially ported from https://github.com/j9brown/victron-mk3 with Copilot
// ... but then most of that binned because turns out Python ported to JS
// by an AI is almost as bad as the original!

'use strict';

const { SerialPort } = require('serialport');

const AC_PHASES_SUPPORTED = 4;
const DATA_RESPONSE_TIMEOUT_MS = 500;
const DATA_TIMEOUT_MS = 100;

const LOG_METHODS = ['error', 'warn', 'info', 'debug'];

class VictronMK3 {
    constructor(options) {
        if (!options?.path) throw new TypeError('serial port path is required');

        this.log = options.log;
        if (!this.log || !LOG_METHODS.every(method => typeof this.log[method] === 'function')) {
            throw new TypeError('log must provide error, warn, info, and debug methods');
        }

        this.options = options;

        this.dataTimer = null;
        this.requestTimer = null;

        // Defaults - should be read from bus
        this.scale = 0;
        this.signed = false;
        this.offset = 0;
        this.acPhases = 1;
    }

    clearTimer(timer) {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    clearRequest() {
        this.commandWaiting = this.resolver = this.rejector = null;
    }

    async start() {
        this.port = new SerialPort({
            path: this.options.path,
            baudRate: 2400,
            parity: 'none',
            stopBits: 1,
            autoOpen: false,
        });

        this.clearBuffer();
        this.port.on('data', data => {
            // The MK2/3 constantly send version information around once per second if nothing else is being sent so handle that
            this.log.debug(`<< ${data.toString('hex')} (${data.length} bytes)`);
            this.buffer = Buffer.concat([this.buffer, data]);
            this.clearTimer(this.dataTimer);
            this.dataTimer = setTimeout(() => {
                this.dataTimer = null;
                while (this.frameLength(this.buffer) < this.buffer.length) {
                    this.log.debug(`<< Multi-frame ${this.buffer.toString('hex')} (${this.buffer.length} bytes)`);
                    const frame = this.buffer.subarray(0, this.frameLength(this.buffer));
                    this.buffer = this.buffer.subarray(this.frameLength(this.buffer));
                    this.handleFrame(frame);
                }
                if (this.buffer.length > 0) {
                    // Handle anything left
                    this.handleFrame(this.buffer);
                    this.clearBuffer();
                }
            }, DATA_TIMEOUT_MS);
        });

        this.port.on('error', err => {
            this.log.error(`Error: ${err}`);
        });

        this.port.on('close', () => {
            this.log.debug('Closed');
        });

        this.port.open();

        // Get scale/signed/offset from bus
        await this.request('W', [0x36, 0]); // CommandGetRAMVarInfo
    }

    stop() {
        this.port?.close();
        this.clearTimer(this.dataTimer);
        this.clearTimer(this.requestTimer);
        this.clearRequest();
        this.buffer = null;
    }

    clearBuffer() {
        this.buffer = Buffer.alloc(0);
    }

    frameLength(buffer) {
        return buffer[0] + 2; /* frame + len + checksum */
    }

    // scale/signed/offset should be set with handleVariableInfoResponse
    decodeInfoVariable(raw) {
        if (raw.length < 1 || raw.length > 3) {
            throw new RangeError('Variable data must contain between one and three bytes');
        }
        let value = 0;
        for (let index = 0; index < raw.length; index += 1) {
            value += raw[index] * 2 ** (index * 8);
        }
        const bits = raw.length * 8;
        if (this.signed && value >= 2 ** (bits - 1)) {
            value -= 2 ** bits;
        }
        const out = this.scale * (value + this.offset);

        return out;
    }

    decodePeriod(raw) {
        return raw === 0 ? 0 : Math.round((10 / raw) * 100) / 100;
    }

    handleFrame(data) {
        let isGood = true;

        this.log.debug(`<< Frame ${data.toString('hex')} (${data.length} bytes)`);

        if (data[0] != data.length - 2) {
            this.log.error('Invalid data length');
            isGood = false;
        } else {
            let checksum = 0;
            for (const byte of data) {
                checksum += byte;
            }
            checksum &= 0xff;
            if ((checksum & 0xff) !== 0) {
                this.log.error(`Invalid checksum ${checksum}`);
                isGood = false;
            }
        }

        if (isGood) {
            data = data.subarray(1, data.length - 1);
            if (data.length >= 2 && data[0] === 0xff) {
                // This is a MK2 frame
                this.log.debug(`<< MK2 Frame ${data.toString('hex')} (${data.length} bytes)`);

                const command = String.fromCharCode(data[1]);
                switch (command) {
                    case 'L':
                        if (data.length < 3) {
                            this.log.warn('ledResponse looks too short');
                        } else {
                            const response = { ledOn: data[2], ledBlink: data[3] };
                            this.log.debug(`<< ledResponse: ${JSON.stringify(response)}`);
                            this.resolveRequest('L', response);
                        }
                        break;
                    case 'V':
                        if (data.length < 6) {
                            this.log.warn('versionResponse looks too short');
                        } else {
                            const response = { version: data.readUInt32LE(2) /*TODO: mode */ };
                            this.log.debug(`<< VersionResponse: ${JSON.stringify(response)}`);
                            this.resolveRequest('V', response);
                        }
                        break;
                    case 'W':
                    case 'X':
                    case 'Y':
                    case 'Z':
                        if (data.length < 8 || data[2] !== 0x8e || data[5] !== 0x8f) {
                            this.log.warn('handleVariableInfoResponse looks malformed');
                        } else {
                            this.scale = data.readUInt16LE(3);
                            this.signed = false;
                            if (this.scale >= 0x8000) {
                                this.scale = 0x10000 - this.scale;
                                this.signed = true;
                            }
                            if (this.scale >= 0x4000) {
                                this.scale = 1 / (0x8000 - this.scale);
                            }
                            this.offset = data.readUInt16LE(6);
                            if (this.offset >= 0x8000) {
                                this.offset -= 0x10000;
                            }
                            this.log.debug(`<< scale/signed/offset: ${this.scale}/${this.signed}/${this.offset}`);
                        }
                        this.resolveRequest(command);
                        break;

                    default:
                        this.log.warn(`Invalid command: ${command}`);
                }
            } else if (data.length >= 15 && data[0] === 0x20) {
                // Info Frame
                data = data.subarray(1);
                this.log.debug(`<< Info Frame ${data.toString('hex')} (${data.length} bytes)`);

                const phaseInfo = data[4];
                switch (phaseInfo) {
                    case 0x05:
                    case 0x06:
                    case 0x07:
                    case 0x08:
                    case 0x09:
                    case 0x0a:
                    case 0x0b:
                        {
                            const response = {
                                phaseInfo: phaseInfo,
                                bfFactor: data[0],
                                inverterFactor: data[1],
                                state: data[3],
                                mainsVoltage: this.decodeInfoVariable(data.subarray(5, 7)),
                                mainsCurrent: this.decodeInfoVariable(data.subarray(7, 9)),
                                inverterVoltage: this.decodeInfoVariable(data.subarray(9, 11)),
                                inverterCurrent: this.decodeInfoVariable(data.subarray(13, 15)),
                                mainsPeriod: this.decodePeriod(data.subarray(13)),
                            };
                            // Remember acPhases if this is the correct frame for that
                            if (phaseInfo >= 0x08 && phaseInfo <= 0x0b) {
                                this.acPhases = phaseInfo - 7;
                                // All these frames refer to phase 1
                                response.phaseInfo = 1;
                            }
                            response.acPhases = this.acPhases;

                            this.log.debug(`<< acResponse: ${JSON.stringify(response)}`);
                            this.resolveRequest('F', response);
                        }
                        break;

                    case 0x0c:
                        {
                            const response = {
                                phaseInfo: phaseInfo,
                                dcVoltage: this.decodeInfoVariable(data.subarray(5, 7)),
                                dcCurrentInverter: this.decodeInfoVariable(data.subarray(7, 10)),
                                dcCurrentCharger: this.decodeInfoVariable(data.subarray(10, 13)),
                                inverterPeriod: this.decodePeriod(data.subarray(13, 15)),
                            };
                            this.log.debug(`<< dcResponse: ${JSON.stringify(response)}`);
                            this.resolveRequest('F', response);
                        }
                        break;
                    default:
                        this.log.warn(`Unknown phase info: ${phaseInfo}`);
                }
            } else if (data.length >= 13 && data[0] === 0x41) {
                // MasterMultiLED frame
                data = data.subarray(1);
                this.log.debug(`<< MasterMultiLED Frame ${data.toString('hex')} (${data.length} bytes)`);
                const response = {
                    acConfiguration: data[4],
                    minInputCurrent: this.decodeInfoVariable(data.subarray(5, 7)),
                    maxInputCurrent: this.decodeInfoVariable(data.subarray(7, 9)),
                    actualInputCurrent: this.decodeInfoVariable(data.subarray(9, 11)),
                    switchRegister: data[11],
                };
                this.log.debug(`<< mmlResponse: ${JSON.stringify(response)}`);
                this.resolveRequest('F', response);
            }
        }
    }

    encodeFrame(command, data = []) {
        const frame = Buffer.alloc(data.length + 4);
        frame[0] = data.length + 2;
        frame[1] = 0xff;
        frame[2] = typeof command === 'number' ? command : command.charCodeAt(0);
        data.forEach((byte, index) => {
            frame[index + 3] = byte;
        });
        let sum = 0;
        for (let lp = 0; lp < frame.length - 1; lp += 1) {
            sum += frame[lp];
        }
        frame[frame.length - 1] = (256 - sum) & 0xff;
        return frame;
    }

    sendFrame(command, data) {
        const frame = this.encodeFrame(command, data);
        this.log.debug(`>> ${frame.toString('hex')}`);
        this.port?.write(frame, error => {
            if (error) {
                this.log.error(error);
            }
        });
    }

    resolveRequest(commandReply, response) {
        if (this.commandWaiting != commandReply) {
            // 'V' responses are expected as these are 'heartbeat' messages recieved every second
            if (commandReply == 'V') {
                // Heartbeat
            } else {
                this.log.warn(
                    `<<<< Unsolicited response: ${commandReply}${this.commandWaiting ? ` (waiting for ${this.commandWaiting})` : ''}`,
                );
            }
        } else {
            this.clearTimer(this.requestTimer);
            let resolve = this.resolver;
            this.clearRequest();
            if (!resolve) {
                this.log.error('No resolver for request');
            } else {
                resolve(response);
            }
        }
    }

    request(command, data) {
        if (this.commandWaiting || this.resolver || this.rejector) {
            return Promise.reject(new Error('Already listening for a response'));
        }

        this.commandWaiting = command;
        return new Promise((resolve, reject) => {
            this.resolver = resolve;
            this.rejector = reject;

            this.requestTimer = setTimeout(() => {
                this.requestTimer = null;
                this.clearRequest();
                reject(new Error('Timed out waiting for response'));
            }, DATA_RESPONSE_TIMEOUT_MS);

            this.sendFrame(command, data);
        });
    }

    sendLedRequest() {
        return this.request('L');
    }
    sendDcRequest() {
        return this.request('F', [0]);
    }
    sendAcRequest(phase) {
        return this.request('F', [phase]);
    }
    sendPowerRequest() {}
    sendConfigRequest() {
        return this.request('F', [5]);
    }
    sendVersionRequest() {
        return this.request('V');
    }
}

module.exports = {
    AC_PHASES_SUPPORTED,
    VictronMK3,
};
