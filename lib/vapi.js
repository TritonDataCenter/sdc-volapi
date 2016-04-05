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
var vasync = require('vasync');

var VmapiClient = require('sdc-clients').VMAPI;
var PapiClient = require('sdc-clients').PAPI;
var ImgapiClient = require('sdc-clients').IMGAPI;

var models = require('./models');
var Moray = require('./moray');

var pingRoutes = require('./endpoints/ping');
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

function setCommonMiddlewares(config, server, options, callback) {
    assert.object(config, 'config');
    assert.object(server, 'server');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

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
        req._papiClient = options.papiClient;
        req._imgapiClient = options.imgapiClient;

        next();
    });

    callback();
}

function setRoutes(config, server, callback) {
    assert.object(config, 'config');
    assert.object(server, 'server');
    assert.func(callback, 'callback');

    volumeRoutes.mount(config, server);
    pingRoutes.mount(config, server);

    callback();
}

function setupRestifyServer(context, callback) {
    assert.object(context, 'context');
    assert.object(context.log, 'context.log');
    assert.object(context.config, 'context.log');
    assert.func(callback, 'callback');

    var log = context.log;
    var config = context.config;

    var server = restify.createServer({
        name: 'VAPI',
        log: log.child({ component: 'api' }, true),
        version: config.version,
        serverName: 'SmartDataCenter'
    });

    server.on('after', function onAfter(req, res, route, err) {
        if (req.path() === '/ping') {
            return;
        }

        // Successful GET res bodies are uninteresting and *big*.
        var method = req.method;
        var body = method !== 'GET' || Math.floor(res.statusCode/100) !== 2;

        restify.auditLogger({
            log: log.child({ route: route && route.name }, true),
            body: body
        })(req, res, route, err);
    });

    server.on('uncaughtException', function onUncaught(req, res, route, error) {
        log.info({
            err: error,
            url: req.url,
            params: req.params
        });

        res.send(new restify.InternalError('Internal Server Error'));
    });

    context.server = server;

    callback();
}

function init(config, log, callback) {
    assert.object(config, 'config');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var morayClient;
    var ctx = {
        log: log,
        config: config
    };

    vasync.pipeline({funcs: [
        function connectToMoray(context, next) {
            morayClient = new Moray(config.moray);
            morayClient.connect();
            morayClient.on('connect', next);
        },
        function initModels(context, next) {
            models.init(config, {
                morayClient: morayClient,
                log: log
            }, next);
        },
        setupRestifyServer,
        function setupMiddlewares(context, next) {
            return setCommonMiddlewares(config, context.server, {
                vmapiClient: new VmapiClient(config.vmapi),
                papiClient: new PapiClient(config.papi),
                imgapiClient: new ImgapiClient(config.imgapi),
                morayClient: morayClient
            }, next);
        },
        function setupRoutes(context, next) {
            return setRoutes(config, context.server, next);
        }
    ],
    arg: ctx
    }, function initDone(err) {
        return callback(err, ctx.server);
    });
}

module.exports = {
    init: init
};