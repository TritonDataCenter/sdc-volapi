/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var test = require('tape');
var vasync = require('vasync');

var clientsSetup = require('./lib/clients-setup');
var configLoader = require('../../lib/config-loader');
var resources = require('./lib/resources');

var ADMIN_OWNED_FABRIC_NETWORK_UUID;
var CLIENTS;
var CONFIG = configLoader.loadConfigSync();
var CREATED_VOLUMES = []; // volumes we created and need to destroy
var NFS_SHARED_VOLUMES_NAMES_PREFIX = 'nfs-shared-volumes';
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

test('NFS shared volume creation with missing "name"', function (tt) {
    tt.test('creating a nfs shared volume w/o name should generate one',
        function (t) {
            var COMMON_PAYLOAD = {
                owner_uuid: UFDS_ADMIN_UUID,
                type: NFS_SHARED_VOLUMES_TYPE_NAME,
                networks: [ADMIN_OWNED_FABRIC_NETWORK_UUID]
            };
            var EMPTY_NAME_PAYLOAD = JSON.parse(JSON.stringify(COMMON_PAYLOAD));
            var MISSING_NAME_PAYLOADS;

            EMPTY_NAME_PAYLOAD.name = '';

            MISSING_NAME_PAYLOADS = [
                COMMON_PAYLOAD,
                EMPTY_NAME_PAYLOAD
            ];

            vasync.forEachParallel({
                func: createVolumeWithMissingName,
                inputs: MISSING_NAME_PAYLOADS
            }, function missingNamesTested(err, results) {
                t.end();
            });

            function createVolumeWithMissingName(volumeParams, callback) {
                assert.func(callback, 'callback');

                CLIENTS.volapi.createVolumeAndWait(volumeParams,
                    function onVolumeCreated(err, volume) {
                        t.ifErr(err, 'volume creation (name='
                            + JSON.stringify(volumeParams.name)
                            + ') should succeed');

                        t.equal(volume.name.length, 64,
                            'expected 64 character name');
                        t.ok(volume.name.match(/^[a-f0-9]*$/),
                            'expected ^[a-f0-9]*$');
                        t.equal(volume.name.substr(0, 32),
                            volume.uuid.replace(/\-/g, ''),
                            'expected uuid to match first 32 chars of volume '
                                + 'name');

                        CREATED_VOLUMES.push(volume.uuid);

                        callback();
                    });
            }
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
