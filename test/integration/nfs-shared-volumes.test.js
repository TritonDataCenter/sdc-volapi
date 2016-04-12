/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var child_process = require('child_process');
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var libuuid = require('libuuid');
var mkdirp = require('mkdirp');
var test = require('tape');
var vasync = require('vasync');

var configLoader = require('../../lib/config-loader');

var clientsSetup = require('./lib/clients-setup');
var resources = require('./lib/resources');

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

test('nfs shared volumes', function (tt) {
    var volumeName =
        resources.makeResourceName(NFS_SHARED_VOLUMES_NAMES_PREFIX);
    var sharedNfsVolume;
    var nfsRemotePath;
    var mountPoint;

    tt.test('creating a simple nfs shared volume should succeed', function (t) {
        var volumeParams = {
            name: volumeName,
            owner_uuid: UFDS_ADMIN_UUID,
            type: NFS_SHARED_VOLUMES_TYPE_NAME,
            networks: [NETWORKS[0].uuid]
        };

        CLIENTS.vapi.createVolume({
            payload: volumeParams,
            sync: true
        }, function onVolumeCreated(err, volume) {
            t.ifErr(err, 'volume should have been created successfully');
            t.equal(volume.name, volumeName, 'volume name should be '
                + volumeName);

            sharedNfsVolume = volume;
            t.end();
        });
    });

    tt.test('newly created shared volume not listed int VMAPI ListVms output '
        + 'by default', function (t) {
        CLIENTS.vmapi.listVms(function onListVms(err, vms) {
            t.ifErr(err, 'listing VMs should not error');

            var filteredVms = vms.filter(function selectSharedVolume(vm) {
                if (vm.uuid === sharedNfsVolume.vm_uuid) {
                    return true;
                }

                return false;
            });
            t.equal(filteredVms.length, 0,
                'newly created volume VM should not be present');
            t.end();
        });
    });

    tt.test('mounting the shared volume via NFS suceeds', function (t) {
        nfsRemotePath = sharedNfsVolume.filesystem_path;
        mountPoint = path.join('/mnt', libuuid.create());

        vasync.pipeline({funcs: [
            function createMountPointDir(args, next) {
                mkdirp(mountPoint, function onMkdirpDone(err) {
                    t.ifErr(err,
                        'mountpoint dir should be created successfully');
                    next();
                });
            },
            function mountNfsPath(args, next) {
                child_process.exec([
                    'mount -F nfs', nfsRemotePath, mountPoint
                ].join(' '), function onNfsMountDone(err, stdout, stderr) {
                    t.ifErr(err, 'mounting the NFS remote fs should not error');
                    next();
                });
            }
        ]}, function onMountVolumeDone(err) {
            t.end();
        });
    });

    tt.test('unmounting the shared volume via NFS suceeds', function (t) {
        child_process.exec(['umount', mountPoint ].join(' '),
            function onMountDone(err, stdout, stderr) {
                t.ifErr(err, 'unmounting the NFS remote fs should not error');
                t.end();
            });
    });

    tt.test('newly created volume should show up in list endpoint',
        function (t) {
            CLIENTS.vapi.listVolumes(function onVolumesListed(err, volumes) {
                var newlyCreatedVolumeFound = false;

                function isNewlyCreatedVolume(volume) {
                    return volume.uuid = sharedNfsVolume.uuid;
                }

                t.ifErr(err, 'listVolumes should not error');
                newlyCreatedVolumeFound = volumes.some(isNewlyCreatedVolume);
                t.ok(newlyCreatedVolumeFound,
                    'newly created volume should be listed');
                t.end();
            });
        });

    tt.test('cleanup', function (t) {
        vasync.parallel({funcs: [
            function deleteSharedVolume(done) {
                CLIENTS.vapi.deleteVolume({
                    uuid: sharedNfsVolume.uuid,
                    owner_uuid: UFDS_ADMIN_UUID
                }, function onVolumeDeleted(err) {
                    t.ifErr(err,
                        'volume should have been deleted without error');
                    done();
                });
            },
            function removeMountPointDirectory(done) {
                fs.rmdir(mountPoint, function onMountPointDeleted(err) {
                    t.ifErr(err,
                        'mountpoint should have been deleted without erorr');
                     done();
                });
            }
        ]}, function cleanupDone(err) {
            t.end();
        });
    });
});