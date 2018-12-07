/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';


// you have to require the utils module and call adapter function
const utils = require(__dirname + '/lib/utils'); // Get common adapter utils
const adapter = new utils.Adapter('mihome-vacuum');
const dgram = require('dgram');
const MiHome = require(__dirname + '/lib/mihomepacket');
const com = require(__dirname + '/lib/comands');

const server = dgram.createSocket('udp4');

let device = {};
let isConnect = false;
let model = '';
let fw = '';
let fwNew = false;
let connected = false;
let commands = {};
let stateVal = 0;
let pingInterval;
let paramPingInterval;
let packet;
let firstSet = true;
let cleanLog = [];
let cleanLogHtmlAllLines = '';
let clean_log_html_table = '';
let logEntries = {};
let logEntriesNew = {};
let zoneCleanActive = false;

const last_id = {
    get_status: 0,
    get_consumable: 0,
    get_clean_summary: 0,
    get_clean_record: 0,
    X_send_command: 0,
};

const reqParams = [
    com.get_status.method,
    com.miIO_info.method,
    com.get_consumable.method,
    com.clean_summary.method,
    com.get_sound_volume.method,
    com.get_carpet_mode.method
];

//Tabelleneigenschaften
// TODO: Translate
const clean_log_html_attr = '<colgroup> <col width="50"> <col width="50"> <col width="80"> <col width="100"> <col width="50"> <col width="50"> </colgroup>';
const clean_log_html_head = '<tr> <th>Datum</th> <th>Start</th> <th>Saugzeit</th> <th>Fläche</th> <th>???</th> <th>Ende</th></tr>';

// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    if (!state || state.ack) return;

    // Warning, state can be null if it was deleted
    adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

    // output to parser


    const command = id.split('.').pop();

    if (com[command]) {
        let params = com[command].params || '';
        if (state.val !== true && state.val !== 'true') {
            params = state.val;
        }
        if (state.val !== false && state.val !== 'false') {
            if (command === 'start' && zoneCleanActive && adapter.config.enableResumeZone) {
                adapter.log.debug('Resuming paused zoneclean.');
                sendMsg('resume_zoned_clean');
            } else {
                sendMsg(com[command].method, [params], function () {
                    adapter.setForeignState(id, state.val, true);
                });
            }
        }

    } else {
        // Send own commands
        if (command === 'X_send_command') {
            const values = (state.val || '').trim().split(';');
            //const method = values[0];
            let params = {};
            last_id.X_send_command = packet.msgCounter;
            if (values[1]) {
                try {
                    params = JSON.parse(values[1]);
                } catch (e) {
                    adapter.log.warn('Could not send these params because its not in JSON format: ' + values[1]);
                } finally {

                }
                adapter.log.info('send message: Method: ' + values[0] + ' Params: ' + values[1]);
                sendMsg(values[0], params, function () {
                    adapter.setForeignState(id, state.val, true);
                });
            } else {
                adapter.log.info('send message: Method: ' + values[0]);
                sendMsg(values[0], [''], function () {
                    adapter.setForeignState(id, state.val, true);
                });

            }

        } else if (command === 'clean_home') {
            stateControl(state.val);

        } else if (command === 'carpet_mode') {
            //when carpetmode change
            if (state.val === true || state.val === 'true') {
                sendMsg('set_carpet_mode', [{enable: 1}], function () {
                    adapter.setForeignState(id, state.val, true);
                });
            }
            else {
                sendMsg('set_carpet_mode', [{enable: 0}], function () {
                    adapter.setForeignState(id, false, true);
                });
            }

        } else if (command === 'goTo') {
            //changeMowerCfg(id, state.val);
            //goto function wit error catch
            parseGoTo(state.val, function() {
                adapter.setForeignState(id, state.val, true);
            });

        } else if (command === 'zoneClean') {
            sendMsg('app_zoned_clean', [state.val], function () {
                adapter.setForeignState(id, state.val, true);
            });
            zoneCleanActive = true;

        } else if (command === 'resumeZoneClean') {
            sendMsg('resume_zoned_clean');

        } else if (com[command] === undefined) {
            adapter.log.error('Unknown state "' + id + '"');
        } else {
            adapter.log.error('Command "' + command + '" is not configured');
        }
    }

});

adapter.on('unload', function (callback) {
    if (pingTimeout) clearTimeout(pingTimeout);
    adapter.setState('info.connection', false, true);
    if (pingInterval) clearInterval(pingInterval);
    if (paramPingInterval) clearInterval(paramPingInterval);
    if (typeof callback === 'function') callback();
});


adapter.on('ready', main);

let pingTimeout = null;

function sendPing() {
    pingTimeout = setTimeout(() => {
        pingTimeout = null;
        if (connected) {
            connected = false;
            adapter.log.debug('Disconnect');
            adapter.setState('info.connection', false, true);
        }
    }, 3000);

    try {
        server.send(commands.ping, 0, commands.ping.length, adapter.config.port, adapter.config.ip, function (err) {
            if (err) adapter.log.error('Cannot send ping: ' + err)
        });

    } catch (e) {
        adapter.log.warn('Cannot send ping: ' + e);
        clearTimeout(pingTimeout);
        pingTimeout = null;
        if (connected) {
            connected = false;
            adapter.log.debug('Disconnect');
            adapter.setState('info.connection', false, true);
        }
    }
}

function stateControl(value) {
    if (value && stateVal !== 5 && stateVal !== 17) {
        sendMsg(com.start.method);
        setTimeout(() => sendMsg(com.get_status.method), 2000);
    } else if (!value && (stateVal === 5 || stateVal === 17)) {
        sendMsg(com.pause.method);
        setTimeout(() => sendMsg(com.home.method), 1000);
        zoneCleanActive = false;
    }
}

// function to control goto params
function parseGoTo(params, callback) {
    const coordinates = params.split(',');
    if (coordinates.length === 2) {
        const xVal = coordinates[0];
        const yVal = coordinates[1];

        if (!isNaN(yVal) && !isNaN(xVal)) {
            //send goTo request with koordinates
            sendMsg('app_goto_target', [parseInt(xVal), parseInt(yVal)]);
            callback();
        }
        else adapter.log.error('GoTo need two koordinates with type number');
        adapter.log.info('xVAL: ' + xVal + '  yVal:  ' + yVal);

    } else {
        adapter.log.error('GoTo only work with two arguments seperated by ','');
    }
}

function send(reqParams, cb, i) {
    i = i || 0;
    if (!reqParams || i >= reqParams.length) {
        return cb && cb();
    }

    sendMsg(reqParams[i], null, () => {
        setTimeout(send, 200, reqParams, cb, i + 1);
    });
}

function requestParams() {
    if (connected) {
        adapter.log.debug('requesting params every: ' + adapter.config.paramPingInterval / 1000 + ' Sec');

        send(reqParams, () => {
            if (!isEquivalent(logEntriesNew, logEntries)) {
                logEntries = logEntriesNew;
                cleanLog = [];
                cleanLogHtmlAllLines = '';
                getLog(() => {
                    adapter.setState('history.allTableJSON', JSON.stringify(cleanLog), true);
                    adapter.log.debug('CLEAN_LOGGING' + JSON.stringify(cleanLog));
                    adapter.setState('history.allTableHTML', clean_log_html_table, true);
                });
            }
        });
    }
}

function sendMsg(method, params, options, callback) {
    // define optional options
    if (typeof options === 'function') {
        callback = options;
        options = null;
    }

    // define default options
    options = options || {};
    if (options.rememberPacket === undefined) {
        options.rememberPacket = true;
    } // remember packets per default

    // remember packet if not explicitly forbidden
    // this is used to route the returned package to the sendTo callback
    if (options.rememberPacket) {
        last_id[method] = packet.msgCounter;
        adapter.log.debug('lastid' + JSON.stringify(last_id));
    }

    const message_str = buildMsg(method, params);

    try {
        const cmdraw = packet.getRaw_fast(message_str);

        server.send(cmdraw, 0, cmdraw.length, adapter.config.port, adapter.config.ip, err => {
            if (err) adapter.log.error('Cannot send command: ' + err);
            if (typeof callback === 'function') callback(err);
        });
        adapter.log.debug('sendMsg >>> ' + message_str);
        adapter.log.debug('sendMsgRaw >>> ' + cmdraw.toString('hex'));
    } catch (err) {
        adapter.log.warn('Cannot send message_: ' + err);
        if (typeof callback === 'function') callback(err);
    }
    packet.msgCounter++;
}


function buildMsg(method, params) {
    const message = {};
    if (method) {
        message.id = packet.msgCounter;
        message.method = method;
        if (!(params === '' || params === undefined || params === null || (params instanceof Array && params.length === 1 && params[0] === ''))) {
            message.params = params;
        }
    } else {
        adapter.log.warn('Could not build message without arguments');
    }
    return JSON.stringify(message).replace('["[', '[[').replace(']"]', ']]');
}


function str2hex(str) {
    str = str.replace(/\s/g, '');
    const buf = new Buffer(str.length / 2);

    for (let i = 0; i < str.length / 2; i++) {
        buf[i] = parseInt(str[i * 2] + str[i * 2 + 1], 16);
    }
    return buf;
}

/** Parses the answer to a get_clean_summary message */
function parseCleaningSummary(response) {
    response = response.result;
    return {
        clean_time: response[0], // in seconds
        total_area: response[1], // in cm^2
        num_cleanups: response[2],
        cleaning_record_ids: response[3], // number[]
    };
}

/** Parses the answer to a get_clean_record message */
function parseCleaningRecords(response) {
    return response.result.map(entry => {
        return {
            start_time: entry[0], // unix timestamp
            end_time:   entry[1], // unix timestamp
            duration:   entry[2], // in seconds
            area:       entry[3], // in cm^2
            errors:     entry[4], // ?
            completed:  entry[5] === 1, // boolean
        };
    });
}

const statusTexts = {
    '0': 'Unknown',
    '1': 'Initiating',
    '2': 'Sleeping',
    '3': 'Waiting',
    '4': '?',
    '5': 'Cleaning',
    '6': 'Back to home',
    '7': '?',
    '8': 'Charging',
    '9': 'Charging Error',
    '10': 'Pause',
    '11': 'Spot Cleaning',
    '12': 'In Error',
    '13': 'Shutting down',
    '14': 'Updating',
    '15': 'Docking',
    '100': 'Full'
};
// TODO: deduplicate from io-package.json
const errorTexts = {
    '0': 'No error',
    '1': 'Laser distance sensor error',
    '2': 'Collision sensor error',
    '3': 'Wheels on top of void, move robot',
    '4': 'Clean hovering sensors, move robot',
    '5': 'Clean main brush',
    '6': 'Clean side brush',
    '7': 'Main wheel stuck?',
    '8': 'Device stuck, clean area',
    '9': 'Dust collector missing',
    '10': 'Clean filter',
    '11': 'Stuck in magnetic barrier',
    '12': 'Low battery',
    '13': 'Charging fault',
    '14': 'Battery fault',
    '15': 'Wall sensors dirty, wipe them',
    '16': 'Place me on flat surface',
    '17': 'Side brushes problem, reboot me',
    '18': 'Suction fan problem',
    '19': 'Unpowered charging station',
};

/** Parses the answer to a get_status message */
function parseStatus(response) {
    response = response.result[0];
    return {
        battery:        response.battery,
        clean_area:     response.clean_area,
        clean_time:     response.clean_time,
        dnd_enabled:    response.dnd_enabled === 1,
        error_code:     response.error_code,
        error_text:     errorTexts[response.error_code],
        fan_power:      response.fan_power,
        in_cleaning:    response.in_cleaning === 1,
        map_present:    response.map_present === 1,
        msg_seq:        response.msg_seq,
        msg_ver:        response.msg_ver,
        state:          response.state,
        state_text:     statusTexts[response.state],
    };
}

/** Parses the answer to a get_dnd_timer message */
/* function parseDNDTimer(response) {
    response = response.result[0];
    response.enabled = (response.enabled === 1);
    return response;
}*/

function getStates(message) {
    //Search id in answer
    clearTimeout(pingTimeout);
    pingTimeout = null;
    if (!connected) {
        connected = true;
        adapter.log.debug('Connected');
        adapter.setState('info.connection', true, true);
    }

    try {
        const answer = JSON.parse(message);
        answer.id = parseInt(answer.id, 10);
        //const ans= answer.result;
        //adapter.log.info(answer.result.length);
        //adapter.log.info(answer['id']);

        if (answer.id === last_id.get_status) {
            const status = parseStatus(answer);
            adapter.setState('info.battery', status.battery, true);
            adapter.setState('info.cleanedtime', Math.round(status.clean_time / 60), true);
            adapter.setState('info.cleanedarea', Math.round(status.clean_area / 10000) / 100, true);
            adapter.setState('control.fan_power', Math.round(status.fan_power), true);
            adapter.setState('info.state', status.state, true);
            stateVal = status.state;
            if (stateVal === 5 || stateVal === 17) {
                if (stateVal === 17) zoneCleanActive = true;
                adapter.setState('control.clean_home', true, true);
            } else {
                adapter.setState('control.clean_home', false, true);
            }
            if ([2,3,5,6,8,11,16].indexOf(stateVal) > -1) {
                 zoneCleanActive = false;
            }
            adapter.setState('info.error', status.error_code, true);
            adapter.setState('info.dnd', status.dnd_enabled, true)
        } else if (answer.id === last_id['miIO.info']) {

            //adapter.log.info('device' + JSON.stringify(answer.result));
            device = answer.result;
            adapter.setState('info.device_fw', answer.result.fw_ver, true);
            fw = answer.result.fw_ver.split('_');   // Splitting the FW into [Version, Build] array.
            if (parseInt(fw[0].replace(/\./g, ''), 10) > 339 || (parseInt(fw[0].replace(/\./g, ''), 10) === 339 && parseInt(fw[1], 10) >= 3194)) {
                fwNew = true;
            }
            adapter.setState('info.device_model', answer.result.model, true);
            adapter.setState('info.wifi_signal', answer.result.ap.rssi, true);
            if (model === '') {
                model = newGen(answer.result.model);
            } // create new States for the V2

        } else if (answer.id === last_id.get_sound_volume) {
            adapter.setState('control.sound_volume', answer.result[0], true);

        } else if (answer.id === last_id.get_carpet_mode && model === 'roborock.vacuum.s5') {
            adapter.setState('control.carpet_mode', answer.result[0].enable === 1, true);

        } else if (answer.id === last_id.get_consumable) {

            adapter.setState('consumable.main_brush', 100 - (Math.round(answer.result[0].main_brush_work_time / 3600 / 3)), true);
            adapter.setState('consumable.side_brush', 100 - (Math.round(answer.result[0].side_brush_work_time / 3600 / 2)), true);
            adapter.setState('consumable.filter', 100 - (Math.round(answer.result[0].filter_work_time / 3600 / 1.5)), true);
            adapter.setState('consumable.sensors', 100 - (Math.round(answer.result[0].sensor_dirty_time / 3600 / 0.3)), true);
        } else if (answer.id === last_id.get_clean_summary) {
            const summary = parseCleaningSummary(answer);
            adapter.setState('history.total_time', Math.round(summary.clean_time / 60), true);
            adapter.setState('history.total_area', Math.round(summary.total_area / 1000000), true);
            adapter.setState('history.total_cleanups', summary.num_cleanups, true);
            logEntriesNew = summary.cleaning_record_ids;
            //adapter.log.info('log_entrya' + JSON.stringify(logEntriesNew));
            //adapter.log.info('log_entry old' + JSON.stringify(logEntries));


        } else if (answer.id === last_id.X_send_command) {
            adapter.setState('control.X_get_response', JSON.stringify(answer.result), true);

        } else if (answer.id === last_id.get_clean_record) {
            const records = parseCleaningRecords(answer);
            for (let j = 0; j < records.length; j++) {
                const record = records[j];

                const dates = new Date();
                let hour = '';
                let min = '';
                dates.setTime(record.start_time * 1000);
                if (dates.getHours() < 10) {
                    hour = '0' + dates.getHours();
                } else {
                    hour = dates.getHours();
                }
                if (dates.getMinutes() < 10) {
                    min = '0' + dates.getMinutes();
                } else {
                    min = dates.getMinutes();
                }

                const log_data = {
                    Datum: dates.getDate() + '.' + (dates.getMonth() + 1),
                    Start: hour + ':' + min,
                    Saugzeit: Math.round(record.duration / 60) + ' min',
                    'Fläche': Math.round(record.area / 10000) / 100 + ' m²',
                    Error: record.errors,
                    Ende: record.completed
                };


                cleanLog.push(log_data);
                clean_log_html_table = makeTable(log_data);


            }

        } else if (answer.id in sendCommandCallbacks) {

            // invoke the callback from the sendTo handler
            const callback = sendCommandCallbacks[answer.id];
            if (typeof callback === 'function') callback(answer);
        }
    }
    catch (err) {
        adapter.log.debug('The answer from the robot is not correct! (' + err + ')');
    }
}


function getLog(callback, i) {
    i = i || 0;

    if (!logEntries || i >= logEntries.length) {
        callback && callback();
    } else {
        if (logEntries[i] !== null || logEntries[i] !== 'null') {
            adapter.log.debug('Request log entry: ' + logEntries[i]);
            sendMsg('get_clean_record', [logEntries[i]], () => {
                setTimeout(getLog, 200, callback, i + 1);
            });
        } else {
            adapter.log.error('Could not find log entry');
            setImmediate(getLog, callback, i + 1);
        }
    }
}


function isEquivalent(a, b) {
    // Create arrays of property names
    const aProps = Object.getOwnPropertyNames(a);
    const bProps = Object.getOwnPropertyNames(b);

    // If number of properties is different,
    // objects are not equivalent
    if (aProps.length !== bProps.length) {
        return false;
    }

    for (let i = 0; i < aProps.length; i++) {
        const propName = aProps[i];

        // If values of same property are not equal,
        // objects are not equivalent
        if (a[propName] !== b[propName]) {
            return false;
        }
    }

    // If we made it this far, objects
    // are considered equivalent
    return true;
}


function makeTable(line) {
    // const head = clean_log_html_head;
    let html_line = '<tr>';

    html_line += '<td>' + line.Datum + '</td>' + '<td>' + line.Start + '</td>' + '<td ALIGN="RIGHT">' + line.Saugzeit + '</td>' + '<td ALIGN="RIGHT">' + line['Fläche'] + '</td>' + '<td ALIGN="CENTER">' + line.Error + '</td>' + '<td ALIGN="CENTER">' + line.Ende + '</td>';

    html_line += '</tr>';

    cleanLogHtmlAllLines += html_line;

    return '<table>' + clean_log_html_attr + clean_log_html_head + cleanLogHtmlAllLines + '</table>';

}

function enabledExpert() {
    if (adapter.config.enableSelfCommands) {
        adapter.log.info('Expert mode enabled, states created');
        adapter.setObjectNotExists('control.X_send_command', {
            type: 'state',
            common: {
                name: 'send command',
                type: 'string',
                read: true,
                write: true,
            },
            native: {}
        });
        adapter.setObjectNotExists('control.X_get_response', {
            type: 'state',
            common: {
                name: 'get response',
                type: 'string',
                read: true,
                write: false,
            },
            native: {}
        });


    } else {
        adapter.log.info('Expert mode disabled, states deleded');
        adapter.delObject('control.X_send_command');
        adapter.delObject('control.X_get_response');

    }

}

function enabledVoiceControl() {
    if (adapter.config.enableAlexa) {
        adapter.log.info('Create state clean_home for controlling by cloud adapter');

        adapter.setObjectNotExists('control.clean_home', {
            type: 'state',
            common: {
                name: 'Start/Home',
                type: 'boolean',
                role: 'state',
                read: true,
                write: true,
                desc: 'Start and go home',
                smartName: 'Staubsauger'
            },
            native: {}
        });

    } else {
        adapter.log.info('Cloud control disabled');
        adapter.delObject('control.clean_home');

    }

}

//create default states
function init() {
    adapter.setObjectNotExists('control.spotclean', {
        type: 'state',
        common: {
            name: 'Spot Cleaning',
            type: 'boolean',
            role: 'button',
            read: true,
            write: true,
            desc: 'Start Spot Cleaning',
            smartName: 'Spot clean'
        },
        native: {}
    });
    adapter.setObjectNotExists('control.sound_volume_test', {
        type: 'state',
        common: {
            name: 'sound volume test',
            type: 'boolean',
            role: 'button',
            read: true,
            write: true,
            desc: 'let the speaker play sound'
        },
        native: {}
    });
    adapter.setObjectNotExists('control.sound_volume', {
        type: 'state',
        common: {
            name: 'sound volume',
            type: 'number',
            role: 'level',
            read: true,
            write: true,
            unit: '%',
            min: 30,
            max: 100,
            desc: 'Sound volume of the Robot'
        },
        native: {}
    });

    adapter.setObjectNotExists('info.wifi_signal', {
        type: 'state',
        common: {
            name: 'Wifi RSSI',
            type: 'number',
            role: 'level',
            read: true,
            write: false,
            unit: 'dBm',
            desc: 'Wifi signal of the  vacuum'
        },
        native: {}
    });

    adapter.setObjectNotExists('info.device_model', {
        type: 'state',
        common: {
            name: 'device model',
            type: 'string',
            read: true,
            write: false,
            desc: 'model of vacuum',
        },
        native: {}
    });
    adapter.setObjectNotExists('info.device_fw', {
        type: 'state',
        common: {
            name: 'Firmware',
            type: 'string',
            read: true,
            write: false,
            desc: 'Firmware of vacuum',
        },
        native: {}
    });

    // States for Rockrobo S5 (second Generation)


}


function newGen(model) {
    if (model === 'roborock.vacuum.s5' || fwNew) {
        adapter.log.info('New generation or new fw detected, create new states');
        adapter.setObjectNotExists('control.goTo', {
            type: 'state',
            common: {
                name: 'Go to point',
                type: 'string',
                read: true,
                write: true,
                desc: 'let the vacuum go to a point on the map',
            },
            native: {}
        });
        adapter.setObjectNotExists('control.zoneClean', {
            type: 'state',
            common: {
                name: 'Clean a zone',
                type: 'string',
                read: true,
                write: true,
                desc: 'let the vacuum go to a point and clean a zone',
            },
            native: {}
        });
        if (!adapter.config.enableResumeZone) {
            adapter.setObjectNotExists('control.resumeZoneClean', {
                type: 'state',
                common: {
                    name: "Resume paused zoneClean",
                    type: "boolean",
                    role: "button",
                    read: true,
                    write: true,
                    desc: "resume zoneClean that has been paused before",
                },
                native: {}
            });
        } else {
            adapter.deleteState(adapter.namespace, 'control', 'resumeZoneClean');
        }
    }
    if (model === 'roborock.vacuum.s5') {
        adapter.setObjectNotExists('control.carpet_mode', {
            type: 'state',
            common: {
                name: 'Carpet mode',
                type: 'boolean',
                read: true,
                write: true,
                desc: 'Fanspeed is Max on carpets',
            },
            native: {}
        });
        adapter.extendObject('control.fan_power', {
            common: {
                max: 105,
                states: {
                  105: "MOP"
                }
            }
        });
    }
    else if (!model === 'roborock.vacuum.s5' && !fwNew) {
        adapter.deleteState(adapter.namespace, 'control', 'goTo');
        adapter.deleteState(adapter.namespace, 'control', 'zoneClean');
        adapter.deleteState(adapter.namespace, 'control', 'carpet_mode');
        adapter.deleteState(adapter.namespace, 'control', 'resumeZoneClean');
    }
    return model;
}

function checkSetTimeDiff() {
    const now = Math.round(parseInt((new Date().getTime())) / 1000);//.toString(16)
    const messageTime = parseInt(packet.stamprec.toString('hex'), 16);
    packet.timediff = (messageTime - now) === -1 ? 0 : (messageTime - now); // may be (messageTime < now) ? 0...

    if (firstSet && packet.timediff !== 0) {
        adapter.log.warn('Time difference between Mihome Vacuum and ioBroker: ' + packet.timediff + ' sec');
    }

    if (firstSet) {
        firstSet = false;
    }
}

function main() {
    adapter.setState('info.connection', false, true);
    adapter.config.port = parseInt(adapter.config.port, 10) || 54321;
    adapter.config.ownPort = parseInt(adapter.config.ownPort, 10) || 53421;
    adapter.config.pingInterval = parseInt(adapter.config.pingInterval, 10) || 20000;
    adapter.config.paramPingInterval = parseInt(adapter.config.paramPingInterval, 10) || 10000;

    init();

    // Abfrageintervall mindestens 10 sec.
    if (adapter.config.paramPingInterval < 10000) {
        adapter.config.paramPingInterval = 10000;
    }


    if (!adapter.config.token) {
        adapter.log.error('Token not specified!');
        //return;
    } else {
        enabledExpert();
        enabledVoiceControl();

        packet = new MiHome.Packet(str2hex(adapter.config.token), adapter);

        packet.msgCounter = 1;

        commands = {
            ping: str2hex('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
        };

        server.on('error', function (err) {
            adapter.log.error('UDP error: ' + err);
            server.close();
            process.exit();
        });


        server.on('message', function (msg, rinfo) {
            if (rinfo.port === adapter.config.port) {
                if (msg.length === 32) {
                    adapter.log.debug('Receive <<< Helo <<< ' + msg.toString('hex'));
                    packet.setRaw(msg);
                    isConnect = true;
                    checkSetTimeDiff();

                    clearTimeout(pingTimeout);
                    pingTimeout = null;
                    if (!connected) {
                        connected = true;
                        adapter.log.debug('Connected');
                        adapter.setState('info.connection', true, true);
                        requestParams();
                    }

                } else {

                    //hier die Antwort zum decodieren
                    packet.setRaw(msg);
                    adapter.log.debug('Receive <<< ' + packet.getPlainData() + '<<< ' + msg.toString('hex'));
                    getStates(packet.getPlainData());
                }
            }
        });

        server.on('listening', function () {
            const address = server.address();
            adapter.log.debug('server started on ' + address.address + ':' + address.port);
        });

        try {
            server.bind(adapter.config.ownPort);
        } catch (e) {
            adapter.log.error('Cannot open UDP port: ' + e);
            return;
        }

        sendPing();
        pingInterval = setInterval(sendPing, adapter.config.pingInterval);
        paramPingInterval = setInterval(requestParams, adapter.config.paramPingInterval);

        adapter.subscribeStates('*');


    }

}

const sendCommandCallbacks = {/* "counter": callback() */};

/** Returns the only array element in a response */
function returnSingleResult(resp) {
    return resp.result[0];
}

adapter.on('message', function (obj) {
    // responds to the adapter that sent the original message
    function respond(response) {
        if (obj.callback) adapter.sendTo(obj.from, obj.command, response, obj.callback);
    }

    // some predefined responses so we only have to define them once
    const predefinedResponses = {
        ACK: {error: null},
        OK: {error: null, result: 'ok'},
        ERROR_UNKNOWN_COMMAND: {error: 'Unknown command!'},
        MISSING_PARAMETER: paramName => {
            return {error: 'missing parameter "' + paramName + '"!'};
        }
    };

    // make required parameters easier
    function requireParams(params /*: string[] */) {
        if (!(params && params.length)) return true;
        for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (!(obj.message && obj.message.hasOwnProperty(param))) {
                respond(predefinedResponses.MISSING_PARAMETER(param));
                return false;
            }
        }
        return true;
    }

    // use jsdoc here
    function sendCustomCommand(
        method /*: string */,
        params /*: (optional) string[] */,
        parser /*: (optional) (object) => object */
    ) {
        // parse arguments
        if (typeof params === 'function') {
            parser = params;
            params = null;
        }
        if (parser && typeof parser !== 'function') {
            throw new Error('Parser must be a function');
        }
        // remember message id
        const id = packet.msgCounter;
        // create callback to be called later
        sendCommandCallbacks[id] = function (response) {
            if (parser) {
                // optionally transform the result
                response = parser(response);
            } else {
                // in any case, only return the result
                response = response.result;
            }
            // now respond with the result
            respond({error: null, result: response});
            // remove the callback from the dict
            if (sendCommandCallbacks[id] !== null) {
                delete sendCommandCallbacks[id];
            }
        };
        // send msg to the robo
        sendMsg(method, params, {rememberPacket: false}, err => {
            // on error, respond immediately
            if (err) respond({error: err});
            // else wait for the callback
        });
    }

    // handle the message
    if (obj) {
        let params;

        switch (obj.command) {
            // call this with 
            // sendTo('mihome-vacuum.0', 'sendCustomCommand',
            //     {method: 'method_id', params: [...] /* optional*/},
            //     callback
            // );
            case 'sendCustomCommand':
                // require the method to be given
                if (!requireParams(['method'])) return;
                // params is optional

                params = obj.message;
                sendCustomCommand(params.method, params.params);
                return;

            // ======================================================================
            // support for the commands mentioned here:
            // https://github.com/MeisterTR/XiaomiRobotVacuumProtocol#vaccum-commands

            // cleaning commands
            case 'startVacuuming':
                sendCustomCommand('app_start');
                return;
            case 'stopVacuuming':
                sendCustomCommand('app_stop');
                return;
            case 'cleanSpot':
                sendCustomCommand('app_spot');
                return;
            case 'pause':
                sendCustomCommand('app_pause');
                return;
            case 'charge':
                sendCustomCommand('app_charge');
                return;

            // TODO: What does this do?
            case 'findMe':
                sendCustomCommand('find_me');
                return;

            // get info about the consumables
            // TODO: parse the results
            case 'getConsumableStatus':
                sendCustomCommand('get_consumable', returnSingleResult);
                return;
            case 'resetConsumables':
                sendCustomCommand('reset_consumable');
                return;

            // get info about cleanups
            case 'getCleaningSummary':
                sendCustomCommand('get_clean_summary', parseCleaningSummary);
                return;
            case 'getCleaningRecord':
                // require the record id to be given
                if (!requireParams(['recordId'])) return;
                // TODO: can we do multiple at once?
                sendCustomCommand('get_clean_record', [obj.message.recordId], parseCleaningRecords);
                return;

            // TODO: find out how this works
            // case 'getCleaningRecordMap':
            //     sendCustomCommand('get_clean_record_map');
            case 'getMap':
                sendCustomCommand('get_map_v1');
                return;

            // Basic information
            case 'getStatus':
                sendCustomCommand('get_status', parseStatus);
                return;
            case 'getSerialNumber':
                sendCustomCommand('get_serial_number', function (resp) {
                    return resp.result[0].serial_number;
                });
                return;
            case 'getDeviceDetails':
                sendCustomCommand('miIO.info');
                return;

            // Do not disturb
            case 'getDNDTimer':
                sendCustomCommand('get_dnd_timer', returnSingleResult);
                return;
            case 'setDNDTimer':
                // require start and end time to be given
                if (!requireParams(['startHour', 'startMinute', 'endHour', 'endMinute'])) return;
                params = obj.message;
                sendCustomCommand('set_dnd_timer', [params.startHour, params.startMinute, params.endHour, params.endMinute]);
                return;
            case 'deleteDNDTimer':
                sendCustomCommand('close_dnd_timer');
                return;

            // Fan speed
            case 'getFanSpeed':
                // require start and end time to be given
                sendCustomCommand('get_custom_mode', returnSingleResult);
                return;
            case 'setFanSpeed':
                // require start and end time to be given
                if (!requireParams(['fanSpeed'])) return;
                sendCustomCommand('set_custom_mode', [obj.message.fanSpeed]);
                return;

            // Remote controls
            case 'startRemoteControl':
                sendCustomCommand('app_rc_start');
                return;
            case 'stopRemoteControl':
                sendCustomCommand('app_rc_end');
                return;
            case 'move':
                // require all params to be given
                if (!requireParams(['velocity', 'angularVelocity', 'duration', 'sequenceNumber'])) return;
                // TODO: Constrain the params
                params = obj.message;
                // TODO: can we issue multiple commands at once?
                const args = [{
                    omega: params.angularVelocity,
                    velocity: params.velocity,
                    seqnum: params.sequenceNumber, // <- TODO: make this automatic
                    duration: params.duration
                }];
                sendCustomCommand('app_rc_move', [args]);
                return;


            // ======================================================================

            default:
                respond(predefinedResponses.ERROR_UNKNOWN_COMMAND);
                return;
        }
    }
});
