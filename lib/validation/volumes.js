/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var volumes = require('../volumes');

var VALID_VOLUME_NAME_REGEXP = /^[a-zA-Z0-9][a-zA-Z0-9_\.\-]+$/;

function validateVolumeName(name) {
    var validName = typeof (name) === 'string' &&
        name !== '' &&
        name.match(VALID_VOLUME_NAME_REGEXP);
     var err;

     if (!validName) {
         err = new Error(name + ' is not a valid volume name');
     }

     return err;
}

function validateVolumeType(type) {
    var err;

    if (type !== 'tritonnfs') {
        err = new Error('Volume type: ' + type + ' is not supported');
    }

    return err;
}

function validateVolumeSize(size) {
    var err;

    try {
        volumes.parseVolumeSize(size);
    } catch (parseErr) {
        err = parseErr;
    }

    return err;
}

function validateVolumeState(state) {
    console.log('state: ', state);

    var VALID_STATES = [
        'creating', 'ready', 'deleted', 'failed', 'rolling_back'
    ];
    var err;

    if (VALID_STATES.indexOf(state) === -1) {
        err = new Error('Volume state: ' + state + ' is invalid');
    }

    return err;
}

module.exports = {
    validateVolumeName: validateVolumeName,
    validateVolumeType: validateVolumeType,
    validateVolumeSize: validateVolumeSize,
    validateVolumeState: validateVolumeState
};