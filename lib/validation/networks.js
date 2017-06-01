/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function validateNetwork(networkUuid) {
    var validNetwork = typeof (networkUuid) === 'string'&&
        UUID_RE.test(networkUuid);
    var err;

    if (!validNetwork) {
        err = new Error(networkUuid + ' is not a valid network UUID');
    }

    return err;
}

function validateFabricNetworkOwnership(napiClient, volumeParams, callback) {
    assert.object(napiClient, 'napiClient');
    assert.object(volumeParams, 'volumeParams');
    assert.arrayOfUuid(volumeParams.networks, 'volumeParams.networks');
    assert.uuid(volumeParams.owner_uuid, 'volumeParams.owner_uuid');
    assert.func(callback, 'callback');

    var missing = [];
    var nonFabric = [];
    var nonOwned = [];

    vasync.forEachParallel({
        func: function validateOneNetwork(networkUuid, cb) {
            napiClient.getNetwork(networkUuid, function onGetNetwork(err, net) {
                if (!err && net) {
                    assert.object(net, 'net');
                    assert.optionalBool(net.fabric, 'net.fabric');
                    assert.arrayOfUuid(net.owner_uuids, 'net.owner_uuids');

                    if (net.fabric !== true) {
                        nonFabric.push(networkUuid);
                    }
                    if (net.owner_uuids
                        .indexOf(volumeParams.owner_uuid) === -1) {
                        nonOwned.push(networkUuid);
                    }
                }
                if (err && err.name === 'ResourceNotFoundError') {
                    missing.push(networkUuid);
                    // Swallow this error, since not found is just going to fail
                    // validation anyway.
                    err = undefined;
                }
                cb(err);
            });
        }, inputs: volumeParams.networks
    }, function onValidated(err) {
        var newErr = err;
        var newErrMsgs = [];

        if (!err) {
            if (missing.length > 0) {
                newErrMsgs.push('missing networks: ' + JSON.stringify(missing));
            }
            if (nonOwned.length > 0) {
                newErrMsgs.push('non-owned networks: ' +
                    JSON.stringify(nonOwned));
            }
            if (nonFabric.length > 0) {
                newErrMsgs.push('non-fabric networks: ' +
                    JSON.stringify(nonFabric));
            }

            if (newErrMsgs.length > 0) {
                // use .trim() to remove trailing space
                newErr = new Error('invalid network(s) specified: ' +
                    newErrMsgs.join(' '));
            }
       }

       callback(newErr);
    });
}

module.exports = {
    validateFabricNetworkOwnership: validateFabricNetworkOwnership,
    validateNetwork: validateNetwork
};
