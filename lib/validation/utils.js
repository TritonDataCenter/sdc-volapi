/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');

function checkMandatoryParamsPresence(params, mandatoryParamNames) {
    assert.object(params, 'params');
    assert.arrayOfString(mandatoryParamNames, 'mandatoryParamNames');

    var errs = [];
    var mandatoryParamIndex;
    var mandatoryParamName;

    for (mandatoryParamIndex = 0; mandatoryParamIndex <
        mandatoryParamNames.length; ++mandatoryParamIndex) {
        mandatoryParamName = mandatoryParamNames[mandatoryParamIndex];
        if (!params.hasOwnProperty(mandatoryParamName)) {
            errs.push(new Error('missing mandatory parameter: ' +
                mandatoryParamName));
        }
    }

    return errs;
}

function checkInvalidParams(params, validParamNames) {
    assert.object(params, 'params');
    assert.arrayOfString(validParamNames, 'validParamNames');

    var errs = [];
    var paramName;

    for (paramName in params) {
        if (!params.hasOwnProperty(paramName)) {
            continue;
        }

        if (validParamNames.indexOf(paramName) === -1) {
            errs.push(new Error('invalid parameter: ' + paramName));
        }
    }

    return errs;
}

module.exports = {
    checkMandatoryParamsPresence: checkMandatoryParamsPresence,
    checkInvalidParams: checkInvalidParams
};