/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var child_process = require('child_process');
var fs = require('fs');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var libuuid = require('libuuid');
var mkdirp = require('mkdirp');
var test = require('tape');
var vasync = require('vasync');

var configLoader = require('../../lib/config-loader');
var clientsSetup = require('./lib/clients-setup');
var resources = require('./lib/resources');
var testVolumes = require('./lib/volumes');

var ADMIN_NETWORK_UUID;
var ADMIN_OWNED_FABRIC_NETWORK_UUID;
var CLIENTS;
var CONFIG = configLoader.loadConfigSync();
/*
 * This regular expression is not meant to match the general ISO 8601 format,
 * only the specific format outputted by new Date().toISOString().
 */
var IMAGE_UUID;
var ISO_DATE_STRING_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
var KEY_FILENAME = '/tmp/volapi-test-key';
var NETWORKS;
var NFS_SHARED_VOLUMES_NAMES_PREFIX = 'nfs-shared-volumes';
var NFS_SHARED_VOLUMES_VM_NAME_PREFIX = 'test-nfs-shared-volumes-mounter';
var NFS_SHARED_VOLUMES_TYPE_NAME = 'tritonnfs';
var SDC_128_UUID;
var SSH_PUBLIC_KEY;
var UFDS_ADMIN_UUID = CONFIG.ufdsAdminUuid;
var VM_ADMIN_IP;
var VM_UUID = libuuid.create();
var VOLUME_LABELS = {
    'firstlabel': 'this is the first label',
    'second label': 'this is the second label'
};

assert.string(UFDS_ADMIN_UUID, 'UFDS_ADMIN_UUID');

function deleteKeypair(cb) {
    child_process.exec([
        'rm',
        '-f',
        KEY_FILENAME,
        KEY_FILENAME + '.pub'
    ].join(' '), function onKeyPairDeleted(err, stdout, stderr) {
        cb(err);
    });
}

test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.end();
        });
    });

    // need admin network so we can ssh to it from volapi (where we're running)
    tt.test('find admin network', function (t) {
        CLIENTS.napi.get('/networks?name=admin',
            function onListNetworks(err, networks) {
                t.ifError(err, 'should have succeeded to list networks');
                t.ok(networks, 'should have found networks');
                t.ok(Array.isArray(networks), 'networks should be an array');
                t.equal(networks.length, 1, 'should have exactly 1 network');
                ADMIN_NETWORK_UUID = networks[0].uuid;
                t.ok(ADMIN_NETWORK_UUID, 'found admin network: ' +
                    ADMIN_NETWORK_UUID);
                t.end();
            });
    });

    // need fabric network so we can mount the volume
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

    // delete previous SSH keypair(s)
    tt.test('delete previous SSH keypair', function (t) {
        deleteKeypair(function onDeleted(err) {
            t.ifErr(err, 'removing keypair should succeed');
            t.end();
        });
    });

    // create an SSH keypair so we can use that to SSH into the test zone we're
    // going to create.
    tt.test('create an SSH keypair', function (t) {
        child_process.exec([
            'ssh-keygen',
            '-t rsa',
            '-N ""',
            '-f',
            KEY_FILENAME
        ].join(' '), function onKeyPairCreated(err, stdout, stderr) {
            t.ifErr(err, 'ssh-keygen should succeed');

            fs.readFile(KEY_FILENAME + '.pub',
                function onReadKey(readErr, keyData) {
                    t.ifErr(readErr, 'reading public key should succeed');
                    SSH_PUBLIC_KEY = keyData.toString().trim();
                    t.ok(SSH_PUBLIC_KEY, 'should have found pubic key, got: ' +
                        SSH_PUBLIC_KEY.substr(0, 20) + '...' +
                        SSH_PUBLIC_KEY.substr(SSH_PUBLIC_KEY.length - 20));
                    t.end();
                });

        });
    });

    // We use the origin image from the volapi image here since we know that
    // image will be installed (if volapi is installed) and we really don't
    // care what the dataset actually is.
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
    var mountPoint;
    var nfsRemotePath;
    var sharedNfsVolume;
    var volumeName =
        resources.makeResourceName(NFS_SHARED_VOLUMES_NAMES_PREFIX);

    tt.test('creating a simple nfs shared volume should succeed', function (t) {
        var volumeParams = {
            labels: VOLUME_LABELS,
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

    tt.test('getting newly created nfs shared volume should output it in ' +
        'proper format', function (t) {

            t.ok(ISO_DATE_STRING_RE.test(sharedNfsVolume.create_timestamp),
                'create_timestamp field should match ' + ISO_DATE_STRING_RE);
            t.end();
        });

    tt.test('volume labels should be correct', function (t) {
        t.deepEqual(sharedNfsVolume.labels, VOLUME_LABELS,
            'volume labels should match');
        t.end();
    });

    tt.test('should be able to get volume', function (t) {
        CLIENTS.volapi.getVolume({uuid: sharedNfsVolume.uuid},
                function onGetVolume(err, volume) {
            t.ifErr(err, 'should be no error getting volume');
            t.deepEqual(volume, sharedNfsVolume, 'volume objects should match');
            t.end();
        });
    });

    tt.test('create a VM on same network as volume', function (t) {
        var payload = {
            alias: resources.makeResourceName(NFS_SHARED_VOLUMES_VM_NAME_PREFIX,
                VM_UUID),
            billing_id: SDC_128_UUID,
            brand: 'joyent',
            customer_metadata: {},
            image_uuid: IMAGE_UUID,
            networks: [
                {uuid: ADMIN_OWNED_FABRIC_NETWORK_UUID},
                {uuid: ADMIN_NETWORK_UUID}
            ],
            owner_uuid: UFDS_ADMIN_UUID,
            uuid: VM_UUID
        };
        var user_script = [
            '#!/bin/bash',
            '',
            'cat > /root/.ssh/authorized_keys <<EOF',
            SSH_PUBLIC_KEY,
            'EOF',
            'chmod 0700 /root/.ssh',
            'chmod 0600 /root/.ssh/authorized_keys',
            '',
            'mkdir -p /mnt'
        ].join('\n');

        payload.customer_metadata['user-script'] = user_script;

        t.comment('creating VM ' + VM_UUID);

        CLIENTS.vmapi.createVmAndWait(payload, {},
            function onVmCreate(err, job) {
                t.ifErr(err, 'VM creation should succeed');

                CLIENTS.vmapi.getVm({uuid: VM_UUID}, {},
                    function onGetVm(getErr, vmobj) {
                        t.ifErr(getErr, 'GET after create should succeed');

                        t.ok(vmobj, 'should have vmobj from GetVm');
                        if (vmobj) {
                            t.equal(vmobj.state, 'running',
                                'VM should be running');

                            VM_ADMIN_IP = vmobj.nics[1].ip;
                            t.ok(VM_ADMIN_IP,
                                'expected to find admin IP, got: ' +
                                JSON.stringify(VM_ADMIN_IP));
                        }

                        t.end();
                    });
            });
    });

    tt.test('mounting the shared volume via NFS succeeds', function (t) {
        nfsRemotePath = sharedNfsVolume.filesystem_path;
        mountPoint = '/mnt';

        child_process.exec([
            'ssh',
            '-o StrictHostKeyChecking=no',
            '-o UserKnownHostsFile=/dev/null',
            '-i', KEY_FILENAME,
            'root@' + VM_ADMIN_IP,
            '"mount -F nfs ' + nfsRemotePath + ' ' + mountPoint + '"'
        ].join(' '), function onNfsMountDone(err, stdout, stderr) {
            t.ifErr(err, 'mounting the NFS remote fs should succeed');
            t.end();
        });
    });

    tt.test('unmounting the shared volume via NFS succeeds', function (t) {
        child_process.exec([
            'ssh',
            '-o StrictHostKeyChecking=no',
            '-o UserKnownHostsFile=/dev/null',
            '-i', KEY_FILENAME,
            'root@' + VM_ADMIN_IP,
            '"umount ' + mountPoint + '"'
        ].join(' '), function onMountDone(err, stdout, stderr) {
            t.ifErr(err, 'unmounting the NFS remote fs should not error');
            t.end();
        });
    });

    tt.test('newly created volume should show up in list endpoint',
        function (t) {
            CLIENTS.volapi.listVolumes(function onVolumesListed(err, volumes) {
                var newlyCreatedVolumeFound = false;

                function isNewlyCreatedVolume(volumeObject) {
                    return volumeObject.uuid = sharedNfsVolume.uuid;
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
            function deleteTestVM(done) {
                CLIENTS.vmapi.deleteVm({uuid: VM_UUID, sync: true}, {},
                    function onDeleteVm(err, job) {
                        t.ifErr(err, 'should succeed to delete VM');
                        done();
                    });
            },
            function cleanupKeypair(done) {
                deleteKeypair(function (err) {
                    t.ifErr(err, 'removing keypair should succeed');
                    done();
                });
            },
            function deleteSharedVolume(done) {
                CLIENTS.volapi.deleteVolumeAndWait({
                    owner_uuid: UFDS_ADMIN_UUID,
                    uuid: sharedNfsVolume.uuid
                }, function onVolumeDeleted(err) {
                    t.ifErr(err,
                        'volume should have been deleted without error');
                    done();
                });
            }
        ]}, function cleanupDone(err) {
            t.end();
        });
    });
});
