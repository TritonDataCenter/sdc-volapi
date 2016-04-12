/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var Logger = require('bunyan');
var restify = require('restify');
var VAPI = require('sdc-clients').VAPI;
var NAPI = require('sdc-clients').NAPI;
var VMAPI = require('sdc-clients').VMAPI;

var configLoader = require('../../../lib/config-loader');
var CONFIG = configLoader.loadConfigSync();

var VAPI_URL = process.env.VAPI_URL || 'http://localhost';

function getApiClients(callback) {
    assert.func(callback, 'callback');

    var logger = new Logger({
        level: process.env.LOG_LEVEL || 'info',
        name: 'vapi_integrations_test',
        stream: process.stderr,
        serializers: {
            err: Logger.stdSerializers.err,
            req: Logger.stdSerializers.req,
            res: restify.bunyan.serializers.res
        }
    });

    var vapiClient = new VAPI({
        url: VAPI_URL,
        version: '*',
        log: logger,
        agent: false
    });

    var napiClient = new NAPI({
        url: CONFIG.napi.url,
        agent: false
    });

    var vmapiClient = new VMAPI({
        url: CONFIG.vmapi.url,
        agent: false
    });

    callback(null, {
        vapi: vapiClient,
        napi: napiClient,
        vmapi: vmapiClient
    });
}

module.exports = {
    getApiClients: getApiClients
};