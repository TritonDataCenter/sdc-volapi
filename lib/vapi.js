/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var crypto = require('crypto');
var os = require('os');

var assert = require('assert-plus');
var restify = require('restify');
var VmapiClient = require('sdc-clients').VMAPI;

var volumeRoutes = require('./endpoints/volumes');

/*
 * Force JSON for all accept headers
 */
function formatJSON(req, res, body) {
    req.log.debug('formatJSON');

    if (body instanceof Error) {
        // snoop for RestError or HttpError, but don't rely on
        // instanceof
        res.statusCode = body.statusCode || 500;

        if (body.body) {
            body = body.body;
        } else {
            body = { message: body.message };
        }
    } else if (Buffer.isBuffer(body)) {
        body = body.toString('base64');
    }

    var data = JSON.stringify(body);
    var md5 = crypto.createHash('md5').update(data).digest('base64');

    res.setHeader('Content-Length', Buffer.byteLength(data));
    res.setHeader('Content-MD5', md5);
    res.setHeader('Content-Type', 'application/json');

    req.log.debug('formatJSON done');
    return (data);
}

function setCommonMiddlewares(config, server, options) {
    assert.object(config, 'config');
    assert.object(server, 'server');
    assert.object(options, 'options');

    server.use(function (req, res, next) {
        res.on('header', function onHeader() {
            var now = Date.now();
            res.header('Date', new Date());
            res.header('Server', server.name);
            res.header('x-request-id', req.getId());
            var t = now - req.time();
            res.header('x-response-time', t);
            res.header('x-server-name', os.hostname());
        });

        req._vmapiClient = options.vmapiClient;

        next();
    });
}

function setRoutes(config, server) {
    assert.object(config, 'config');
    assert.object(server, 'server');

    volumeRoutes.mount(config, server);
}

function init(config, log, callback) {
    assert.object(config, 'config');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var server = restify.createServer({
        name: 'VAPI',
        log: log.child({ component: 'api' }, true),
        version: config.version,
        serverName: 'SmartDataCenter'
    });

    var vmapiClient = new VmapiClient(config.vmapi);

    setCommonMiddlewares(config, server, {
        vmapiClient: vmapiClient
    });

    setRoutes(config, server);

    callback(null, server);
}

module.exports = {
    init: init
};