/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var vasync = require('vasync');

var volumesModel = require('../models/volumes');

function _buildVMPayload() {
    return {};
}

function createVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    req.log.debug('createVolume');

    var volumeParams = {
        name: req.params.Name,
        size: req.params.DriverOpts.size,
        network: req.params.DriverOpts.network
    };

    var options = {
    };
    vasync.waterfall([
        function buildVMPayload(done) {
            _buildVMPayload(volumeParams, options, done);
        },
        function createStorageVM(vmPayload, done) {
            req._vmapiClient.createVm({
                payload: vmPayload,
                sync: true
            }, {
                headers: {'x-request-id': req.getId()}
            }, done);
        },
        function createVolumeModel(vm, done) {
            volumesModel.create(volumeParams, vm,
                function onVolumeCreated(err, volume) {
                    if (!err) {
                        req.volume = volume;
                    }
                    done(err);
                    return;
                });
        }
    ], function allDone(err) {
        next(err);
        return;
    });
}

function renderVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    req.log.debug('renderVolume');

    res.send(201, req.volume);
    return next();
}

function mount(config, server) {
    server.post({path: '/volumes/create', name: 'CreateVolume'},
        createVolume,
        renderVolume);
}

module.exports = {
    mount: mount
};
