/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * NOTE: this file shares a lot of logic with list-with-predicate.test.js,
 * it would be good to separate out this common logic eventually.
 *
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

var ALTERNATE_OWNER_UUID = libuuid.create();
var UFDS_ADMIN_UUID = CONFIG.ufdsAdminUuid;
assert.string(UFDS_ADMIN_UUID, 'UFDS_ADMIN_UUID');

var API_CLIENTS;
var MORAY_CLIENT;
var LOGGER = new Logger({
    level: process.env.LOG_LEVEL || 'info',
    name: 'volapi_integrations_test_list_with_params',
    stream: process.stderr
});

var VOLUMES_NAMES_PREFIX = 'test-volumes-list-params';

function deleteTestVolumeObject(volumeUuid, callback) {
    assert.string(volumeUuid, 'volumeUuid');
    assert.func(callback, 'callback');

    volumesModel.deleteVolume(volumeUuid, callback);
}

function deleteAllTestVolumeObjects(callback) {
    assert.func(callback, 'callback');

    volumesModel.listVolumes({name: '*' + VOLUMES_NAMES_PREFIX + '*'},
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

test('listing nfs shared volumes with invalid query parameters', function (tt) {
    var badParameters = [
        [
            'unknown query parameter should be rejected',
            'unknown parameter',
            {gorilla: 'king kong'}
        ],
        [
            'wildcard should not be allowed in middle of name',
            'wildcard',
            {name: 'go*la'}
        ],
        [
            'invalid size should fail',
            'size',
            {size: 'yuge'}
        ],
        [
            'invalid state should fail',
            'state',
            {state: 'confusion'}
        ],
        [
            'invalid owner_uuid should fail',
            'owner_uuid',
            {owner_uuid: '%'}
        ]
    ];
    var idx;

    function invalidShouldBeRejected(params) {
        var invalidWhat = params[1];
        var listArgs = params[2];
        var testName = params[0];

        tt.test(testName, function (t) {
            API_CLIENTS.volapi.listVolumes(listArgs,
                function onListVolumes(err, req, res, obj) {
                    t.ok(err, 'listing volumes with invalid ' + invalidWhat
                        + ' should error');
                    t.equal(err.restCode, 'ValidationError',
                        'error should be ValidationError');
                    t.end();
                });
        });
    }

    for (idx = 0; idx < badParameters.length; idx++) {
        invalidShouldBeRejected(badParameters[idx]);
    }

    tt.test('conflicting predicate and query param should fail',
        function (t) {
            var predicate = {
                eq: ['name', 'mechagodzilla']
            };

            API_CLIENTS.volapi.listVolumes({
                name: 'godzilla',
                predicate: JSON.stringify(predicate)
            }, function onListVolumes(err, req, res, obj) {
                t.ok(err,
                    'listing volumes with invalid predicate should error');
                t.equal(err.restCode, 'ValidationError',
                    'error should ValidationError');
                t.end();
            });
        });
});

test('listing nfs shared volumes with simple parameters', function (tt) {
    var snowflakeName0 = resources.makeResourceName('dummy-'
        + VOLUMES_NAMES_PREFIX + '-empty0') + '-foo';
    var snowflakeName1 =
        resources.makeResourceName(VOLUMES_NAMES_PREFIX + '-empty1') + '-foo';
    var snowflakeName2 =
        resources.makeResourceName(VOLUMES_NAMES_PREFIX + '-empty2') + '-foo';

    var testVolumeObjects = [
        {
            name: snowflakeName0,
            owner_uuid: UFDS_ADMIN_UUID,
            size: 10240,
            state: 'creating',
            type: 'tritonnfs',
            uuid: libuuid.create()
        },
        {
            name: snowflakeName1,
            owner_uuid: UFDS_ADMIN_UUID,
            size: 102400,
            state: 'ready',
            type: 'tritonnfs',
            uuid: libuuid.create()
        },
        {
            name: snowflakeName2,
            owner_uuid: ALTERNATE_OWNER_UUID,
            size: 1024000,
            state: 'failed',
            type: 'tritonnfs',
            uuid: libuuid.create()
        }
    ];

    function snowflakeName(strName) {
        switch (strName) {
            case 'snowflakeName0':
                return snowflakeName0;
            case 'snowflakeName1':
                return snowflakeName1;
            case 'snowflakeName2':
                return snowflakeName2;
            default:
                return 'unknown volume';
        }
    }

    function shouldFind(t, volumes, expected, notExpected, expectedNumber) {
        var foundVolumes = [];
        var idx;

        t.ok(Array.isArray(volumes), 'response body should be an array');
        if (expectedNumber !== undefined) {
            t.equal(volumes.length, expectedNumber, expectedNumber +
                ' volume(s) should be included in the response body');
        }

        volumes.forEach(function checkVolume(vol) {
            switch (vol.name) {
                case snowflakeName0:
                    foundVolumes.push('snowflakeName0');
                    break;
                case snowflakeName1:
                    foundVolumes.push('snowflakeName1');
                    break;
                case snowflakeName2:
                    foundVolumes.push('snowflakeName2');
                    break;
                default:
                    foundVolumes.push('unknownName');
                    break;
            }
        });

        for (idx = 0; idx < expected.length; idx++) {
            t.ok(foundVolumes.indexOf(expected[idx]) !== -1,
                'should have found ' + snowflakeName(expected[idx]));
        }

        for (idx = 0; idx < notExpected.length; idx++) {
            t.ok(foundVolumes.indexOf(notExpected[idx]) === -1,
                'should not have found ' + snowflakeName(notExpected[idx]));
        }

        return (foundVolumes);
    }

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
                                'listing volumes with an empty predicate '
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
                        + 'same number of volumes as listing from the models '
                        + 'layer with no search params ('
                        + volumesListedFromMoray.length + '/'
                        + volumesListedWithEmptyPredicate.length + ')');
                t.end();
            });
        });

    tt.test('list with exact name returns 1 volume',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                name: snowflakeName1
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with a name param should not '
                    + 'error');
                if (volumes !== undefined) {
                    t.ok(Array.isArray(volumes),
                        'response body should be an array');
                    t.equal(volumes.length, 1,
                        'only one volume should be included in the response '
                        + 'body');
                    t.equal(volumes[0].name, snowflakeName1,
                        'the name of the volume returned in the response '
                        + 'should be: ' + snowflakeName1 + ', got: '
                        + volumes[0].name);
                } else {
                    t.ok(false, 'no volumes returned by listVolumes');
                }
                t.end();
            });
        });

    tt.test('list with name=*-foo returns 3 volumes',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                name: '*-foo'
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with a name param should not '
                    + 'error');

                if (volumes !== undefined) {
                    shouldFind(t, volumes, [
                        // expected to find
                        'snowflakeName0',
                        'snowflakeName1',
                        'snowflakeName2'
                    ], [
                        // expected to not find
                        'unknownName'
                    ], 3);
                } else {
                    t.ok(false, 'no volumes returned from listVolumes');
                }

                t.end();
            });
        });

    tt.test('list with name=' + VOLUMES_NAMES_PREFIX + '-* returns 2 volumes',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                name: VOLUMES_NAMES_PREFIX + '-*'
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with a name param should not '
                    + 'error');

                if (volumes !== undefined) {
                    shouldFind(t, volumes, [
                        // expected to find
                        'snowflakeName1',
                        'snowflakeName2'
                    ], [
                        // expected to not find
                        'snowflakeName0',
                        'unknownName'
                    ], 2);
                } else {
                    t.ok(false, 'no volumes returned from listVolumes');
                }

                t.end();
            });
        });

    tt.test('list with state=creating returns 1 of our volumes',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                state: 'creating'
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with a state param should not '
                    + 'error');

                if (volumes !== undefined) {
                    shouldFind(t, volumes, [
                        // expected to find
                        'snowflakeName0'
                    ], [
                        // expected to not find
                        'snowflakeName1', // state=ready
                        'snowflakeName2'  // state=failed
                    ]);
                } else {
                    t.ok(false, 'no volumes returned from listVolumes');
                }

                t.end();
            });
        });

    tt.test('list with owner_uuid=' + ALTERNATE_OWNER_UUID
        + ' returns 1 of our volumes',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                owner_uuid: ALTERNATE_OWNER_UUID
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with an owner_uuid param should'
                    + ' not error');

                if (volumes !== undefined) {
                    shouldFind(t, volumes, [
                        // expected to find
                        'snowflakeName2'
                    ], [], 1);
                } else {
                    t.ok(false, 'no volumes returned from listVolumes');
                }

                t.end();
            });
        });

    tt.test('list with type=tritonnfs returns volumes',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                type: 'tritonnfs'
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with type=tritonnfs should'
                    + ' not error');
                t.ok(Array.isArray(volumes),
                    'response body should be an array');
                t.ok(volumes.length >= 3, 'should have at least 3 volumes, '
                    + 'found: ' + volumes.length);

                t.end();
            });
        });

    // NOTE: testing with both string and number here really doesn't do anything
    // since the number will be stringified. But the two tests use different
    // sizes and confirm that they get different results, so that's still
    // valuable.

    tt.test('list with size=102400 (number) returns correct volume',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                size: 102400
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with size=102400 should'
                    + ' not error');

                if (volumes !== undefined) {
                    shouldFind(t, volumes, [
                        // expected to find
                        'snowflakeName1'
                    ], [
                        // expected to not find
                        'snowflakeName0',
                        'snowflakeName2'
                    ]);
                } else {
                    t.ok(false, 'no volumes returned from listVolumes');
                }

                t.end();
            });
        });

    tt.test('list with size=1024000 (string) returns correct volume',
        function (t) {
            API_CLIENTS.volapi.listVolumes({
                size: '1024000'
            }, function onListVolumes(err, volumes) {
                t.ifErr(err, 'listing volumes with size=1024000 should'
                    + ' not error');

                if (volumes !== undefined) {
                    shouldFind(t, volumes, [
                        // expected to find
                        'snowflakeName2'
                    ], [
                        // expected to not find
                        'snowflakeName0',
                        'snowflakeName1'
                    ]);
                } else {
                    t.ok(false, 'no volumes returned from listVolumes');
                }

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
