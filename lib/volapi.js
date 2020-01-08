/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var crypto = require('crypto');
var os = require('os');

var assert = require('assert-plus');
var backoff = require('backoff');
var restify = require('restify');
var trace_event = require('trace-event');
var vasync = require('vasync');

var CnapiClient = require('sdc-clients').CNAPI;
var ImgapiClient = require('sdc-clients').IMGAPI;
var NapiClient = require('sdc-clients').NAPI;
var PapiClient = require('sdc-clients').PAPI;
var SapiClient = require('sdc-clients').SAPI;
var VmapiClient = require('sdc-clients').VMAPI;

var models = require('./models');
var Moray = require('./moray');

var pingRoutes = require('./endpoints/ping');
var volumeResRoutes = require('./endpoints/volume-reservations');
var volumeRoutes = require('./endpoints/volumes');

var request_seq_id = 0;

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
            body = { message: body.message, code: body.code };
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

        req._cnapiClient = options.cnapiClient;
        req._imgapiClient = options.imgapiClient;
        req._napiClient = options.napiClient;
        req._papiClient = options.papiClient;
        req._vmapiClient = options.vmapiClient;

        next();
    });

    callback();
}

function setRoutes(config, server, applicationState, callback) {
    assert.object(config, 'config');
    assert.object(server, 'server');
    assert.object(applicationState, 'applicationState');
    assert.func(callback, 'callback');

    volumeResRoutes.mount(config, server, applicationState);
    volumeRoutes.mount(config, server, applicationState);
    pingRoutes.mount(config, server);

    callback();
}

function setupRestifyServer(config, log) {
    assert.object(log, 'log');
    assert.object(config, 'log');

    var server = restify.createServer({
        name: 'VOLAPI',
        log: log.child({ component: 'api' }, true),
        version: config.version,
        serverName: 'SmartDataCenter',
        handleUncaughtExceptions: false
    });

    var TRACE_EVENTS_SKIPPED_ROUTES = {
        'ping': true
    };

    server.use(restify.requestLogger());

    server.use(function (req, res, next) {
        var routeName;

        if (req.route) {
            routeName = req.route.name;
        }

        if (routeName &&
            !TRACE_EVENTS_SKIPPED_ROUTES.hasOwnProperty(routeName)) {
            req.trace = trace_event.createBunyanTracer({
                log: req.log
            });

            request_seq_id = (request_seq_id + 1) % 1000;
            req.trace.seq_id = (req.time() * 1000) + request_seq_id;
            req.trace.begin({name: req.route.name, req_seq: req.trace.seq_id});
        }

        next();
    });

    server.on('after', function (req, res, route, err) {
        if (route && req.trace) {
            req.trace.end({name: route.name, req_seq: req.trace.seq_id});
        }
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

    return server;
}

function importImage(imgapiClient, imageUuid, log, callback) {
    assert.object(imgapiClient, 'imgapiClient');
    assert.uuid(imageUuid, 'imageUuid');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var importImgBackoff = backoff.exponential({
        initialDelay: 100,
        maxDelay: 10000
    });

    importImgBackoff.on('ready', function onBackoff(number, delay) {
        log.info({imageUuid: imageUuid}, 'Importing image, try #' + number);

        log.info({imageUuid: imageUuid}, 'Getting image...');
        imgapiClient.getImage(imageUuid, function onGetImg(getImgErr, image) {
            if (getImgErr && getImgErr.body &&
                getImgErr.body.code === 'ResourceNotFound') {
                log.info('Image not found, importing image with uuid "' +
                    imageUuid + '"');
                imgapiClient.adminImportRemoteImageAndWait(imageUuid,
                    'https://updates.joyent.com',
                    function onImgImported(importErr) {
                        if (importErr) {
                            log.error({err: importErr, imageUuid: imageUuid},
                                'Error when importing image');
                            importImgBackoff.backoff();
                        } else {
                            log.info({imageUuid: imageUuid},
                                'Imported image succesfully');
                            importImgBackoff.reset();
                            callback();
                        }
                    });
            } else if (getImgErr) {
                importImgBackoff.backoff();
            } else {
                log.info({imageUuid: imageUuid}, 'image already imported');
                importImgBackoff.reset();
                callback();
            }
        });
    });

    importImgBackoff.backoff();
}

function init(config, log, callback) {
    assert.object(config, 'config');
    assert.object(log, 'log');
    assert.func(callback, 'callback');

    var morayClient;
    var context = {
        log: log,
        config: config
    };

    var applicationState = {
        nfsServerImageImported : false,
        nfsServerImage2Imported : false
    };

    var imgapiClient = new ImgapiClient(config.imgapi);

    importImage(imgapiClient, config.nfsServerImageUuid, log,
        function onImageImported() {
            log.info({imageUuid: config.nfsServerImageUuid},
                'Imported nfsserver image successfully');
            applicationState.nfsServerImageImported = true;
        });

    importImage(imgapiClient, config.nfsServerImageUuid2, log,
        function onImageImported2() {
            log.info({imageUuid: config.nfsServerImageUuid2},
                'Imported nfsserver image 2 successfully');
            applicationState.nfsServerImage2Imported = true;
        });

    vasync.pipeline({arg: context, funcs: [
        function connectToMoray(ctx, next) {
            morayClient = new Moray(config.moray);
            morayClient.connect();
            morayClient.on('connect', next);
        },
        function initModels(ctx, next) {
            var modelsInitBackoff = backoff.exponential({
                initialDelay: 100,
                maxDelay: 10000
            });

            modelsInitBackoff.on('ready', function onBackoff(number, delay) {
                models.init(config, {
                    morayClient: morayClient,
                    log: log
                }, function onModelsInitialized(modelsInitErr) {
                    if (modelsInitErr) {
                        ctx.log.error({
                            err: modelsInitErr
                        }, 'Error when initializing models, backing off');
                        modelsInitBackoff.backoff();
                    } else {
                        ctx.log.info('Models initialized successfully');
                        modelsInitBackoff.reset();
                        next();
                    }
                });
            });

            modelsInitBackoff.backoff();
        },
        function setupHttpServer(ctx, next) {
            ctx.server = setupRestifyServer(ctx.config, ctx.log);
            next();
        },
        function setupMiddlewares(ctx, next) {
            assert.object(ctx.server, 'ctx.server');

            return setCommonMiddlewares(config, ctx.server, {
                cnapiClient: new CnapiClient(config.cnapi),
                imgapiClient: imgapiClient,
                morayClient: morayClient,
                napiClient: new NapiClient(config.napi),
                papiClient: new PapiClient(config.papi),
                vmapiClient: new VmapiClient(config.vmapi)
            }, next);
        },
        function setupRoutes(ctx, next) {
            assert.object(ctx.server, 'ctx.server');
            return setRoutes(config, ctx.server, applicationState, next);
        }
    ]}, function initDone(err) {
        return callback(err, context.server);
    });
}

module.exports = {
    init: init
};
