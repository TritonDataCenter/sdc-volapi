/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');

var mod_uuid = require('../uuid');

function validateUuid(uuid, paramName) {
    assert.string(paramName, 'paramName');

    var err;
    var validUuid = mod_uuid.validUuid(uuid);

    if (!validUuid) {
        err = new Error(uuid + ' is not a valid ' + paramName + ' UUID');
    }

    return err;
}

module.exports = {
    validateUuid: validateUuid
};