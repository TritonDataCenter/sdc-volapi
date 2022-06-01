/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 */

var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var libuuid = require('libuuid');
var ldapFilter = require('ldap-filter');
var vasync = require('vasync');
var verror = require('verror');

var volumes = require('../volumes');

var VOLUMES_BUCKET_NAME = 'volapi_volumes';
var VOLUMES_BUCKET_CONFIG = {
    index: {
        uuid: { type: 'string', unique: true},
        owner_uuid: { type: 'string' },
        name: { type: 'string' },
        vm_uuid: { type: 'string' },
        create_timestamp: { type: 'number' },
        // labels is a stringified JSON object.
        labels: { type: 'string' },
        type: {type: 'string'},
        size: {type: 'number'},
        state: {type: 'string'},
        /*
         * "references" is a reserved Postgresql keyword, and so using the name
         * "references" here would cause errors when adding the corresponding
         * table column in Postgres as part of the moray bucket initialization
         * process.
         */
        refs: {type: '[string]'}
    }
};

var morayClient;
var log;

function createVolume(volumeParams, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.func(callback, 'callback');

    log.debug({volumeParams: volumeParams}, 'Create volume');

    var volumeUuid = volumeParams.uuid;
    var labels = volumeParams.labels;
    var name = volumeParams.name;
    var ownerUuid = volumeParams.owner_uuid;
    var size = volumeParams.size;
    var type = volumeParams.type;
    var state = volumeParams.state || 'creating';

    var volumeObject = {
        uuid: volumeUuid,
        labels: labels,
        name: name,
        owner_uuid: ownerUuid,
        size: size,
        type: type,
        create_timestamp: (new Date()).getTime(),
        state: state
    };

    if (volumeParams.refs !== undefined) {
        volumeObject.refs = volumeParams.refs;
    }

    if (volumeParams.networks !== undefined) {
        volumeObject.networks = volumeParams.networks;
    }

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

    morayClient.putObject(VOLUMES_BUCKET_NAME, volumeUuid, volumeObject.value, {
        etag: volumeObject.etag
    }, callback);
}

function _isTransientVolumeUpdateError(volumeUpdateError) {
    assert.object(volumeUpdateError, 'volumeUpdateError');

    return [
        'BucketNotFoundError',
        'NoDatabaseError',
        'UniqueAttributeError',
        'InvalidIndexTypeError',
        /*
         * An etag conflict error is not considered to be transient because it
         * requires the user/client to submit _different_ input data in order
         * for the request to have a chance to succeed.
         */
        'EtagConflictError'
    ].indexOf(volumeUpdateError.name) === -1;
}

function updateVolumeWithRetry(volumeUuid, volumeObject, callback) {
    assert.uuid(volumeUuid, 'volumeUuid');
    assert.object(volumeObject, 'volumeObject');
    assert.func(callback, 'callback');

    var MAX_NB_VOLUME_UPDATE_TRIES = 10;
    var nbVolumeUpdateTries = 0;
    var RETRY_DELAY = 1000;

    function doUpdateVolume() {
        if (nbVolumeUpdateTries > MAX_NB_VOLUME_UPDATE_TRIES) {
            callback(new Error('max number of retries (' +
                MAX_NB_VOLUME_UPDATE_TRIES + ') reached when trying to ' +
                'update volume'));
            return;
        }

        ++nbVolumeUpdateTries;

        updateVolume(volumeUuid, volumeObject,
            function onVolumeUpdated(volumeUpdateErr) {
            if (volumeUpdateErr &&
                _isTransientVolumeUpdateError(volumeUpdateErr)) {
                /*
                 * Updating the volume's state in moray failed but could
                 * eventually succeed if we retry, so we schedule a retry to
                 * happen later.
                 */
                log.error({error: volumeUpdateErr},
                    'Got transient error when updating volume object, ' +
                        'retrying...');
                setTimeout(RETRY_DELAY, doUpdateVolume);
            } else {
                callback(volumeUpdateErr);
            }
        });
    }

    doUpdateVolume();
}

function _buildSearchFilter(params) {
    assert.object(params, 'params');

    var filters = [];
    var paramName;
    var predicateLdapFilterObject;
    var predicateLdapFilterString;
    var searchFilter;
    var SELECT_ALL_FILTER = '(uuid=*)';

    if (params.predicate && !params.predicate.trivial()) {
        predicateLdapFilterString = params.predicate.toLDAPFilterString();
        assert.string(predicateLdapFilterString, 'predicateLdapFilterString');
        log.debug({
            filterString: predicateLdapFilterString
        }, 'filter string before subs');

        predicateLdapFilterString =
            predicateLdapFilterString.replace('(dangling=true)', '(!(refs=*))');
        predicateLdapFilterString =
            predicateLdapFilterString.replace('(dangling=false)', '(refs=*)');

        predicateLdapFilterObject = ldapFilter.parse(predicateLdapFilterString);
    }

    if (predicateLdapFilterObject) {
        filters.push(predicateLdapFilterObject);
    }

    for (paramName in params) {
        /*
         * 'predicate' is a special parameter that cannot be directly translated
         * into an LDAP filter, and is instead parsed separately into a LDAP
         * filter.
         */
        if (paramName === 'predicate') {
            continue;
        }

        if (params[paramName] === undefined) {
            continue;
        }

        /*
         * We want to be able to include '*' as a prefix or suffix, and if we
         * just add it using EqualityFilter, the '*' will be destroyed, so we
         * build the filter ourselves.
         *
         * NOTE: We assume the parameter has been validated. If it hasn't an
         *       exception will be thrown.
         */
        if (paramName === 'name') {
            filters.push(ldapFilter.parse('(name=' + params[paramName] + ')'));
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

function listVolumesByFilter(filter, callback) {
    assert.string(filter, 'filter');
    assert.func(callback, 'callback');

    var volumesFound = [];

    var req = morayClient.findObjects(VOLUMES_BUCKET_NAME, filter);

    req.once('error', function onSearchVolumeError(err) {
        callback(err);
    });

    req.on('record', function onVolumeFound(volumeObj) {
        volumesFound.push(volumeObj);
    });

    req.on('end', function onSearchVolumeEnd() {
        callback(null, volumesFound);
    });
}

function listVolumes(params, callback) {
    assert.object(params, 'params');
    assert.optionalString(params.name, 'params.name');
    assert.optionalString(params.owner_uuid, 'params.owner_uuid');
    assert.optionalString(params.state, 'params.state');
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
        volumesFound.push(volumeObj);
    });

    req.on('end', function onSearchVolumeEnd() {
        callback(null, volumesFound);
    });
}

function loadVolume(volumeUuid, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    morayClient.getObject(VOLUMES_BUCKET_NAME, volumeUuid, callback);
}

function deleteVolume(volumeUuid, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    log.debug({volumeUuid: volumeUuid}, 'Delete volume');

    morayClient.deleteObject(VOLUMES_BUCKET_NAME, volumeUuid, callback);
}

//
// Returns whether the error object "volumeDeleteError" represents a transient
// volume deletion error. Whether such an error is transient is determined by
// the list of non-transient deleteObject errors documented at
//
// /*JSSTYLED*/
// https://github.com/TritonDataCenter/moray/blob/52d7669f7134d2a57c35f97891d3e166d7f1cb76/docs/index.md#errors-8
//
// Note: the link doesn't refer to the master branch but to the current latest
// commit on that branch, this way if the documentation changes, this link will
// still point to the documentation at the time of the implementation of this
// function.
//
function _isTransientVolumeDeleteError(volumeDeleteError) {
    assert.object(volumeDeleteError, 'volumeDeleteError');

    return [
        'BucketNotFoundError',
        'EtagConflictError',
        'ObjectNotFoundError',
        'NoDatabaseError'
    ].indexOf(volumeDeleteError.name) === -1;
}

function deleteVolumeWithRetry(volumeUuid, callback) {
    assert.uuid(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    var MAX_NB_VOLUME_DELETE_TRIES = 10;
    var nbVolumeDeleteTries = 0;
    var RETRY_DELAY = 1000;

    function doDeleteVolume() {
        if (nbVolumeDeleteTries > MAX_NB_VOLUME_DELETE_TRIES) {
            callback(new Error('max number of retries (' +
                MAX_NB_VOLUME_DELETE_TRIES + ') reached when trying to ' +
                'delete volume'));
            return;
        }

        ++nbVolumeDeleteTries;

        deleteVolume(volumeUuid, function onVolumeDeleted(volumeDeleteErr) {
            if (volumeDeleteErr && verror.hasCauseWithName(volumeDeleteErr,
                'ObjectNotFoundError')) {
                // If we're trying to delete and the volume is already not
                // found, don't treat that as an error.
                callback();
            } else if (volumeDeleteErr &&
                _isTransientVolumeDeleteError(volumeDeleteErr)) {
                /*
                 * Deleting the volume from moray failed but could eventually
                 * succeed if we retry, so we schedule a retry to happen later.
                 */
                log.error({error: volumeDeleteErr},
                    'Got transient error when deleting volume object, ' +
                        'retrying...');
                setTimeout(RETRY_DELAY, doDeleteVolume);
            } else {
                callback(volumeDeleteErr);
            }
        });
    }

    doDeleteVolume();
}

function addReference(fromVmUuid, toVolumeUuid, callback) {
    assert.uuid(fromVmUuid, 'fromVmUuid');
    assert.uuid(toVolumeUuid, 'toVolumeUuid');
    assert.func(callback, 'callback');

    var context = {};

    vasync.pipeline({arg: context, funcs: [
        function doLoadVolume(ctx, next) {
            loadVolume(toVolumeUuid, function onVolLoaded(loadErr, volume) {
                if (volume) {
                    ctx.volumeObject = volume;
                }

                next(loadErr);
            });
        },
        function addRef(ctx, next) {
            assert.object(ctx.volumeObject, 'ctx.volumeObject');
            assert.object(ctx.volumeObject.value, 'ctx.volumeObject.value');

            var volumeObject = ctx.volumeObject;
            if (volumeObject.value.refs) {
                if (volumeObject.value.refs.indexOf(fromVmUuid) === -1) {
                    volumeObject.value.refs.push(fromVmUuid);
                }
            } else {
                volumeObject.value.refs = [fromVmUuid];
            }

            next();
        },
        function doUpdateVolume(ctx, next) {
            assert.object(ctx.volumeObject, 'ctx.volumeObject');

            updateVolumeWithRetry(toVolumeUuid, ctx.volumeObject, next);
        }
    ]}, callback);
}

function removeReference(fromVmUuid, toVolumeUuid, callback) {
    assert.uuid(fromVmUuid, 'fromVmUuid');
    assert.uuid(toVolumeUuid, 'toVolumeUuid');
    assert.func(callback, 'callback');

    var context = {};

    vasync.pipeline({arg: context, funcs: [
        function doLoadVolume(ctx, next) {
            loadVolume(toVolumeUuid, function onVolLoaded(loadErr, volume) {
                if (volume) {
                    ctx.volumeObject = volume;
                }

                next(loadErr);
            });
        },
        function removeRef(ctx, next) {
            assert.object(ctx.volumeObject, 'ctx.volumeObject');
            assert.object(ctx.volumeObject.value, 'ctx.volumeObject.value');

            var idx = -1;

            var volumeObject = ctx.volumeObject;
            if (volumeObject.value.refs) {
                idx = volumeObject.value.refs.indexOf(fromVmUuid);
            }

            if (idx !== -1) {
                volumeObject.value.refs.splice(idx, 1);
            }

            if (volumeObject.value.refs &&
                volumeObject.value.refs.length === 0) {
                delete volumeObject.value.refs;
            }

            next();
        },
        function doUpdateVolume(ctx, next) {
            assert.object(ctx.volumeObject, 'ctx.volumeObject');

            updateVolumeWithRetry(toVolumeUuid, ctx.volumeObject, next);
        }
    ]}, callback);
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
    updateVolumeWithRetry: updateVolumeWithRetry,
    loadVolume: loadVolume,
    listVolumes: listVolumes,
    listVolumesByFilter: listVolumesByFilter,
    deleteVolume: deleteVolume,
    deleteVolumeWithRetry: deleteVolumeWithRetry,
    addReference: addReference,
    removeReference: removeReference
};
