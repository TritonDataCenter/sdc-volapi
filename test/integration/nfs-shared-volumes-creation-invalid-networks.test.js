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
var vasync = require('vasync');

var clientsSetup = require('./lib/clients-setup');
var configLoader = require('../../lib/config-loader');

var CONFIG = configLoader.loadConfigSync();

var UFDS_ADMIN_UUID = CONFIG.ufdsAdminUuid;
assert.string(UFDS_ADMIN_UUID, 'UFDS_ADMIN_UUID');

var CLIENTS;
var NETWORKS = {
    nonOwned: {
        name: 'volapi-test-invalid-1',
        fabric: true,
        vlan_id: 100,
        subnet: '10.100.0.0/24',
        provision_start_ip: '10.100.0.5',
        provision_end_ip: '10.100.0.250',
        nic_tag: 'volapi_test_invalid',
        owner_uuids: [libuuid.create()],
        gateway: '10.100.0.1'
    }, nonFabric: {
        name: 'volapi-test-invalid-2',
        vlan_id: 101,
        subnet: '10.101.0.0/24',
        provision_start_ip: '10.101.0.5',
        provision_end_ip: '10.101.0.250',
        nic_tag: 'volapi_test_invalid',
        owner_uuids: [UFDS_ADMIN_UUID],
        gateway: '10.101.0.1'
    }
};
var NFS_SHARED_VOLUMES_TYPE_NAME = 'tritonnfs';

function cleanupPreviouslyCreatedTestNapiObjects(tt, okNoExist) {

    if (okNoExist) {
        // we assume when it's ok if the networks don't exist, that the NETWORKS
        // object won't yet have the uuids. So we grab them here.
        tt.test('find previous NAPI network objects', function (t) {
            vasync.forEachParallel({
                func: function getPreviousTestNetworks(netKey, cb) {
                    var net = NETWORKS[netKey];

                    CLIENTS.napi.listNetworks({
                        name: net.name
                    }, {}, function onListNetworks(err, foundNet) {
                        if (foundNet && foundNet[0] && foundNet[0].uuid) {
                            net.uuid = foundNet[0].uuid;
                        }
                        cb();
                    });
                }, inputs: Object.keys(NETWORKS)
            }, function afterCleanup(err) {
                t.ifError(err, 'should have succeeded to get networks');
                t.end();
            });
        });
    }

    tt.test('remove networks', function removePreviousTestNetworks(t) {
        vasync.forEachParallel({
            func: function removeNetwork(netKey, cb) {
                var net = NETWORKS[netKey];

                if (okNoExist && !net.uuid) {
                    cb();
                    return;
                }

                CLIENTS.napi.deleteNetwork(net.uuid, {}, {},
                    function onDeleteNetwork(err) {
                        t.ifError(err, 'DeleteNetwork should succeed: ' +
                            net.uuid);
                        cb();
                    });
            }, inputs: Object.keys(NETWORKS)
        }, function afterRemovingNetworks(err) {
            if (!okNoExist) {
                t.ifError(err, 'should have succeeded to delete networks');
            }
            t.end();
        });
    });

    tt.test('remove nic tag', function removeInvalidTestNicTag(t) {
        CLIENTS.napi.deleteNicTag('volapi_test_invalid', {}, {},
            function deleteNicTag(err) {
                if (!okNoExist) {
                    t.ifError(err, 'expected to have deleted nic tag');
                }
                t.end();
            });
    });
}

function expectedError(t, actualErrMsg, expectedErrMsg, testMsg) {
    var matches;

    // Make a RegExp from the expectedErr but we need to escape the
    // '(' and ')' characters to '\(' and '\)' so that the regex
    // will not treat that as a grouping.
    var re = new RegExp(expectedErrMsg.replace(/[()]/g, '\\$&'));

    matches = actualErrMsg.match(re);

    // with this, we get the actual error message if it fails
    t.equal((matches ? matches[0] : actualErrMsg), expectedErrMsg, testMsg);
}


test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.end();
        });
    });

    tt.test('cleanup NAPI network objects', function (t) {
        // cleanup from previous runs
        cleanupPreviouslyCreatedTestNapiObjects(t, true);
    });

    tt.test('create nic tag', function (t) {
        CLIENTS.napi.createNicTag('volapi_test_invalid', {}, {},
            function createNicTag(err) {
                t.ifError(err, 'expected to have created a nic tag');
                t.end();
            });
    });

    tt.test('create invalid networks', function (t) {
        vasync.forEachParallel({
            func: function createInvalidNetwork(netKey, cb) {
                var net = NETWORKS[netKey];

                CLIENTS.napi.createNetwork(net, {},
                    function onCreateNetwork(err, network) {
                        t.ifError(err, 'CreateNetwork should succeed');
                        t.ok((network && network.uuid), 'expected network ' +
                            'uuid got: ' + ((network && network.uuid) ?
                                network.uuid : 'undefined'));
                        if (network && network.uuid) {
                            net.uuid = network.uuid;
                        }
                        cb();
                    });
            }, inputs: Object.keys(NETWORKS)
        }, function (err) {
            t.ifError(err, 'should have succeeded');
            t.end();
        });
    });
});

test('should fail to create volume on invalid networks', function (tt) {
    tt.test('test w/ non-owned network', function (t) {
        CLIENTS.volapi.createVolume({
            name: 'volapi-test-invalid-owner',
            owner_uuid: UFDS_ADMIN_UUID,
            type: NFS_SHARED_VOLUMES_TYPE_NAME,
            networks: [NETWORKS['nonOwned'].uuid]
        }, function onVolumeCreated(err, volume) {
            var expectedErrMsg = 'Invalid networks: not owned by user: ' +
                    [NETWORKS['nonOwned'].uuid];

            t.ok(err, 'volume creation should result in an error');
            expectedError(t, err.message, expectedErrMsg,
                'expected invalid (non-owned) networks error');

            t.end();
        });
    });
    tt.test('test w/ non-fabric network', function (t) {
        CLIENTS.volapi.createVolume({
            name: 'volapi-test-invalid-not-fabric',
            owner_uuid: UFDS_ADMIN_UUID,
            type: NFS_SHARED_VOLUMES_TYPE_NAME,
            networks: [NETWORKS['nonFabric'].uuid]
        }, function onVolumeCreated(err, volume) {
            var expectedErrMsg = 'Invalid networks: non-fabric: ' +
                [NETWORKS['nonFabric'].uuid];

            t.ok(err, 'volume creation should result in an error');
            expectedError(t, err.message, expectedErrMsg,
                'expected invalid (non-fabric) networks error');

            t.end();
        });
    });
    tt.test('test w/ non-existent network', function (t) {
        var missingNetwork = libuuid.create();

        CLIENTS.volapi.createVolume({
            name: 'volapi-test-invalid-not-existing',
            owner_uuid: UFDS_ADMIN_UUID,
            type: NFS_SHARED_VOLUMES_TYPE_NAME,
            networks: [missingNetwork]
        }, function onVolumeCreated(err, volume) {
            var expectedErrMsg = 'Invalid networks: missing: ' + missingNetwork;

            t.ok(err, 'volume creation should result in an error');
            expectedError(t, err.message, expectedErrMsg,
                'expected missing networks error');

            t.end();
        });
    });
});

test('teardown', function (tt) {
    cleanupPreviouslyCreatedTestNapiObjects(tt);
});
