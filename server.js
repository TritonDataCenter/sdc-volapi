/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var restify = require('restify');
var Logger = require('bunyan');

var volapi = require('./lib/volapi');
var configLoader = require('./lib/config-loader');

var config = configLoader.loadConfigSync();
var log = new Logger({
    name: 'volapi',
    level: config.logLevel || 'debug',
    serializers: restify.bunyan.serializers
});

volapi.init(config, log, function onVolApiInitialized(initErr, server) {
    if (initErr) {
        log.error({err: initErr}, 'Failed to initialize VOLAPI');
        process.exitCode = 1;
    } else {
        server.listen(config.api.port || 80, '0.0.0.0', function onListen() {
            log.info({url: server.url}, '%s listening', server.name);
        });
    }
});