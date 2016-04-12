/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');

function makeResourceName(prefix) {
    assert.string(prefix, 'prefix');

    return [prefix, libuuid.create().split('-')[0]].join('-');
}

module.exports = {
    makeResourceName: makeResourceName
};