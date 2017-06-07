/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var krill = require('krill');
var libuuid = require('libuuid');
var VError = require('verror');

var log;
var morayClient;

var VOLUMES_RESERVATIONS_BUCKET_NAME = 'volapi_volumes_reservations';
var VOLUMES_RESERVATIONS_BUCKET_CONFIG = {
    index: {
        create_timestamp: { type: 'number' },
        job_uuid: { type: 'string' },
        owner_uuid: { type: 'string' },
        uuid: { type: 'string', unique: true},
        vm_uuid: { type: 'string' },
        volume_name: { type: 'string' }
    }
};

function createVolumeReservation(reservationParams, callback) {
    assert.object(reservationParams, 'reservationParams');
    assert.uuid(reservationParams.job_uuid, 'reservationParams.job_uuid');
    assert.uuid(reservationParams.owner_uuid, 'reservationParams.owner_uuid');
    assert.string(reservationParams.volume_name,
        'reservationParams.volume_name');
    assert.uuid(reservationParams.vm_uuid, 'reservationParams.vm_uuid');
    assert.func(callback, 'callback');

    log.debug({reservationParams: reservationParams},
        'Create volume reservation');

    var uuid = libuuid.create();

    var jobUuid = reservationParams.job_uuid;
    var volumeName = reservationParams.volume_name;
    var ownerUuid = reservationParams.owner_uuid;
    var vmUuid = reservationParams.vm_uuid;

    var reservationObject = {
        create_timestamp: (new Date()).getTime(),
        job_uuid: jobUuid,
        owner_uuid: ownerUuid,
        uuid: uuid,
        vm_uuid: vmUuid,
        volume_name: volumeName
    };

    log.debug({reservationObject: reservationObject},
        'Creating volume reservation object in moray');

    morayClient.putObject(VOLUMES_RESERVATIONS_BUCKET_NAME, uuid,
        reservationObject, {
        etag: null
    }, function onPutObjectDone(err) {
        return callback(err, uuid);
    });
}

function getVolumeReservation(reservationUuid, callback) {
    assert.uuid(reservationUuid, 'reservationUuid');
    assert.func(callback, 'callback');

    log.debug({reservationUuid: reservationUuid}, 'Get volume reservation');

    morayClient.getObject(VOLUMES_RESERVATIONS_BUCKET_NAME, reservationUuid,
        callback);
}

function deleteVolumeReservation(reservationUuid, callback) {
    assert.uuid(reservationUuid, 'reservationUuid');
    assert.func(callback, 'callback');

    log.debug({reservationUuid: reservationUuid}, 'Delete volume reservation');

    morayClient.deleteObject(VOLUMES_RESERVATIONS_BUCKET_NAME, reservationUuid,
        callback);
}

function makeBatchDelOpFromVolRes(volResObject) {
    assert.object(volResObject, 'volResObject');

    return {
        bucket: VOLUMES_RESERVATIONS_BUCKET_NAME,
        etag: volResObject._etag,
        key: volResObject.value.uuid,
        operation: 'delete'
    };
}

function deleteVolumeReservations(volumeReservations, callback) {
    assert.arrayOfObject(volumeReservations, 'volumeReservations');
    assert.func(callback, 'callback');

    var delBatch = volumeReservations.map(makeBatchDelOpFromVolRes);
    if (delBatch && delBatch.length > 0) {
        morayClient.batch(delBatch, callback);
    } else {
        callback();
    }
}

function searchVolumeReservations(filter, callback) {
    assert.string(filter, 'filter');
    assert.func(callback, 'callback');

    var req = morayClient.findObjects(VOLUMES_RESERVATIONS_BUCKET_NAME, filter);
    var reservationsFound = [];

    req.on('error', function onFindErr(findErr) {
        callback(findErr);
    });

    req.on('record', function onRecord(reservationObj) {
        reservationsFound.push(reservationObj);
    });

    req.on('end', function onEnd() {
        callback(null, reservationsFound);
    });
}

function listVolumeReservations(params, callback) {
    if (typeof (params) === 'function') {
        callback = params;
        params = {};
    }

    assert.object(params, 'params');
    assert.optionalString(params.volumeName, 'params.volumeName');
    assert.optionalUuid(params.vmUuid, 'params.vmUuid');
    assert.optionalUuid(params.ownerUuid, 'params.ownerUuid');
    assert.optionalUuid(params.jobUuid, 'params.jobUuid');
    assert.func(callback, 'callback');

    log.debug({params: params}, 'ListVolumeReservations');

    var jobUuid = params.jobUuid;
    var ldapFilter;
    var ownerUuid = params.ownerUuid;
    var predicate;
    var predicateComponents = [];
    var vmUuid = params.vmUuid;
    var volumeName = params.volumeName;

    if (volumeName !== undefined) {
        predicateComponents.push({eq: ['volume_name', volumeName]});
    }

    if (vmUuid !== undefined) {
        predicateComponents.push({eq: ['vm_uuid', vmUuid]});
    }

    if (ownerUuid !== undefined) {
        predicateComponents.push({eq: ['owner_uuid', ownerUuid]});
    }

    if (jobUuid !== undefined) {
        predicateComponents.push({eq: ['job_uuid', jobUuid]});
    }

    log.debug({
        predicateComponents: predicateComponents
    }, 'Built predicate components');

    if (predicateComponents.length === 0) {
        predicate = krill.createPredicate({eq: ['uuid', '*']});
    } else if (predicateComponents.length === 1) {
        predicate = krill.createPredicate(predicateComponents[0]);
    } else {
        predicate = krill.createPredicate({
            and: predicateComponents
        });
    }

    ldapFilter = predicate.toLDAPFilterString();
    log.debug({filter: ldapFilter}, 'Generated LDAP filter');

    searchVolumeReservations(ldapFilter, callback);
}

function init(config, options, callback) {
    assert.object(config, 'config');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.morayClient, 'options.morayClient');
    assert.func(callback, 'callback');

    morayClient = options.morayClient;
    log = options.log;

    log.info('Initializing volumes reservations model...');

    morayClient.setupBucket({
        name: VOLUMES_RESERVATIONS_BUCKET_NAME,
        config: VOLUMES_RESERVATIONS_BUCKET_CONFIG
    }, function volumeModelInitialized(err) {
        if (err) {
            log.error({err: err},
                'Error when initializing volumes reservations model');
        } else {
            log.info('Volumes reservations model initialized successfully');
        }

        return callback(err);
    });
}

module.exports = {
    init: init,
    createVolumeReservation: createVolumeReservation,
    getVolumeReservation: getVolumeReservation,
    deleteVolumeReservation: deleteVolumeReservation,
    deleteVolumeReservations: deleteVolumeReservations,
    listVolumeReservations: listVolumeReservations
};