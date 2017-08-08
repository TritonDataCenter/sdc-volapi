/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var krill = require('krill');
var VError = require('verror');

var uuidValidation = require('./uuid');
var volumes = require('../volumes');
var volumesValidation = require('./volumes');

var VOLUME_PREDICATE_TYPES = {
    dangling: 'boolean',
    name: 'string',
    network: 'string',
    size: 'number',
    state: 'string',
    type: 'string',
    uuid: 'string'
};

function validatePredicate(predicateString) {
    assert.string(predicateString, 'predicateString');

    var predicateObject;
    var predicate;
    var validationErrs = [];
    var error;
    var predicateFieldsAndValues;
    var predicateField;
    var VALIDATION_FUNCS = {
        dangling: volumesValidation.validateDanglingPredicate,
        name: volumesValidation.validateVolumeName,
        network: volumesValidation.validateVolumeNetwork,
        size: volumesValidation.validateVolumeSize,
        state: volumesValidation.validateVolumeState,
        type: volumesValidation.validateVolumeType,
        uuid: function validateVolumeUuid(uuid) {
            return uuidValidation.validateUuid(uuid, 'uuid');
        }
    };

    try {
        predicateObject = JSON.parse(predicateString);
    } catch (parseErr) {
        error = new VError(parseErr, 'Could not parse JSON predicate %s',
            predicateString);
    }

    if (!error) {
        try {
            predicate = krill.createPredicate(predicateObject,
                VOLUME_PREDICATE_TYPES);
        } catch (predicateValidationErr) {
            error = predicateValidationErr;
        }
    }

    if (!error) {
        predicateFieldsAndValues = predicate.fieldsAndValues();

        for (predicateField in predicateFieldsAndValues) {
            var validationFunc = VALIDATION_FUNCS[predicateField];
            var predicateValues = predicateFieldsAndValues[predicateField];

            assert.func(validationFunc, 'validationFunc');

            predicateValues.forEach(function validatePredicateValue(value) {
                var validationError = validationFunc(value);
                if (validationError) {
                    validationErrs.push(validationError);
                }
            });
        }
    }

    if (validationErrs.length > 0) {
        error = new Error('Invalid values in predicate: ' + validationErrs);
    }

    return error;
}

module.exports = {
    validatePredicate: validatePredicate
};