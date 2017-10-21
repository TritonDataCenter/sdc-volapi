/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var child_process = require('child_process');
var libuuid = require('libuuid');
var test = require('tape');
var util = require('util');

var configLoader = require('../../lib/config-loader');
var clientsSetup = require('./lib/clients-setup');
var resources = require('./lib/resources');
var testVolumes = require('./lib/volumes');

var ADMIN_OWNED_FABRIC_NETWORK_UUID;
var CLIENTS;
var CONFIG = configLoader.loadConfigSync();
var IMAGE_UUID;
var KEY_FILENAME = '/tmp/volapi-test-key';
var NETWORKS;
var NFS_SHARED_VOLUMES_NAMES_PREFIX = 'nfs-shared-volumes';
var NFS_SHARED_VOLUMES_VM_NAME_PREFIX = 'test-nfs-shared-volumes-mounter';
var NFS_SHARED_VOLUMES_TYPE_NAME = 'tritonnfs';
var SDC_128_UUID;
var UFDS_ADMIN_UUID = CONFIG.ufdsAdminUuid;

assert.string(UFDS_ADMIN_UUID, 'UFDS_ADMIN_UUID');

test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.end();
        });
    });

    tt.test('find fabric network', function (t) {
        CLIENTS.napi.get('/networks?owner_uuid=' + UFDS_ADMIN_UUID,
            function onListNetworks(err, networks) {
                t.ifError(err, 'should have succeeded to list networks');
                t.ok(networks, 'should have found networks');
                t.ok(Array.isArray(networks), 'networks should be an array');
                t.ok(networks.length >= 1, 'should have at least 1 network');
                networks.forEach(function findAdminNetwork(network) {
                    if (!ADMIN_OWNED_FABRIC_NETWORK_UUID &&
                        network && network.fabric) {
                        ADMIN_OWNED_FABRIC_NETWORK_UUID = network.uuid;
                    }
                });
                t.ok(ADMIN_OWNED_FABRIC_NETWORK_UUID,
                    'found admin-owned fabric network: ' +
                    ADMIN_OWNED_FABRIC_NETWORK_UUID);
                t.end();
            });
    });

    /*
     * We use the origin image from the volapi image here since we know that
     * image will be installed (if volapi is installed) and we really don't care
     * what the dataset actually is.
     */
    tt.test('finding image', function (t) {
        child_process.exec([
            'mdata-get',
            'sdc:image_uuid'
        ].join(' '), function onGotImageUuid(err, stdout, stderr) {
            t.ifErr(err, 'mdata-get sdc:image_uuid should succeed');
            IMAGE_UUID = stdout.trim();
            t.ok(IMAGE_UUID, 'should have found image_uuid, got: ' +
                JSON.stringify(IMAGE_UUID));
            t.end();
        });
    });

    tt.test('finding package', function (t) {
        CLIENTS.papi.list({name: 'sdc_128'}, {},
            function onPackageList(err, pkgs) {
                t.ifErr(err, 'expected list packages to succeed');
                t.ok(pkgs, 'expected to get packages');
                t.ok(Array.isArray(pkgs), 'packages should be an array');
                t.ok(pkgs.length >= 1, 'should have at least 1 package');
                SDC_128_UUID = pkgs[0].uuid;
                t.ok(SDC_128_UUID, 'should have found pkg uuid, got: ' +
                    JSON.stringify(SDC_128_UUID));
                t.end();
            });
    });

});

test('nfs shared volumes', function (tt) {
    var sharedNfsVolume;
    var volumeName =
        resources.makeResourceName(NFS_SHARED_VOLUMES_NAMES_PREFIX);

    tt.test('creating a simple nfs shared volume should succeed', function (t) {
        var volumeParams = {
            name: volumeName,
            owner_uuid: UFDS_ADMIN_UUID,
            type: NFS_SHARED_VOLUMES_TYPE_NAME,
            networks: [ADMIN_OWNED_FABRIC_NETWORK_UUID]
        };

        CLIENTS.volapi.createVolumeAndWait(volumeParams,
            function onVolumeCreated(err, volume) {
                t.ifErr(err, 'volume should have been created successfully');
                t.equal(volume.name, volumeName, 'volume name should be '
                    + volumeName);

                testVolumes.checkVolumeObjectFormat(volume, {
                    type: 'tritonnfs',
                    name: volumeName
                }, t);

                sharedNfsVolume = volume;
                t.end();
            });
    });

    tt.test('GETing newly created volume with proper owner uuid should succeed',
        function (t) {
            CLIENTS.volapi.getVolume({
                uuid: sharedNfsVolume.uuid,
                owner_uuid: UFDS_ADMIN_UUID
            }, function onGetVol(getVolErr, volume) {
                t.ifErr(getVolErr, 'GETing volume should not error');
                t.ok(volume, 'response should not be empty');
                if (volume) {
                    t.equal(volume.uuid, sharedNfsVolume.uuid,
                        'volume UUID should be ' + sharedNfsVolume.uuid +
                            ', got: ' + volume.uuid);
                    t.equal(volume.owner_uuid, UFDS_ADMIN_UUID,
                        'volume owner_uuid should be ' + UFDS_ADMIN_UUID +
                            ', got: ' + volume.owner_uuid);
                }

                t.end();
            });
        });

    tt.test('GETing created volume with different owner uuid should error',
        function (t) {
            var expectedErrorName = 'VolumeNotFoundError';

            CLIENTS.volapi.getVolume({
                uuid: sharedNfsVolume.uuid,
                owner_uuid: libuuid.create()
            }, function onGetVol(getVolErr, volume) {
                t.ok(getVolErr, 'GETing volume should error');
                if (getVolErr) {
                    t.equal(getVolErr.name, expectedErrorName,
                        'Error name should be: ' + expectedErrorName +
                            ', got: ' + getVolErr.name);
                }

                t.end();
            });
        });

    tt.test('cleanup', function (t) {
        CLIENTS.volapi.deleteVolumeAndWait({
            owner_uuid: UFDS_ADMIN_UUID,
            uuid: sharedNfsVolume.uuid
        }, function onVolumeDeleted(err) {
            t.ifErr(err,
                'volume should have been deleted without error');
            t.end();
        });
    });
});
