/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var util = require('util');

function VolumeNotFoundError(volumeUuid) {
    restify.RestError.call(this, {
        restCode: 'VolumeNotFound',
        statusCode: 404,
        message: 'Volume with uuid ' + volumeUuid + ' could not be found',
        constructorOpt: VolumeNotFoundError
    });
    this.name = 'VolumeNotFoundError';
}
util.inherits(VolumeNotFoundError, restify.RestError);

function VolumeReservationNotFoundError(volumeResUuid) {
    restify.RestError.call(this, {
        restCode: 'VolumeReservationNotFound',
        statusCode: 404,
        message: 'Volume reservation with uuid ' + volumeResUuid + ' could ' +
            'not be found',
        constructorOpt: VolumeReservationNotFoundError
    });
    this.name = 'VolumeReservationNotFoundError';
}
util.inherits(VolumeReservationNotFoundError, restify.RestError);

function VolumeAlreadyExistsError(volumeName) {
    restify.RestError.call(this, {
        restCode: 'VolumeAlreadyExists',
        statusCode: 409,
        message: 'Volume with name ' + volumeName + ' already exists',
        constructorOpt: VolumeAlreadyExistsError
    });
    this.name = 'VolumeAlreadyExistsError';
}
util.inherits(VolumeAlreadyExistsError, restify.RestError);

function VolumeInUseError(volumeName) {
    restify.RestError.call(this, {
        restCode: 'VolumeInUse',
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
        restCode: 'ValidationError',
        statusCode: 409,
        message: 'Validation error, causes: ' + causes,
        constructorOpt: ValidationError
    });
    this.name = 'ValidationError';
}
util.inherits(ValidationError, restify.RestError);

module.exports = {
    InternalError: restify.InternalError,
    ValidationError: ValidationError,
    VolumeAlreadyExistsError: VolumeAlreadyExistsError,
    VolumeInUseError: VolumeInUseError,
    VolumeNotFoundError: VolumeNotFoundError
};