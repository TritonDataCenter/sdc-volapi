/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var restify = require('restify');
var util = require('util');

function VolumeAlreadyExistsError(volumeName) {
    restify.RestError.call(this, {
        restCode: 'VOLUME_ALREADY_EXISTS',
        statusCode: 409,
        message: 'Volume with name ' + volumeName + ' already exists',
        constructorOpt: VolumeAlreadyExistsError
    });
    this.name = 'VolumeAlreadyExistsError';
}
util.inherits(VolumeAlreadyExistsError, restify.RestError);

module.exports = {
    VolumeAlreadyExistsError: VolumeAlreadyExistsError
};