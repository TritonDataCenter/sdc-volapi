/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
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

function VolumeInUseError(volumeName) {
    restify.RestError.call(this, {
        restCode: 'VOLUME_IN_USE',
        statusCode: 409,
        message: 'Volume with name ' + volumeName + ' is used',
        constructorOpt: VolumeInUseError
    });
    this.name = 'VolumeInUseError';
}
util.inherits(VolumeInUseError, restify.RestError);

function ValidationError(causes) {
    assert.arrayOfObject(causes, 'causes');

    restify.RestError.call(this, {
        restCode: 'VALIDATION_ERROR',
        statusCode: 409,
        message: 'Validation error, causes: ' + causes,
        constructorOpt: ValidationError
    });
    this.name = 'ValidationError';
}
util.inherits(ValidationError, restify.RestError);

module.exports = {
    VolumeAlreadyExistsError: VolumeAlreadyExistsError,
    VolumeInUseError: VolumeInUseError,
    ValidationError: ValidationError
};