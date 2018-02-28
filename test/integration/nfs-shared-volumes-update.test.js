/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');
var test = require('tape');
var util = require('util');
var vasync = require('vasync');

var clientsSetup = require('./lib/clients-setup');
var configLoader = require('../../lib/config-loader');

var ADMIN_OWNED_FABRIC_NETWORK_UUID;
var CLIENTS;
var CONFIG = configLoader.loadConfigSync();
var CREATED_VOLUMES = []; // volumes we created and need to destroy
var NFS_SHARED_VOLUMES_NAMES_PREFIX = 'test-nfs-shared-volumes-update';
var NFS_SHARED_VOLUMES_TYPE_NAME = 'tritonnfs';
var UFDS_ADMIN_UUID = CONFIG.ufdsAdminUuid;

assert.string(UFDS_ADMIN_UUID, 'UFDS_ADMIN_UUID');

test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.end();
        });
    });

    tt.test('setup networks', function (t) {
        CLIENTS.napi.get('/networks?owner_uuid=' + UFDS_ADMIN_UUID,
            function onListNetworks(err, networks) {
                var idx;

                t.ifError(err, 'expected success listing networks');
                t.ok(networks, 'got networks from NAPI');
                t.ok(Array.isArray(networks),
                    'networks object from NAPI is an array');
                t.ok(networks.length > 1, 'expected more than 1 NAPI network');

                for (idx = 0; idx < networks.length &&
                    !ADMIN_OWNED_FABRIC_NETWORK_UUID; idx++) {
                    if (networks[idx].fabric) {
                        ADMIN_OWNED_FABRIC_NETWORK_UUID = networks[idx].uuid;
                    }
                }

                t.ok(ADMIN_OWNED_FABRIC_NETWORK_UUID,
                    'expected to find admin-owned fabric network, got: ' +
                    ADMIN_OWNED_FABRIC_NETWORK_UUID);

                t.end();
            });
    });
});

test('Updating NFS shared volumes', function (tt) {
    var UPDATED_VOLUME_NAME =
        NFS_SHARED_VOLUMES_NAMES_PREFIX + '-' + libuuid.create();

    tt.test('creating a nfs shared volume should succeed',
        function (t) {
            var CREATE_VOL_PAYLOAD = {
                owner_uuid: UFDS_ADMIN_UUID,
                type: NFS_SHARED_VOLUMES_TYPE_NAME,
                networks: [ADMIN_OWNED_FABRIC_NETWORK_UUID]
            };

            CLIENTS.volapi.createVolumeAndWait(CREATE_VOL_PAYLOAD,
                function onVolumeCreated(err, volume) {
                    t.ifErr(err, 'volume creation with no name should succeed');

                    t.equal(volume.name.length, 64,
                        'expected 64 character name');
                    t.ok(volume.name.match(/^[a-f0-9]*$/),
                        'expected ^[a-f0-9]*$');
                    t.equal(volume.name.substr(0, 32),
                        volume.uuid.replace(/\-/g, ''),
                        'expected uuid to match first 32 chars of volume '
                            + 'name');

                    CREATED_VOLUMES.push(volume.uuid);

                    t.end();
                });
        });

    tt.test('updating created volume with name should succeed', function (t) {
        vasync.pipeline({funcs: [
            function updateVol(_, next) {
                CLIENTS.volapi.updateVolume({
                    uuid: CREATED_VOLUMES[0],
                    name: UPDATED_VOLUME_NAME
                }, next);
            },
            function checkVolumeUpdated(_, next) {
                CLIENTS.volapi.getVolume({
                    uuid: CREATED_VOLUMES[0]
                }, function onGetVol(getVolErr, vol) {
                    t.ifError(getVolErr,
                        'getting updated volume should succeed, got error: ' +
                            getVolErr);
                    t.ok(vol, 'response should not be empty');
                    if (vol) {
                        t.equal(vol.name, UPDATED_VOLUME_NAME,
                            'volume name should have been updated to ' +
                                UPDATED_VOLUME_NAME + ' and is: ' + vol.name);
                    }

                    next();
                });
            }
        ]}, function onDone(err) {
            t.end();
        });
    });

    tt.test('updating volume without name should succeed', function (t) {
        vasync.pipeline({funcs: [
            function updateVol(_, next) {
                CLIENTS.volapi.updateVolume({
                    uuid: CREATED_VOLUMES[0]
                }, function onUpdateVol(updateVolErr) {
                    t.ifError(updateVolErr, 'updating volume should succeed');
                    next(updateVolErr);
                });
            },
            function checkVolumeUnchanged(_, next) {
                CLIENTS.volapi.getVolume({
                    uuid: CREATED_VOLUMES[0]
                }, function onGetVol(getVolErr, vol) {
                    t.ifError(getVolErr,
                        'getting updated volume should succeed, got error: ' +
                            getVolErr);
                    t.ok(vol, 'response should not be empty');
                    if (vol) {
                        t.equal(vol.name, UPDATED_VOLUME_NAME,
                            'volume name should still be ' +
                                UPDATED_VOLUME_NAME + ' and is: ' + vol.name);
                    }

                    next();
                });
            }
        ]}, function onDone(err) {
            t.end();
        });
    });

    tt.test('updating volume with invalid name should fail', function (t) {
        var INVALID_PARAMS = [
            {name: ''},
            {name: '%foobar%'}
        ];

        vasync.forEachParallel({
            func: function updateVol(updateParams, done) {
                updateParams.uuid = CREATED_VOLUMES[0];

                CLIENTS.volapi.updateVolume(updateParams,
                    function onUpdateVol(updateVolErr) {
                        var EXPECTED_ERR = {
                            jse_shortmsg: '',
                            jse_info: {},
                            message: 'Validation error, causes: Error: ' +
                                'volume name must match ' +
                                '/^[a-zA-Z0-9][a-zA-Z0-9_\\.\\-]+$/',
                            statusCode: 409,
                            body: {
                                code: 'ValidationError',
                                message: 'Validation error, causes: Error: ' +
                                    'volume name must match ' +
                                    '/^[a-zA-Z0-9][a-zA-Z0-9_\\.\\-]+$/' },
                            restCode: 'ValidationError',
                            name: 'ValidationError'
                        };

                        t.deepEqual(updateVolErr, EXPECTED_ERR,
                            'error should be present and match: ' +
                                util.inspect(EXPECTED_ERR));

                        done();
                    });
            },
            inputs: INVALID_PARAMS
        }, function allTestsDone(err) {
            t.end();
        });
    });

    tt.test('updating volume with invalid param should fail', function (t) {
        var EXPECTED_ERR = {
            jse_shortmsg: '',
            jse_info: {},
            message: 'Validation error, causes: Error: ' +
                'invalid parameter: foo',
            statusCode: 409,
            body: {
                code: 'ValidationError',
                message: 'Validation error, causes: Error: ' +
                    'invalid parameter: foo' },
            restCode: 'ValidationError',
            name: 'ValidationError'
        };

        var UPDATE_PARAMS = {
            uuid: CREATED_VOLUMES[0],
            foo: 'bar'
        };

        CLIENTS.volapi.updateVolume(UPDATE_PARAMS,
            function onUpdateVol(updateVolErr) {
                t.deepEqual(updateVolErr, EXPECTED_ERR,
                    'error should be present and match: ' +
                        util.inspect(EXPECTED_ERR));
                t.end();
            });
    });
});

test('teardown', function (tt) {
    tt.test('cleanup', function (t) {
        vasync.forEachParallel({
            func: function deleteVolume(volumeUuid, done) {
                CLIENTS.volapi.deleteVolumeAndWait({
                    uuid: volumeUuid,
                    owner_uuid: UFDS_ADMIN_UUID
                }, function onVolumeDeleted(err) {
                    t.ifErr(err, 'delete volume ' + volumeUuid);
                    done();
                });
            },
            inputs: CREATED_VOLUMES
        }, function cleanupDone(err) {
            t.end();
        });
    });
});
