/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert');
var restify = require('restify');

var common = require('./common');
var errors = require('../errors');
var validationUtils = require('../validation/utils');

/*
 * GET /ping
 */
function ping(req, res, next) {
    var healthy = true;
    var invalidParamsErrs;
    var response = {};
    var status = 'OK';
    var VALID_PARAM_NAMES = [];

    invalidParamsErrs = validationUtils.checkInvalidParams(req.params,
        VALID_PARAM_NAMES);

    if (invalidParamsErrs.length > 0) {
        next(new errors.ValidationError(invalidParamsErrs));
        return;
    }

    response.pid = process.pid;
    response.status = status;
    response.healthy = healthy;

    res.send(200, response);
    next();
}

function mount(config, server) {
    server.get({
        path: '/ping',
        name: 'Ping',
        version: '1.0.0'
    }, restify.queryParser(), ping);
}

module.exports = {
    mount: mount
};
