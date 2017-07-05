/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var volumes = require('../volumes');

var VALID_VOLUME_NAME_CHARS_REGEXP = /^[a-zA-Z0-9_\.\-]+$/;
var VALID_VOLUME_NAME_REGEXP = /^[a-zA-Z0-9][a-zA-Z0-9_\.\-]+$/;
var VALID_VOLUME_SIZE_REGEXP = /^[1-9][0-9]*$/;
var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function validUuid(uuid) {
    return typeof (uuid) === 'string' && uuid !== '' && uuid.match(UUID_RE);
}

function validateOwnerUuid(ownerUuid) {
     var err;
     var validOwnerUuid = validUuid(ownerUuid);

     if (!validOwnerUuid) {
         err = new Error(ownerUuid + ' is not a valid volume owner UUID');
     }

     return err;
}

function validateVolumeNetwork(volumeNetworkUuid) {
    var err;
    var validNetworkUuid = validUuid(volumeNetworkUuid);

     if (!validNetworkUuid) {
         err = new Error(volumeNetworkUuid + ' is not a valid volume ' +
            'network UUID');
     }

     return err;
}

function validateVolumeName(name, opts) {
     var validName;
     var err;

     // Some actions allow non-existent names (empty or undefined), if
     // opts.allowEmpty is truthy, we'll accept a missing name or empty string
     // as valid.
     if (opts && opts.allowEmpty && ((name === undefined) ||
             (typeof (name) === 'string' && name === ''))) {
         validName = true;
     } else {
        validName = typeof (name) === 'string' &&
        name !== '' &&
        name.match(VALID_VOLUME_NAME_REGEXP);
     }

     if (!validName) {
         err = new Error(name + ' is not a valid volume name');
     }

     return err;
}

function validateVolumeNameSearchParam(name) {
    var coreName;
    var err;
    var nameBegin;
    var nameLen;

    // 'name' is special because we allow '*' as a prefix or suffix for
    // wildcard searching. As such, we need to validate that the name is
    // valid whether or not it is surrounded by '*'s.
    nameBegin = 0;
    nameLen = name.length;

    if (nameLen > 1 && name[0] === '*') {
        nameBegin++;
        nameLen--;
    }

    if (nameLen > 1 && name[nameBegin + nameLen - 1] === '*') {
        nameLen--;
    }

    // coreName is the name w/o the (optional) '*' prefix or suffix
    coreName = name.substr(nameBegin, nameLen);

    if (!VALID_VOLUME_NAME_CHARS_REGEXP.test(coreName)) {
        err = new Error('invalid value for name search parameter');
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
    var validSize = typeof (size) === 'number' && size > 0;

    if (!validSize) {
        err = new Error('Volume size: "' + size + '" is not a valid volume ' +
            'size. Size must be a number > 0');
    }

    return err;
}

function validateVolumeSizeSearchParam(size) {
    var err;

    if (!VALID_VOLUME_SIZE_REGEXP.test(size)) {
        err = new Error('invalid value for size search parameter, must match '
            + VALID_VOLUME_SIZE_REGEXP.toString());
    }

    return err;
}

function validateVolumeState(state) {
    console.log('state: ', state);

    var VALID_STATES = [
        'creating', 'ready', 'failed', 'rolling_back', 'deleting'
    ];
    var err;

    if (VALID_STATES.indexOf(state) === -1) {
        err = new Error('Volume state: ' + state + ' is invalid');
    }

    return err;
}

function validateVolumeUuid(volumeUuid) {
    var err;
    var validVolumeUuid = validUuid(volumeUuid);

    if (!validVolumeUuid) {
        err = new Error(volumeUuid + ' is not a valid volume UUID');
    }

    return err;
}

module.exports = {
    validateOwnerUuid: validateOwnerUuid,
    validateVolumeName: validateVolumeName,
    validateVolumeNameSearchParam: validateVolumeNameSearchParam,
    validateVolumeNetwork: validateVolumeNetwork,
    validateVolumeSize: validateVolumeSize,
    validateVolumeSizeSearchParam: validateVolumeSizeSearchParam,
    validateVolumeState: validateVolumeState,
    validateVolumeType: validateVolumeType,
    validateVolumeUuid: validateVolumeUuid
};
