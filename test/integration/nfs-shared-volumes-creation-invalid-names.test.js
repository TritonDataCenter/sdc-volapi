/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var test = require('tape');
var vasync = require('vasync');

var clientsSetup = require('./lib/clients-setup');
var configLoader = require('../../lib/config-loader');

var ADMIN_OWNED_FABRIC_NETWORK_UUID;
var CLIENTS;
var CONFIG = configLoader.loadConfigSync();
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

test('NFS shared volume creation with invalid names', function (tt) {
    tt.test('creating nfs shared volumes with invalid name should fail',
        function (t) {
            var COMMON_PAYLOAD = {
                owner_uuid: UFDS_ADMIN_UUID,
                type: NFS_SHARED_VOLUMES_TYPE_NAME,
                networks: [ADMIN_OWNED_FABRIC_NETWORK_UUID]
            };
            /*
             * 'x'.repeat(257) generates a volume name that is one character too
             * long, as the max length for volume names is 256 characters.
             */
            var INVALID_NAMES = ['', '-foo', '.foo', 'x'.repeat(257)];

            vasync.forEachParallel({
                func: function createVolume(volumeName, done) {
                    var createVolumeParams = jsprim.deepCopy(COMMON_PAYLOAD);
                    createVolumeParams.name = volumeName;

                    CLIENTS.volapi.createVolumeAndWait(createVolumeParams,
                        function onVolumeCreated(err, volume) {
                            var expectedErrMsg = 'volume name';

                            t.ok(err, 'volume creation with name ' +
                                createVolumeParams.name + ' should error');
                            if (err) {
                                t.notEqual(err.message.indexOf(expectedErrMsg),
                                    -1, 'error message should include ' +
                                        expectedErrMsg + ', got: ' +
                                        err.message);
                            }
                            done();
                        });
                },
                inputs: INVALID_NAMES
            }, function invalidNamesTested(err, results) {
                t.end();
            });
        });
});
