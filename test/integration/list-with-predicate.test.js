/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');
var Logger = require('bunyan');
var test = require('tape');
var vasync = require('vasync');

var clientsSetup = require('./lib/clients-setup');
var configLoader = require('../../lib/config-loader');
var Moray = require('../../lib/moray');
var resources = require('./lib/resources');
var volumesModel = require('../../lib/models/volumes');
var testVolumes = require('./lib/volumes');

var CONFIG = configLoader.loadConfigSync();

var UFDS_ADMIN_UUID = CONFIG.ufdsAdminUuid;
assert.string(UFDS_ADMIN_UUID, 'UFDS_ADMIN_UUID');

var API_CLIENTS;
var MORAY_CLIENT;
var LOGGER = new Logger({
    level: process.env.LOG_LEVEL || 'info',
    name: 'volapi_integrations_test_list_with_predicate',
    stream: process.stderr
});

var VOLUMES_NAMES_PREFIX = 'test-volumes-list-predicate';

function deleteTestVolumeObject(volumeUuid, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    volumesModel.deleteVolume(volumeUuid, callback);
}

function deleteAllTestVolumeObjects(callback) {
    assert.func(callback, 'callback');

    volumesModel.listVolumes({name: VOLUMES_NAMES_PREFIX + '*'},
        function onListVolumes(listErr, volumes) {
            if (listErr) {
                callback(listErr);
                return;
            }

            vasync.forEachParallel({
                func: deleteTestVolumeObject,
                inputs: volumes.map(function getVolumeUuid(volume) {
                    assert.object(volume, 'volume');
                    return volume.value.uuid;
                })
            }, function allVolumesDeleted(deleteErr) {
                callback(deleteErr);
            });
        });
}

function createTestVolumeObject(volumeParams, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.func(callback, 'callback');

    volumesModel.createVolume(volumeParams, callback);
}

test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            API_CLIENTS = clients;
            t.end();
        });
    });

    tt.test('setup test moray client', function (t) {
        MORAY_CLIENT = new Moray(CONFIG.moray);
        MORAY_CLIENT.connect();
        MORAY_CLIENT.on('connect', function onMorayConnected() {
            t.end();
        });
    });

    tt.test('init volumes model', function (t) {
        volumesModel.init(CONFIG, {
            morayClient: MORAY_CLIENT,
            log: LOGGER
        }, function onVolumesModelInitialized(err) {
            t.ifErr(err, 'volumes model initialization should not error');
            t.end();
        });
    });
});

test('cleanup leftover volumes', function (tt) {
    tt.test('cleaning up all volumes should be successful', function (t) {
        deleteAllTestVolumeObjects(function onAllDeleted(err) {
            t.ifErr(err, 'deleting all test volume objects should succeed');
            t.end();
        });
    });
});

test('listing nfs shared volumes with an invalid predicate', function (tt) {

    tt.test('using invalid attribute name in predicate should error',
        function (t) {
            var predicate = {
                eq: ['invalid-pred', 'foo']
            };

            API_CLIENTS.volapi.listVolumes({
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, req, res, obj) {
                t.ok(err,
                    'listing volumes with invalid predicate should error');
                t.end();
            });
        });

    tt.test('using invalid state value in predicate should error',
        function (t) {
            var predicate = {
                eq: ['state', 'invalid-state']
            };

            API_CLIENTS.volapi.listVolumes({
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, req, res, obj) {
                t.ok(err,
                    'listing volumes with invalid predicate should error');
                t.end();
            });
        });

    tt.test('using invalid type value in predicate should error',
        function (t) {
            var predicate = {
                eq: ['type', 'invalid-type']
            };

            API_CLIENTS.volapi.listVolumes({
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, req, res, obj) {
                t.ok(err,
                    'listing volumes with invalid predicate should error');
                t.end();
            });
        });

    tt.test('using invalid name value in predicate should error',
        function (t) {
            var predicate = {
                eq: ['name', '/invalid/name']
            };

            API_CLIENTS.volapi.listVolumes({
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, req, res, obj) {
                t.ok(err,
                    'listing volumes with invalid predicate should error');
                t.end();
            });
        });
});

test('listing nfs shared volumes with simple predicates', function (tt) {
    var snowflakeName1 =
            resources.makeResourceName(VOLUMES_NAMES_PREFIX + '-empty');
    var snowflakeName2 =
            resources.makeResourceName(VOLUMES_NAMES_PREFIX + '-empty');

    var testVolumeObjects = [
        {
            uuid: libuuid.create(),
            name: snowflakeName1,
            owner_uuid: UFDS_ADMIN_UUID,
            type: 'tritonnfs'
        },
        {
            uuid: libuuid.create(),
            name: snowflakeName2,
            owner_uuid: UFDS_ADMIN_UUID,
            type: 'tritonnfs'
        }
    ];

    tt.test('creating test volume objects should succeed', function (t) {
        vasync.forEachParallel({
            func: createTestVolumeObject,
            inputs: testVolumeObjects
        }, function allTestVolumeObjectsCreated(err, results) {
            t.ifErr(err, 'creating test volume objects should not error');
            t.end();
        });
    });

    tt.test('listing with empty predicate should list all test volume objects',
        function (t) {
            var volumesListedFromMoray;
            var volumesListedWithEmptyPredicate;

            vasync.parallel({
                funcs: [
                    function getAllVolumesFromMoray(callback) {
                        volumesModel.listVolumes({},
                            function onAllVolumesListed(err, volumes) {
                                t.ifErr(err,
                                    'list all volumes should not error');
                                volumesListedFromMoray = volumes;
                                callback();
                            });
                    },
                    function getAllVolumesWithEmptyPredicate(callback) {
                        var predicate = {};

                        API_CLIENTS.volapi.listVolumes({
                            predicate: JSON.stringify(predicate)
                        }, function onListVolumes(err, volumes) {
                            t.ifErr(err,
                                'listing volumes with a name predicate '
                                    + 'should not error');
                            t.ok(Array.isArray(volumes),
                                'response body should be an array');
                            volumesListedWithEmptyPredicate = volumes;
                            callback();
                        });
                    }
                ]
            }, function allListingDone(err) {
                t.equal(volumesListedFromMoray.length,
                    volumesListedWithEmptyPredicate.length,
                    'listing volumes with an empty predicate should list the '
                        + 'same number of volumes than listing from the models '
                        + 'layer with no search params');
                t.end();
            });
        });

    tt.test('list test volume objects with simple predicate on name',
        function (t) {
            var predicate = {
                eq: ['name', snowflakeName1]
            };

            API_CLIENTS.volapi.listVolumes({
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, volumes) {
                t.ifErr(err,
                    'listing volumes with a name predicate should not '
                        + 'error');
                t.ok(Array.isArray(volumes),
                    'response body should be an array');
                t.equal(volumes.length, 1,
                    'only one volume should be included in the response '
                        + 'body');
                t.equal(volumes[0].name, snowflakeName1,
                    'the name of the volume returned in the response '
                        + 'should be: ' + snowflakeName1 + ', got: '
                        + volumes[0].name);
                t.end();
            });
        });

    tt.test('removing test volume objects should succeed', function (t) {
        vasync.forEachParallel({
            func: deleteTestVolumeObject,
            inputs: testVolumeObjects.map(function getVolumeUuid(volume) {
                assert.object(volume, 'volume');
                return volume.uuid;
            })
        }, function allTestVolumeObjectsDeleted(err, results) {
            t.ifErr(err, 'deleting test volume objects should not error');
            t.end();
        });
    });
});

test('listing volumes with composed predicates', function (tt) {

    var MEBIBYTES_PER_GIBIBYTE = 1024;

    var snowflakeName =
            resources.makeResourceName(VOLUMES_NAMES_PREFIX + '-composed');

    var snowflakeSize1 = 10 * MEBIBYTES_PER_GIBIBYTE;
    var snowflakeSize2 = 20 * MEBIBYTES_PER_GIBIBYTE;
    var snowflakeSize3 = 30 * MEBIBYTES_PER_GIBIBYTE;

    var snowflakeState1 = 'creating';
    var snowflakeState2 = 'running';
    var snowflakeState3 = 'failed';

    var testVolumeObjects = [
        {
            uuid: libuuid.create(),
            name: snowflakeName,
            owner_uuid: UFDS_ADMIN_UUID,
            type: 'tritonnfs',
            state: snowflakeState1,
            size: snowflakeSize1
        },
        {
            uuid: libuuid.create(),
            name: snowflakeName,
            owner_uuid: UFDS_ADMIN_UUID,
            type: 'tritonnfs',
            state: snowflakeState2,
            size: snowflakeSize2
        },
        {
            uuid: libuuid.create(),
            name: snowflakeName,
            owner_uuid: UFDS_ADMIN_UUID,
            type: 'tritonnfs',
            state: snowflakeState3,
            size: snowflakeSize3
        }
    ];

    tt.test('creating test volume objects should succeed', function (t) {
        vasync.forEachParallel({
            func: createTestVolumeObject,
            inputs: testVolumeObjects
        }, function allTestVolumeObjectsCreated(err, results) {
            t.ifErr(err, 'creating test volume objects should not error');
            t.end();
        });
    });

    tt.test('list test volume objects with composed predicate on state',
        function (t) {
            var predicate = {
                and: [
                    {
                        eq: ['name', snowflakeName]
                    },
                    {
                        eq: ['state', snowflakeState1]
                    }
                ]
            };

            API_CLIENTS.volapi.listVolumes({
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, volumes) {
                t.ifErr(err,
                    'listing volumes with a composed predicate should not '
                        + 'error');
                t.ok(Array.isArray(volumes),
                    'response body should be an array');
                t.equal(volumes.length, 1,
                    'only one volume should be included in the response '
                        + 'body');
                t.equal(volumes[0].state, snowflakeState1,
                    'the state of the first volume returned in the '
                        + 'response should be: ' + snowflakeState1 + ', got: ' +
                        volumes[0].state);
                t.end();
            });
        });

    tt.test('list test volume objects with composed predicate on size',
        function (t) {
            var predicate = {
                and: [
                    {
                        eq: ['name', snowflakeName]
                    },
                    {
                        eq: ['size', snowflakeSize1]
                    }
                ]
            };

            API_CLIENTS.volapi.listVolumes({
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, volumes) {
                t.ifErr(err,
                    'listing volumes with a composed predicate should not '
                        + 'error');
                t.ok(Array.isArray(volumes),
                    'response body should be an array');
                t.equal(volumes.length, 1,
                    'only one volume should be included in the response '
                        + 'body');
                t.equal(volumes[0].size, snowflakeSize1,
                    'the size of the first volume returned in the '
                        + 'response should be: ' + snowflakeSize1 + ', got: '
                        + volumes[0].size);
                t.end();
            });
        });

    tt.test('removing test volume objects should succeed', function (t) {
        vasync.forEachParallel({
            func: deleteTestVolumeObject,
            inputs: testVolumeObjects.map(function getVolumeUuid(volume) {
                assert.object(volume, 'volume');
                return volume.uuid;
            })
        }, function allTestVolumeObjectsDeleted(err, results) {
            t.ifErr(err, 'deleting test volume objects should not error');
            t.end();
        });
    });
});

test('teardown', function (tt) {
    tt.test('close moray client connection', function (t) {
        MORAY_CLIENT.close();
        t.end();
    });
});