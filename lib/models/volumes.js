/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var util = require('util');

var assert = require('assert-plus');
var libuuid = require('libuuid');
var ldapFilter = require('ldap-filter');

var VOLUMES_BUCKET_NAME = 'vapi_volumes';
var VOLUMES_BUCKET_CONFIG = {
    index: {
        uuid: { type: 'string', unique: true},
        owner_uuid: { type: 'string' },
        name: { type: 'string' },
        vm_uuid: { type: 'string' },
        create_timestamp: { type: 'number' }
    }
};

var morayClient;
var log;

function createVolume(volumeParams, storageVmUuid, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.string(storageVmUuid, 'storageVmUuid');
    assert.func(callback, 'callback');

    var volumeUuid = volumeParams.uuid;

    var volumeObject = {
        name: volumeParams.name,
        size: volumeParams.size,
        uuid: volumeUuid,
        vm_uuid: storageVmUuid,
        owner_uuid: volumeParams.owner_uuid
    };

    log.debug({volumeObject: volumeObject}, 'putting volume object in moray');

    morayClient.putObject(VOLUMES_BUCKET_NAME, volumeUuid, volumeObject,
        function onPutObjectDone(err) {
            return callback(err, volumeUuid);
        });
}

function _buildSearchFilter(params) {
    assert.object(params, 'params');

    var SELECT_ALL_FILTER = '(uuid=*)';
    var paramName;
    var filters = [];
    var searchFilter;

    for (paramName in params) {
        // 'filter' is a special parameter that cannot be directly translated
        // into an LDAP filter.
        if (paramName === 'filter') {
            continue;
        }

        if (params[paramName] === undefined) {
            continue;
        }

        filters.push(new ldapFilter.EqualityFilter({
            attribute: paramName,
            value: params[paramName]
        }));
    }

    if (filters.length > 0) {
        searchFilter = new ldapFilter.AndFilter({filters: filters});
    } else {
        searchFilter = ldapFilter.parse(SELECT_ALL_FILTER);
    }

    return searchFilter.toString();
}

function listVolumes(params, callback) {
    assert.object(params, 'params');
    assert.func(callback, 'callback');

    var volumesFound = [];

    var searchFilter = _buildSearchFilter(params);
    log.debug({searchFilter: searchFilter}, 'Built search filter');

    var req = morayClient.findObjects(VOLUMES_BUCKET_NAME, searchFilter);

    req.once('error', function onSearchVolumeError(err) {
        callback(err);
    });

    req.on('record', function onVolumeFound(volumeObj) {
        volumesFound.push(volumeObj.value);
    });

    req.on('end', function onSearchVolumeEnd() {
        callback(null, volumesFound);
    });
}

function loadVolume(volumeUuid, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    morayClient.getObject(VOLUMES_BUCKET_NAME, volumeUuid,
        function onObjectLoaded(err, volumeObject) {
            return callback(err, volumeObject.value);
        });
}

function deleteVolume(volumeUuid, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    morayClient.deleteObject(VOLUMES_BUCKET_NAME, volumeUuid, callback);
}

function init(config, options, callback) {
    assert.object(config, 'config');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.morayClient, 'options.morayClient');
    assert.func(callback, 'callback');

    morayClient = options.morayClient;
    log = options.log;

    log.info('Initializing volumes model...');

    morayClient.setupBucket({
        name: VOLUMES_BUCKET_NAME,
        config: VOLUMES_BUCKET_CONFIG
    }, function volumeModelInitialized(err) {
        if (err) {
            log.error({err: err}, 'Error when initializing volumes model');
        } else {
            log.info('Volumes model initialized successfully');
        }

        return callback(err);
    });
}

module.exports = {
    init: init,
    createVolume: createVolume,
    loadVolume: loadVolume,
    listVolumes: listVolumes,
    deleteVolume: deleteVolume
};