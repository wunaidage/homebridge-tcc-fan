// This platform integrates Honeywell TCC's Fan into homebridge
// As I only own single thermostat, so this only works with one, but it is
// conceivable to handle mulitple with additional coding.
//
// The configuration is stored inside the ../config.json
// {
//     "platform": "tcc",
//     "name":     "Fan",
//     "username" : "username/email",
//     "password" : "password",
//     "debug" : "True",      - Optional
//     "refresh": "60",       - Optional
//     "devices" : [
//        { "deviceID": "123456789", "name" : "Main Floor Thermostat" },
//        { "deviceID": "123456789", "name" : "Upper Floor Thermostat" }
//     ]
// }
//

/*jslint node: true */
'use strict';

const tcc = require('./lib/tcc.js');
let Accessory, Service, Characteristic, UUIDGen;

const myAccessories = [];
let session; // reuse the same login session
let updating; // Only one change at a time!!!!

module.exports = function(homebridge) {

    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform("homebridge-tcc-fan", "tcc-fan", tccPlatform);
}

function tccPlatform(log, config, api) {

    this.username = config['username'];
    this.password = config['password'];
    this.refresh = config['refresh'] || 60; // Update every minute
    this.debug = config['debug'] || false;
    this.log = log;
    this.devices = config['devices'];

    updating = false;
}

tccPlatform.prototype = {
    accessories: function(callback) {
        this.log("Logging into tcc...");
        const that = this;

        tcc.setCharacteristic(Characteristic);
        tcc.setDebug(this.debug);

        tcc.login(that.username, that.password).then(function(login) {
            this.log.info("Logged into tcc!", this.devices);
            session = login;

            let requests = this.devices.map((device) => {
                return new Promise((resolve) => {

                    session.CheckDataSession(device.deviceID,
                        function(err, deviceData) {
                            if (err) {
                                that.log.error("Create Device Error", err);
                                resolve();
                            } else {
                                const newAccessory = new tccAccessory(that.log, device.name,
                                    deviceData, that.username, that.password, device.deviceID, that.debug);
                                // store accessory in myAccessories
                                myAccessories.push(newAccessory);
                                resolve();
                            }
                        });
                });
            })

            // Need to wait for all devices to be configured

            Promise.all(requests).then(() => {
                callback(myAccessories);
                that.periodicUpdate();
                setInterval(that.periodicUpdate.bind(this), this.refresh * 1000);
            });

            // End of login section
        }.bind(this)).fail(function(err) {
            // tell me if login did not work!
            that.log.error("Error during Login:", err);
            callback(err);
        });
    }
};

tccPlatform.prototype.periodicUpdate = function() {
    if (this.debug) {
        this.log.debug("periodicUpdate");
    }
    checkAndHandleFanStatus(this);
}

function checkAndHandleFanStatus(that) {
    if (that.debug) {
        that.log.debug("checkAndHandleFanStatus on ", myAccessories.length, ' devices');
    }
    myAccessories.forEach(function(accessory) {
        session.CheckDataSession(accessory.deviceID, function(err, deviceData) {
            if (err) {
                that.log.error("ERROR: checkAndHandleFanStatus, Device not reachable:", accessory.name, err);
                accessory.newAccessory.updateReachability(false);
                tcc.login(that.username, that.password).then(function(login) {
                    that.log.info("Logged into tcc!");
                    session = login;
                }.bind(this)).fail(function(err) {
                    // tell me if login did not work!
                    that.log.error("Error during Login:", err);
                });
            } else {
                if (that.debug) {
                    that.log.debug("checkAndHandleFanStatus on ", accessory.name, deviceData);
                }

                if (deviceData.deviceLive) {
                    accessory.newAccessory.updateReachability(true);
                } else {
                    that.log.error("checkAndHandleFanStatus: Device not reachable", accessory.name);
                    accessory.newAccessory.updateReachability(false);
                }

                if (deviceData.latestData.fanData.fanIsRunning !== accessory.device.latestData.fanData.fanIsRunning) {
                    that.log.info("Fan Status Changed:", accessory.name, 'from', accessory.device.latestData.fanData.fanIsRunning, 'to', deviceData.latestData.fanData.fanIsRunning);
                    accessory.device = deviceData;
                    accessory.fanService.getCharacteristic(Characteristic.On).updateValue(Boolean(deviceData.latestData.fanData.fanIsRunning));
                }
            }
        });
    });
}

// give this function all the parameters needed

function tccAccessory(log, name, deviceData, username, password, deviceID, debug) {

    const uuid = UUIDGen.generate(name);

    this.newAccessory = new Accessory(name, uuid);

    this.log = log;
    this.log("Adding TCC Device", name, deviceID);
    this.name = name;
    this.device = deviceData;
    this.username = username;
    this.password = password;
    this.deviceID = deviceID;
    this.debug = debug;
}

tccAccessory.prototype = {
    getName: function(callback) {
        callback(this.name);
    },

    setState: function(value, callback) {
        this.log.info('Change Fan Status is not supported.');
        callback(null);
        this.fanService.getCharacteristic(Characteristic.On).updateValue(this.device.latestData.fanData.fanIsRunning);
    },

    getState: function(callback) {
        if (this.debug) {
            this.log.info("Current Fan Status is ", this.device.latestData.fanData.fanIsRunning ? "On" : "Off");
        }

        callback(null, this.device.latestData.fanData.fanIsRunning);
    },

    getServices: function() {
        // Information Service
        const informationService = new Service.AccessoryInformation();

        informationService
            .setCharacteristic(Characteristic.Identify, this.name)
            .setCharacteristic(Characteristic.Manufacturer, "Honeywell")
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.SerialNumber, this.deviceID); // need to stringify the this.serial

        // Fan Service
        this.fanService = new Service.Fan(this.name);

        // this.addOptionalCharacteristic(Characteristic.Name);
        this.fanService
            .getCharacteristic(Characteristic.Name)
            .on('get', this.getName.bind(this));

        // this.addOptionalCharacteristic(Characteristic.On);
        if (this.device.latestData.hasFan && this.device.latestData.fanData && this.device.latestData.fanData.fanModeOnAllowed) {
            this.fanService
                .getCharacteristic(Characteristic.On)
                .on('get', this.getState.bind(this))
                .on('set', this.setState.bind(this));
        }

        return [informationService, this.fanService];

    }
}
