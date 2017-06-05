/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var test = require('tape');

var clientsSetup = require('./lib/clients-setup');

var CLIENTS;
var NETWORKS;
var NFS_SHARED_VOLUMES_NAMES_PREFIX = 'nfs-shared-volumes';
var NFS_SHARED_VOLUMES_TYPE_NAME = 'tritonnfs';
// volume package we're going to deactivate and re-activate as part of this test
var VICTIM_PACKAGE_SIZE = 10240;
var VICTIM_PACKAGE_NAME = 'sdc_volume_nfs_10';
var VICTIM_PACKAGE_UUID;

test('setup', function (tt) {
    tt.test(' setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.ok(CLIENTS.volapi, 'should have volapi client');
            t.end();
        });
    });
});

test('listVolumeSizes', function (tt) {
    tt.test(' GET /volumes/sizes should return array of sizes', function (t) {
        CLIENTS.volapi.listVolumeSizes({type: 'tritonnfs'},
            function onListVolumeSizes(err, volumeSizes) {
                var idx = 0;
                var sorted = true;

                t.ifErr(err, 'listing volume sizes should succeed');
                t.ok(volumeSizes, 'should have received volumeSizes object');
                t.ok(Array.isArray(volumeSizes), 'volumeSizes should be array');
                t.ok(volumeSizes.length > 0,
                    'should have at least one volumeSize');
                t.ok(volumeSizes[0].size, 'first volumeSize should have size,' +
                    ' got: ' + volumeSizes[0].size);
                t.ok(volumeSizes[0].description, 'first volumeSize should ' +
                    'have description, got: ' + volumeSizes[0].description);

                // check that volume sizes are in ascending order
                for (idx = 0; idx < volumeSizes.length; idx++) {
                    if (idx > 0 && volumeSizes[idx - 1] > volumeSizes[idx]) {
                        sorted = false;
                    }
                }

                t.ok(sorted, 'volume sizes should be in ascending order');
                t.end();
            });
    });

    tt.test(' Deactivate ' + VICTIM_PACKAGE_NAME, function (t) {
        CLIENTS.papi.list({name: VICTIM_PACKAGE_NAME}, {},
            function onList(err, pkgs) {
                t.ifErr(err, 'should succeed to "list" packages');
                t.ok(pkgs, 'should have received a package list');
                t.ok(Array.isArray(pkgs), 'package list should be array');
                t.equal(pkgs.length, 1, 'should have exactly 1 package');
                t.equal(pkgs[0].name, VICTIM_PACKAGE_NAME,
                    'package found should be our victim');
                t.ok(pkgs[0].uuid, 'package should have uuid, got: ' +
                    pkgs[0].uuid);

                VICTIM_PACKAGE_UUID = pkgs[0].uuid;

                if (pkgs[0].name === VICTIM_PACKAGE_NAME) {
                    CLIENTS.papi.update(pkgs[0].uuid, {active: false},
                        function onUpdate(updateErr) {
                            t.ifErr(updateErr, 'update should succeed');
                            t.end();
                        });
                } else {
                    t.end();
                }
            });
    });

    tt.test(' Deactivated package should not be visible', function (t) {
        CLIENTS.volapi.listVolumeSizes({type: 'tritonnfs'},
            function onListVolumeSizes(err, volumeSizes) {
                var foundVictim = false;
                var idx = 0;

                t.ifErr(err, 'listing volume sizes should succeed');
                t.ok(volumeSizes, 'should have received volumeSizes object');
                t.ok(Array.isArray(volumeSizes), 'volumeSizes should be array');
                for (idx = 0; idx < volumeSizes.length; idx++) {
                    if (volumeSizes[idx].size === VICTIM_PACKAGE_SIZE) {
                        foundVictim = true;
                    }
                }
                t.ok(!foundVictim, 'should not have found size=' +
                    VICTIM_PACKAGE_SIZE);
                t.end();
            });
    });

    tt.test(' Reactivate ' + VICTIM_PACKAGE_NAME, function (t) {
        t.ok(VICTIM_PACKAGE_UUID, 'have victim uuid');
        if (VICTIM_PACKAGE_UUID) {
            CLIENTS.papi.update(VICTIM_PACKAGE_UUID, {active: true},
                function onUpdate(updateErr) {
                    t.ifErr(updateErr, 'update should succeed');
                    t.end();
                });
        } else {
            t.end();
        }
    });

    tt.test(' Reactivated package should be visible', function (t) {
        CLIENTS.volapi.listVolumeSizes({type: 'tritonnfs'},
            function onListVolumeSizes(err, volumeSizes) {
                var foundVictim = false;
                var idx = 0;

                t.ifErr(err, 'listing volume sizes should succeed');
                t.ok(volumeSizes, 'should have received volumeSizes object');
                t.ok(Array.isArray(volumeSizes), 'volumeSizes should be array');
                for (idx = 0; idx < volumeSizes.length; idx++) {
                    if (volumeSizes[idx].size === VICTIM_PACKAGE_SIZE) {
                        foundVictim = true;
                    }
                }
                t.ok(foundVictim, 'should have found size=' +
                    VICTIM_PACKAGE_SIZE);
                t.end();
            });
    });

});
