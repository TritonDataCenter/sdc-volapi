/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var libuuid = require('libuuid');
var ldapFilter = require('ldap-filter');
var vasync = require('vasync');

var units = require('../units');
var volumes = require('../volumes');

var VOLUMES_BUCKET_NAME = 'volapi_volumes';
var VOLUMES_BUCKET_CONFIG = {
    index: {
        uuid: { type: 'string', unique: true},
        owner_uuid: { type: 'string' },
        name: { type: 'string' },
        vm_uuid: { type: 'string' },
        create_timestamp: { type: 'number' },
        type: {type: 'string'},
        size: {type: 'number'},
        state: {type: 'string'}
    }
};

var morayClient;
var log;

function createVolume(volumeParams, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.func(callback, 'callback');

    log.debug({volumeParams: volumeParams}, 'Create volume');

    var volumeUuid = volumeParams.uuid;
    var name = volumeParams.name;
    var ownerUuid = volumeParams.owner_uuid;
    var size = volumeParams.size;
    var type = volumeParams.type;
    var state = volumeParams.state || 'creating';

    var volumeObject = {
        uuid: volumeUuid,
        name: name,
        owner_uuid: ownerUuid,
        size: size,
        type: type,
        create_timestamp: (new Date()).getTime(),
        state: state
    };

    log.debug({volumeObject: volumeObject}, 'Creating volume object in moray');

    morayClient.putObject(VOLUMES_BUCKET_NAME, volumeUuid, volumeObject, {
        etag: null
    }, function onPutObjectDone(err) {
        return callback(err, volumeUuid);
    });
}

function updateVolume(volumeUuid, volumeObject, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.object(volumeObject, 'volumeObject');
    assert.func(callback, 'callback');

    log.debug({volumeObject: volumeObject}, 'Updating volume object in moray');

    morayClient.putObject(VOLUMES_BUCKET_NAME, volumeUuid, volumeObject, {
        etag: volumeObject.etag
    }, callback);
}

function _buildSearchFilter(params) {
    assert.object(params, 'params');

    var SELECT_ALL_FILTER = '(uuid=*)';
    var paramName;
    var filters = [];
    var searchFilter;
    var predicateLdapFilter;

    if (params.predicate && !params.predicate.trivial()) {
        predicateLdapFilter =
            ldapFilter.parse(params.predicate.toLDAPFilterString());
    }

    if (predicateLdapFilter) {
        filters.push(predicateLdapFilter);
    }

    for (paramName in params) {
        // 'predicate' is a special parameter that cannot be directly translated
        // into an LDAP filter, and is instead parsed separately into a LDAP
        // filter.
        if (paramName === 'predicate') {
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

    if (filters.length === 0) {
        searchFilter = ldapFilter.parse(SELECT_ALL_FILTER);
    } else if (filters.length === 1) {
        searchFilter = filters[0];
    } else if (filters.length > 1) {
        searchFilter = new ldapFilter.AndFilter({filters: filters});
    }

    return searchFilter.toString();
}

function listVolumes(params, callback) {
    assert.object(params, 'params');
    assert.optionalString(params.name, 'params.name');
    assert.optionalString(params.owner_uuid, 'params.owner_uuid');
    assert.optionalObject(params.predicate, 'params.predicate');
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
            var value;
            if (volumeObject) {
                value = volumeObject.value;
            }

            return callback(err, value);
        });
}

function deleteVolume(volumeUuid, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    log.debug({volumeUuid: volumeUuid}, 'Delete volume');

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
    updateVolume: updateVolume,
    loadVolume: loadVolume,
    listVolumes: listVolumes,
    deleteVolume: deleteVolume
};