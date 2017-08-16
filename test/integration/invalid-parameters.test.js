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

var CLIENTS;

function confirmBogusParam(t, endpoint, err) {
    var expectedErrMsg =
        'Validation error, causes: Error: invalid parameter: bogus';

    t.ok(err, endpoint + ' w/ bad param should result in an error');

    if (err) {
        t.notEqual(err.message.indexOf(expectedErrMsg), -1,
            'expected error due to invalid parameter');
    }
}

test('setup', function (tt) {
    tt.test('setup clients', function (t) {
        clientsSetup.getApiClients(function onClientsSetup(err, clients) {
            CLIENTS = clients;
            t.end();
        });
    });
});

test('testing endpoints with invalid parameters', function (tt) {

    tt.test('ping with bogus=true should fail', function (t) {
        CLIENTS.volapi.get({path: '/ping?bogus=true'}, function onPing(err) {
            confirmBogusParam(t, 'Ping', err);
            t.end();
        });
    });

    tt.test('creating a volume with bogus=true should fail', function (t) {
        var volumeParams = {
            bogus: true,
            networks: [],
            type: 'tritonnfs',
            owner_uuid: '00000000-0000-0000-0000-000000000000'
        };

        CLIENTS.volapi.createVolume(volumeParams,
            function onVolumeCreated(err, volume) {
                confirmBogusParam(t, 'CreateVolume', err);
                t.end();
            });
    });

    tt.test('creating a volume with missing type should fail', function (t) {
        var errMatch = /Validation error.*missing mandatory parameter: type/;
        var volumeParams = {
            networks: [],
            owner_uuid: '00000000-0000-0000-0000-000000000000'
        };

        CLIENTS.volapi.createVolume(volumeParams,
            function onVolumeCreated(err, volume) {
                t.ok(err, 'volume creation should result in an error');
                if (err) {
                    t.ok(errMatch.test(err.message),
                        'expected error due to missing type, got: '
                        + err.message);
                }
                t.end();
            });
    });

    tt.test('listing volumes with bogus=true should fail', function (t) {
        CLIENTS.volapi.listVolumes({
            bogus: true
        }, function onListVolumes(err, req, res, obj) {
            confirmBogusParam(t, 'ListVolumes', err);
            t.end();
        });
    });

    tt.test('listing volumesizes with bogus=true should fail', function (t) {
        CLIENTS.volapi.listVolumeSizes({
            bogus: true
        }, function onListVolumeSizes(err, req, res, obj) {
            confirmBogusParam(t, 'ListVolumeSizes', err);
            t.end();
        });
    });

    tt.test('get volume with bogus=true should fail', function (t) {
        var uuid = '00000000-0000-0000-0000-000000000000';

        CLIENTS.volapi.get({
            path: '/volumes/' + uuid + '?bogus=true'
        }, function onGetVolumes(err, req, res, obj) {
            confirmBogusParam(t, 'GetVolume', err);
            t.end();
        });
    });

    tt.test('get volume references with non-uuid should fail', function (t) {
        var uuid = 'peanutbutter';

        CLIENTS.volapi.get({
            path: '/volumes/' + uuid
                + '/references'
        }, function onGetVolumeReferences(err, req, res, obj) {
            t.ok(err, 'get volume references should result in an error');
            t.equal((err ? err.message : ''), 'Validation error, causes: '
                + 'Error: peanutbutter is not a valid uuid UUID',
                'expected error due to invalid parameter');
            t.end();
        });
    });

    tt.test('get volume references with bogus=true should fail', function (t) {
        var uuid = '00000000-0000-0000-0000-000000000000';

        CLIENTS.volapi.get({
            path: '/volumes/' + uuid
                + '/references?bogus=true'
        }, function onGetVolumeReferences(err, req, res, obj) {
            confirmBogusParam(t, 'GetVolumeReferences', err);
            t.end();
        });
    });

    tt.test('get volume references with owner_uuid should fail', function (t) {
        var owner_uuid = '00000000-0000-0000-0000-000000000000';
        var uuid = '00000000-0000-0000-0000-000000000000';

        CLIENTS.volapi.get({
            path: '/volumes/' + uuid
                + '/references?owner_uuid=' + owner_uuid
        }, function onGetVolumeReferences(err, req, res, obj) {
            t.ok(err, 'get volume references should result in an error');
            t.equal((err ? err.message : ''), 'Validation error, causes: '
                + 'Error: invalid parameter: owner_uuid',
                'expected error due to invalid parameter');
            t.end();
        });
    });

    tt.test('delete volume with bogus=true should fail', function (t) {
        var uuid = '00000000-0000-0000-0000-000000000000';

        CLIENTS.volapi.del('/volumes/' + uuid + '?bogus=true',
            function onDeleteVolume(err, req, res) {
                confirmBogusParam(t, 'DeleteVolume', err);
                t.end();
            });
    });

    tt.test('update volume with bogus=true should fail', function (t) {
        var uuid = '00000000-0000-0000-0000-000000000000';

        CLIENTS.volapi.post('/volumes/' + uuid, {bogus: true},
            function onUpdateVolume(err, req, res) {
                confirmBogusParam(t, 'UpdateVolume', err);
                t.end();
            });
    });
});
