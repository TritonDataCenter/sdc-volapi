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
var UFDS_ADMIN_FABRIC_NETWORK;

test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.end();
        });
    });

    tt.test('setup networks', function (t) {
        CLIENTS.napi.get('/networks?owner_uuid=' + UFDS_ADMIN_UUID +
            '&fabric=true',
            function onListNetworks(err, networks) {
                t.ifError(err, 'listing fabric networks for owner ' +
                    UFDS_ADMIN_UUID + ' should not error');
                t.ok(networks, 'listing fabric networks for owner ' +
                    UFDS_ADMIN_UUID + ' should result in a non-empty list of ' +
                    'networks');
                t.ok(Array.isArray(networks),
                    'list of networks should be an array');
                t.ok(networks.length === 1, 'owner ' + UFDS_ADMIN_UUID +
                    ' should have only 1 fabric network');

                UFDS_ADMIN_FABRIC_NETWORK = networks[0];

                t.end();
            });
    });
});

test('NFS shared volume creation with invalid size', function (tt) {
    var volumeName =
        resources.makeResourceName(NFS_SHARED_VOLUMES_NAMES_PREFIX);

    tt.test('creating a nfs shared volume with invalid size should fail',
        function (t) {
            var INVALID_SIZES = ['invalid-size', '%$%#$%', '', 0, -42];

            vasync.forEachParallel({
                func: createVolumeWithInvalidSize,
                inputs: INVALID_SIZES
            }, function invalidSizesTested(err, results) {
                t.end();
            });

            function createVolumeWithInvalidSize(invalidSize, callback) {
                assert.func(callback, 'callback');

                var expectedErrMsg = 'Validation error, causes: Error: ' +
                    'Volume size: "' + invalidSize + '" is not a valid ' +
                    'volume size';

                var volumeParams = {
                    name: volumeName,
                    owner_uuid: UFDS_ADMIN_UUID,
                    type: NFS_SHARED_VOLUMES_TYPE_NAME,
                    networks: [UFDS_ADMIN_FABRIC_NETWORK.uuid],
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

test('NFS shared volume creation with unavailable size', function (tt) {
    var volumeName =
        resources.makeResourceName(NFS_SHARED_VOLUMES_NAMES_PREFIX);

    tt.test('creating nfs shared volume with unavailable size should fail',
        function (t) {
            vasync.pipeline({arg: {}, funcs: [
                function getVolumeSizes(ctx, next) {
                    CLIENTS.volapi.listVolumeSizes(
                        function onListVolSizes(listVolSizesErr, volSizes) {
                            t.ifError(listVolSizesErr,
                                'listing volume sizes should not error');

                            if (listVolSizesErr) {
                                next(listVolSizesErr);
                                return;
                            }

                            t.ok(volSizes && volSizes.length > 0,
                                'there should be at least one ' +
                                    'available volume size');

                            if (!volSizes || volSizes.length === 0) {
                                next(new Error('Could not find vol sizes'));
                            } else {
                                ctx.availableSizes =
                                    volSizes.map(function getSize(volSize) {
                                        return volSize.size;
                                    });
                                next();
                            }
                        });
                },
                function createVolWithUnavailableSize(ctx, next) {
                    var expectedErrorCode;
                    var expectedErrMsg;
                    var expectedErrorName;
                    var volumeSizeTooBig;

                    assert.arrayOfNumber(ctx.availableSizes,
                            'ctx.availableSizes');

                    ctx.availableSizes.sort(function numSort(a, b) {
                        if (a > b) {
                            return 1;
                        } else if (a < b) {
                            return -1;
                        }

                        return 0;
                    });

                    volumeSizeTooBig =
                        ctx.availableSizes[ctx.availableSizes.length - 1] + 1;

                    expectedErrorCode = 'VolumeSizeNotAvailable';
                    expectedErrMsg = 'Volume size ' + volumeSizeTooBig +
                        ' is not available';
                    expectedErrorName = 'VolumeSizeNotAvailableError';

                    var volumeParams = {
                        name: volumeName,
                        owner_uuid: UFDS_ADMIN_UUID,
                        type: NFS_SHARED_VOLUMES_TYPE_NAME,
                        networks: [UFDS_ADMIN_FABRIC_NETWORK.uuid],
                        size: volumeSizeTooBig
                    };

                    CLIENTS.volapi.createVolume(volumeParams,
                        function onVolumeCreated(err, volume) {
                            t.ok(err,
                                'volume creation should result in an error');
                            t.ok(err.message.indexOf(expectedErrMsg) !== -1,
                                'Error message should be: ' + expectedErrMsg);
                            t.equal(err.restCode, expectedErrorCode,
                                'Error restCode should be ' +
                                    expectedErrorCode);
                            t.equal(err.body.code, expectedErrorCode,
                                'Error\'s body\'s code should be ' +
                                    expectedErrorCode);
                            t.equal(err.name, expectedErrorName,
                                'Error name should be ' +
                                    expectedErrorName);
                            next();
                        });
                }
            ]}, function onTestDone() {
                t.end();
            });
        });
});