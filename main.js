'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const { AC_PHASES_SUPPORTED, HEARTBEAT_EVENT, LEDS, VictronMK3 } = require('./lib/victronMk3');
const POLL_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const RETRY_TIMEOUT_MS = 30000;

class VictronVeBus extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'victron-ve-bus',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.heartbeatTimer = null;
    }

    // Set/reset connection
    async setConnected(connected) {
        await this.setStateChanged('info.connection', connected, true);
    }

    // Sleep between polls
    sleep(ms) {
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }

    clearHeartbeatTimer() {
        if (this.heartbeatTimer) {
            this.clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Not connected by default
        await this.setConnected(false);
        if (!this.config.serialPort) {
            this.log.error('No serial port configured! Please define the serial port in adapter settings.');
            this.disable();
        } else {
            await this.createObjects();
            this.startMk3();
        }
    }

    async startMk3() {
        this.log.info(`Connecting to MK3 on ${this.config.serialPort}`);

        this.mk3 = new VictronMK3({ log: this.log, path: this.config.serialPort });

        this.mk3.on(HEARTBEAT_EVENT, () => {
            this.log.debug('Heartbeat');
            this.clearHeartbeatTimer();
            this.setConnected(true);

            this.heartbeatTimer = this.setTimeout(() => {
                this.heartbeatTimer = null;
                this.log.warn('Heartbeat timeout');
                this.setConnected(false);
            }, HEARTBEAT_TIMEOUT_MS);
        });

        try {
            await this.mk3.start();

            while (true) {
                // TODO: Stash these in states
                await this.mk3.sendConfigRequest();
                await this.setLeds(await this.mk3.sendLedRequest());
                await this.setDc(await this.mk3.sendDcRequest());
                await this.setAc(await this.mk3.getAllAcPhases());
                await this.mk3.sendPowerRequest();

                await this.sleep(POLL_INTERVAL_MS);
            }
        } catch (err) {
            this.log.error(err);
            this.stopMk3();
            this.log.info(`Retry in ${RETRY_TIMEOUT_MS / 1000}s`);
            this.setTimeout(() => {
                this.startMk3();
            }, RETRY_TIMEOUT_MS);
        }
    }

    async stopMk3() {
        this.log.info(`Shutting down MK3`);
        this.clearHeartbeatTimer();
        this.mk3?.removeAllListeners();
        this.mk3?.stop();
        await this.setConnected(false);
    }

    async setLeds(leds) {
        await this.setStateChanged('leds.raw_blink', leds.ledBlink, true);
        await this.setStateChanged('leds.raw_on', leds.ledOn, true);

        for (const led of LEDS) {
            // Victron doco says LED off with blink on == anti-phase blink
            await this.setStateChanged(`leds.${led}`, leds[led].on + leds[led].blink * 2, true);
        }
    }

    async setDc(dc) {
        await this.setStateChanged('dc.voltage', dc.voltage, true);
        await this.setStateChanged('dc.inverter_current', dc.currentInverter, true);
        await this.setStateChanged('dc.inverter_period', dc.inverterPeriod, true);
        await this.setStateChanged('dc.charger_current', dc.currentCharger, true);
    }

    async setAc(acPhases) {
        for (const phase of acPhases) {
            const phaseId = phase.phaseInfo;
            await this.setStateChanged(`ac.${phaseId}.bf_factor`, phase.bfFactor, true);
            await this.setStateChanged(`ac.${phaseId}.inverter_factor`, phase.inverterFactor, true);
            await this.setStateChanged(`ac.${phaseId}.state`, phase.state, true);
            await this.setStateChanged(`ac.${phaseId}.mains_voltage`, phase.mainsVoltage, true);
            await this.setStateChanged(`ac.${phaseId}.mains_current`, phase.mainsCurrent, true);
            await this.setStateChanged(`ac.${phaseId}.inverter_voltage`, phase.inverterVoltage, true);
            await this.setStateChanged(`ac.${phaseId}.inverter_current`, phase.inverterCurrent, true);
            await this.setStateChanged(`ac.${phaseId}.mains_period`, phase.mainsPeriod, true);
        }
    }

    async createObjects() {
        const folders = [
            ['leds', 'LED states'],
            ['master_multi_led', 'MasterMultiLED'],
            ['dc', 'DC'],
            ['ac', 'AC'],
        ];
        for (let phase = 1; phase <= AC_PHASES_SUPPORTED; phase++) {
            folders.push([`ac.${phase}`, `AC phase ${phase}`]);
        }

        for (const folder of folders) {
            await this.setObjectNotExistsAsync(folder[0], {
                type: 'folder',
                common: {
                    name: folder[0],
                    desc: folder[1],
                },
                native: {},
            });
        }

        const dcPhaseStates = [
            ['voltage', 'number', 'value.voltage', 'DC voltage'],
            ['inverter_current', 'number', 'value.current', 'Inverter current'],
            ['inverter_period', 'number', 'value.frequency', 'Inverter period'],
            ['charger_current', 'number', 'value.current', 'Charger current'],
        ];
        await this.createStatesFromList(dcPhaseStates, 'dc.');

        const acPhaseStates = [
            ['bf_factor', 'number', 'value', 'BF (backfeed) factor'],
            ['inverter_factor', 'number', 'value', 'Inverter factor'],
            // TODO: decode state
            ['state', 'number', 'value', 'State bitmask'],
            ['mains_voltage', 'number', 'value.voltage', 'Mains voltage'],
            ['mains_current', 'number', 'value.current', 'Mains current'],
            ['inverter_voltage', 'number', 'value.voltage', 'Inverter voltage'],
            ['inverter_current', 'number', 'value.current', 'Inverter current'],
            ['mains_period', 'number', 'value.frequency', 'Mains period'],
        ];
        for (let phase = 1; phase <= AC_PHASES_SUPPORTED; phase++) {
            await this.createStatesFromList(acPhaseStates, `ac.${phase}.`);
        }

        const ledStates = [
            ['leds.raw_on', 'number', 'value', 'Raw LED on value'],
            ['leds.raw_blink', 'number', 'value', 'Raw LED blink value'],
        ];

        for (const led of LEDS) {
            ledStates.push([
                `leds.${led}`,
                'number',
                'value',
                `Status of ${led}`,
                { 0: 'Off', 1: 'On', 2: 'Anti-phase blinking', 3: 'blinking' },
            ]);
        }
        await this.createStatesFromList(ledStates);
    }

    async createStatesFromList(stateList, prefix = '') {
        for (const state of stateList) {
            const common = {
                name: state[0],
                type: state[1],
                role: state[2],
                desc: state[3],
                read: true,
                write: false,
            };
            if (state[4]) {
                // Add a common state when given
                common.state = state[4];
            }
            await this.setObjectNotExistsAsync(`${prefix}${state[0]}`, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.stopMk3().then(() => {
                callback();
            });
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new VictronVeBus(options);
} else {
    // otherwise start the instance directly
    new VictronVeBus();
}
