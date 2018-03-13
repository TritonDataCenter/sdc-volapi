/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var restify = require('restify');
var util = require('util');

function InvalidNetworksError(options) {
    assert.object(options, 'options');
    assert.optionalArrayOfUuid(options.missing, 'options.missing');
    assert.optionalArrayOfUuid(options.nonOwned, 'options.nonOwned');
    assert.optionalArrayOfUuid(options.nonFabric, 'options.nonFabric');

    assert.ok((options.missing && options.missing.length > 0) ||
        (options.nonOwned && options.nonOwned.length > 0) ||
        (options.nonFabric && options.nonFabric.length > 0),
        'at least one network needs to be missing, non-owned or non-fabric');

    var detailsMsgs = [];
    var errMsg;
    var invalidNetsMsg = 'Invalid networks';

    if (options.missing && options.missing.length > 0) {
        detailsMsgs.push('missing: ' + options.missing.join(', '));
    }

    if (options.nonOwned && options.nonOwned.length > 0) {
        detailsMsgs.push('not owned by user: ' + options.nonOwned.join(', '));
    }

    if (options.nonFabric && options.nonFabric.length > 0) {
        detailsMsgs.push('non-fabric: ' + options.nonFabric.join(', '));
    }

    errMsg = invalidNetsMsg + ': ' + detailsMsgs.join(', ');

    restify.RestError.call(this, {
        restCode: 'InvalidNetworks',
        statusCode: 409,
        message: errMsg,
        constructorOpt: InvalidNetworksError
    });
    this.name = 'InvalidNetworksError';
}
util.inherits(InvalidNetworksError, restify.RestError);

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
        message: 'Validation error, causes: ' + causes.join(', '),
        constructorOpt: ValidationError
    });
    this.name = 'ValidationError';
}
util.inherits(ValidationError, restify.RestError);

function VolumeSizeNotAvailableError(size, availableSizes) {
    assert.number(size, 'size');
    assert.arrayOfNumber(availableSizes, 'availableSizes');

    var message = 'Volume size ' + size + ' is not available. Available ' +
        'sizes are: ' + availableSizes.join(', ');

    restify.RestError.call(this, {
        restCode: 'VolumeSizeNotAvailable',
        statusCode: 409,
        message: message,
        constructorOpt: VolumeSizeNotAvailableError,
        /*
         * We specify a custom "body" property so that we can include the list
         * of available volume sizes in its "availableSizes" property. Clients
         * can use that extra information to output error messages that are
         * relevant to their users without having to send a separate request to
         * the ListVolumeSizes endpoint.
         */
        body: {
            code: 'VolumeSizeNotAvailable',
            message: message,
            availableSizes: availableSizes
        }
    });
    this.name = 'VolumeSizeNotAvailableError';
}
util.inherits(VolumeSizeNotAvailableError, restify.RestError);

module.exports = {
    InternalError: restify.InternalError,
    InvalidNetworksError: InvalidNetworksError,
    ValidationError: ValidationError,
    VolumeAlreadyExistsError: VolumeAlreadyExistsError,
    VolumeInUseError: VolumeInUseError,
    VolumeNotFoundError: VolumeNotFoundError,
    VolumeSizeNotAvailableError: VolumeSizeNotAvailableError
};