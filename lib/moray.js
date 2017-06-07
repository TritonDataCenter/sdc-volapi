/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var util = require('util');
var EventEmitter = require('events').EventEmitter;

var assert = require('assert-plus');
var Logger = require('bunyan');
var moray = require('moray');
var restify = require('restify');

function Moray(options) {
    EventEmitter.call(this);
    this.log = new Logger({
        name: 'moray',
        level: options.logLevel || 'info',
        serializers: restify.bunyan.serializers
    });
    this.options = options;
}

util.inherits(Moray, EventEmitter);

/*
 * Attempts to connect to moray, retrying until connection is established.
 */
Moray.prototype.connect = function connect() {
    var self = this;
    var log = this.log;
    var retry = this.options.retry || {};
    this.log.debug('Connecting to moray...');

    var connection = this.connection = moray.createClient({
        connectTimeout: this.options.connectTimeout || 200,
        log: this.log,
        host: this.options.host,
        port: this.options.port,
        reconnect: true,
        retry: (this.options.retry === false ? false : {
            retries: Infinity,
            minTimeout: retry.minTimeout || 1000,
            maxTimeout: retry.maxTimeout || 16000
        })
    });

    connection.on('connect', function () {
        log.info({ moray: connection.toString() }, 'moray: connected');
        self.emit('connect');
    });

    connection.on('error', function (err) {
        // not much more to do because the moray client should take
        // care of reconnecting.
        log.error(err, 'moray client error');
    });
};



/*
 * Pings Moray by calling its ping method
 */
Moray.prototype.ping = function ping(callback) {
    // Default ping timeout is 1 second
    return this.connection.ping({ log: this.log }, callback);
};

Moray.prototype.batch = function batch(data, callback) {
    return this.connection.batch(data, callback);
};

/*
 * Gets a bucket
 */
Moray.prototype._getBucket = function (name, cb) {
    this.connection.getBucket(name, cb);
};

/*
 * Creates a bucket
 */
Moray.prototype._createBucket = function _createBucket(name, config, cb) {
    this.connection.createBucket(name, config, cb);
};

/*
 * Replaces a bucket
 */
Moray.prototype._putBucket = function _putBucket(name, config, cb) {
    this.connection.putBucket(name, config, cb);
};

/*
 * Deletes a bucket
 */
Moray.prototype._deleteBucket = function _deleteBucket(name, cb) {
    this.connection.delBucket(name, cb);
};

/*
 * Loads an object
 */
Moray.prototype.getObject = function getObject(bucketName, key, cb) {
    assert.string(bucketName, 'bucketName');
    assert.string(key, 'key');
    assert.func(cb, 'cb');

    this.connection.getObject(bucketName, key, cb);
};

/*
 * Puts an object
 */
Moray.prototype.putObject =
    function putObject(bucketName, key, object, options, cb) {
        if (typeof (options) === 'function') {
            cb = options;
            options = {};
        }

        assert.string(bucketName, 'bucketName');
        assert.string(key, 'key');
        assert.object(object, 'object');
        assert.object(options, 'options');
        assert.func(cb, 'cb');

        this.connection.putObject(bucketName, key, object, options, cb);
    };

Moray.prototype.setupBucket = function setupBucket(bucket, callback) {
    assert.object(bucket, 'bucket');
    assert.func(callback, 'callback');

    var self = this;
    self._putBucket(bucket.name, bucket.config, callback);
};

Moray.prototype.findObjects = function findObject(bucketName, filter, options) {
    assert.string(bucketName, 'bucketName');
    assert.string(filter, 'filter');
    assert.optionalObject(options, 'options');

    return this.connection.findObjects(bucketName, filter, options);
};

Moray.prototype.deleteObject =
    function deleteObject(bucketName, key, callback) {
        assert.string(bucketName, 'bucketName');
        assert.string(key, 'key');
        assert.func(callback, 'callback');

        this.connection.deleteObject(bucketName, key, callback);
    };

Moray.prototype.close = function close() {
    this.connection.close();
};

module.exports = Moray;