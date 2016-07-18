/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var krill = require('krill');

var volumes = require('../volumes');
var volumesValidation = require('./volumes');

var VOLUME_PREDICATE_TYPES = {
    name: 'string',
    type: 'string',
    state: 'string'
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
        state: volumesValidation.validateVolumeState,
        name: volumesValidation.validateVolumeName,
        type: volumesValidation.validateVolumeType
    };

    try {
        predicateObject = JSON.parse(predicateString);
    } catch (parseErr) {
        error = parseErr;
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