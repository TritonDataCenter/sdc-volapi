/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var path = require('path');
var fs = require('fs');

var CONFIG_FILE_PATH = path.join(__dirname, '..', 'config.json');

/*
 * Loads and parse the configuration file at "configFilePath". If
 * "configFilePath" is falsy, it loads the config file from a predetermined
 * location. Returns the content of the configuration file as a JavaScript
 * object. Throws an exception if configFilePath is not valid JSON, or cannot be
 * read.
 */
function loadConfigSync(configFilePath) {
    assert.optionalString(configFilePath, 'configFilePath');

    if (!configFilePath) {
        configFilePath = CONFIG_FILE_PATH;
    }

    var theConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));

    return theConfig;
}

module.exports = {
    loadConfigSync: loadConfigSync
};
