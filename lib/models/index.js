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

var volumesModel = require('./volumes');
var volumeReservationsModel = require('./volume-reservations');

function init(config, options, callback) {
    assert.object(config, 'config');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(callback, 'callback');

    var log = options.log;
    log.info('Initializing models...');

    vasync.parallel({funcs: [
        function initVolumesModel(done) {
            return volumesModel.init(config, options, done);
        },
        function initVolumeReservationsModel(done) {
            return volumeReservationsModel.init(config, options, done);
        }
    ]}, function modelsInitDone(err) {
        if (err) {
            log.error({err: err}, 'Error when initializing models');
        } else {
            log.info('Models initialized successfully');
        }

        return callback(err);
    });
}

module.exports = {
    init: init
};