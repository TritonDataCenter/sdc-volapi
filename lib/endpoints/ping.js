/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert');

/*
 * GET /ping
 */
function ping(req, res, next) {
    var healthy = true;
    var response = {};
    var status = 'OK';

    response.pid = process.pid;
    response.status = status;
    response.healthy = healthy;

    res.send(200, response);
    return next();
}

function mount(config, server) {
    server.get({
        path: '/ping',
        name: 'Ping',
        version: '1.0.0'
    }, ping);
}

module.exports = {
    mount: mount
};
