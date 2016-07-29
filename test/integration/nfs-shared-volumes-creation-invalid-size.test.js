/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var test = require('tape');
var vasync = require('vasync');

var configLoader = require('../../lib/config-loader');

var clientsSetup = require('./lib/clients-setup');
var resources = require('./lib/resources');
var testVolumes = require('./lib/volumes');

var CONFIG = configLoader.loadConfigSync();

var UFDS_ADMIN_UUID = CONFIG.ufdsAdminUuid;
assert.string(UFDS_ADMIN_UUID, 'UFDS_ADMIN_UUID');

var CLIENTS;
var NFS_SHARED_VOLUMES_NAMES_PREFIX = 'nfs-shared-volumes';
var NFS_SHARED_VOLUMES_TYPE_NAME = 'tritonnfs';

var NETWORKS;

test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.end();
        });
    });

    tt.test('setup networks', function (t) {
        CLIENTS.napi.get('/networks',
            function onListNetworks(err, networks) {
                t.ifError(err);
                t.ok(networks);
                t.ok(Array.isArray(networks));
                t.ok(networks.length > 1);
                NETWORKS = networks;
                t.end();
            });
    });
});

test('NFS shared volume creation with invalid size', function (tt) {
    var volumeName =
        resources.makeResourceName(NFS_SHARED_VOLUMES_NAMES_PREFIX);

    tt.test('creating a nfs shared volume with invalid size should fail',
        function (t) {
            var INVALID_SIZES = ['invalid-size', '%$%#$%', ''];

            vasync.forEachParallel({
                func: createVolumeWithInvalidSize,
                inputs: INVALID_SIZES
            }, function invalidSizesTested(err, results) {
                t.end();
            });

            function createVolumeWithInvalidSize(invalidSize, callback) {
                assert.string(invalidSize, 'invalidSize');
                assert.func(callback, 'callback');

                var expectedErrMsg = 'Validation error, causes: Error: size "'
                    + invalidSize + '" is not a valid volume size';

                var volumeParams = {
                    name: volumeName,
                    owner_uuid: UFDS_ADMIN_UUID,
                    type: NFS_SHARED_VOLUMES_TYPE_NAME,
                    networks: [NETWORKS[0].uuid],
                    size: invalidSize
                };

                CLIENTS.volapi.createVolume(volumeParams,
                    function onVolumeCreated(err, volume) {
                        t.ok(err, 'volume creation should result in an error');
                        t.ok(err.message.indexOf(expectedErrMsg) !== -1,
                            'Error message should be: ' + expectedErrMsg);

                        callback();
                    });
            }
        });
});