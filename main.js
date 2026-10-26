'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const { AC_PHASES_SUPPORTED, VictronMK3 } = require('./lib/victronMk3');

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
    }

    // Set/reset connection
    async setConnected(connected) {
        await this.setState('info.connection', connected, true);
    }

    // Sleep between polls
    sleep(ms) {
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Not connected by default
        await this.setConnected(false);

        this.mk3 = new VictronMK3({ log: this.log, path: this.config.serialPort });
        await this.mk3.start();

        while (true) {
            // TODO: only on heartbeat
            await this.setConnected(true);

            // TODO: Stash these in states
            await this.mk3.sendConfigRequest();
            await this.mk3.sendDcRequest();
            await this.mk3.getAllAcPhases();
            await this.mk3.sendPowerRequest();

            await this.sleep(10000);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.mk3?.stop();
            this.setConnected(false).then(() => {
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
