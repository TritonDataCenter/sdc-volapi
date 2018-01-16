/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Volume reservations are different than volume references. They represent an
 * *intention* for a VM that is being provisioned by a VM provisioning workflow
 * job to use a given volume.
 *
 * When a volume is reserved by a VM being provisioned, an implict reference
 * is still added from the VM being provisioned to the volumes it requires, but
 * these references are tied to the reservation's lifecycle and can be removed
 * if the reservation is removed as the result of a failed provision. As a
 * result, a volume cannot be deleted even if the only VM that is referencing it
 * hasn't been provisioned yet, since it's considered to be in use.
 *
 * When a VM that requires volumes is provisioned, it first creates a
 * reservation for all the volumes that it requires.
 *
 * When a VM is provisioned successfully, an explicit reference is added from
 * that VM to all of the volumes it requires, and all the reservations for this
 * VM are removed.
 *
 * When a VM fails to provision, its volumes reservations and the associated
 * implicit references are cleaned up asynchronously by volapi-updater.
 *
 * The state of volumes reservations is maintained by the volapi-updater
 * service, which cleans up reservations (and sometimes the references they
 * created) depending on the state of the VM or the provisioning workflow job
 * that made the reservation.
 *
 * The raison-d'etre of reservations is that a VM can fail to provision without
 * ever creating a VM object in VMAPI or a VM on any CN. Thus, relying on
 * VMAPI's changefeed events or polling VMAPI is not sufficient to determine
 * that reservations and their associated implicit references need to be cleaned
 * up. Storing reservations allow to keep track of them in that case.
 *
 * All of these APIs are internal and not meant to be exposed via any external
 * service such as CloudAPI. Some of them, like the ListReservations endpoint,
 * are even present only to provide a way to observe the system and used for
 * debugging purposes.
 *
 * A volume reservation is a separate type of object that exists in VOLAPI
 * alongside volumes which has the following properties:
 *
 * - uuid -- the unique identifier of the reservation
 * - volume_name -- the name of the volume being reserved (unique per
 *   owner_uuid)
 * - owner_uuid -- the owner of the VM making the reservation
 * - vm_uuid -- the unique identifier of the VM making the reservation
 * - job_uuid -- the unique identifier of the provisioning job that is
 *   provisioning the VM making the reservation
 * - create_timestamp -- the date and time at which the reservation was made
 */

var assert = require('assert-plus');
var restify = require('restify');
var vasync = require('vasync');

var errors = require('../errors');
var renderingMiddlewares = require('../middlewares/rendering');
var reservationModels = require('../models/volume-reservations');
var validationUtils = require('../validation/utils');
var volumesMiddlewares = require('../middlewares/volumes');
var volumesModel = require('../models/volumes');
var volumesValidation = require('../validation/volumes');
var uuidValidation = require('../validation/uuid');

var CONFIG;
var APPLICATION_STATE;

function validateAddVolumeReservation(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var errs = [];
    var invalidParamsErrs;
    var MANDATORY_PARAM_NAMES;
    var mandatoryParamsErrs;
    var validationErrs = [];
    var VALID_PARAM_NAMES =
        ['job_uuid', 'owner_uuid', 'volume_name', 'vm_uuid'];

    MANDATORY_PARAM_NAMES = VALID_PARAM_NAMES.slice();

    mandatoryParamsErrs =
        validationUtils.checkMandatoryParamsPresence(req.params,
            MANDATORY_PARAM_NAMES);
    invalidParamsErrs =
        validationUtils.checkInvalidParams(req.params, VALID_PARAM_NAMES);

    validationErrs = validationErrs.concat(mandatoryParamsErrs);
    validationErrs = validationErrs.concat(invalidParamsErrs);

    if (req.params.owner_uuid !== undefined) {
        errs = uuidValidation.validateUuid(req.params.owner_uuid, 'owner');
        validationErrs = validationErrs.concat(errs);
    }

    if (req.params.volume_name !== undefined) {
        errs = volumesValidation.validateVolumeName(req.params.volume_name,
            'volume_name');
        validationErrs = validationErrs.concat(errs);
    }

    if (req.params.vm_uuid !== undefined) {
        errs = uuidValidation.validateUuid(req.params.vm_uuid, 'VM');
        validationErrs = validationErrs.concat(errs);
    }

    if (req.params.job_uuid !== undefined) {
        errs = uuidValidation.validateUuid(req.params.job_uuid, 'job');
        validationErrs = validationErrs.concat(errs);
    }

    if (validationErrs.length > 0) {
        next(new errors.ValidationError(validationErrs));
        return;
    } else {
        next();
        return;
    }
}

function addVolumeReservation(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var context = {};

    var ownerUuid = req.params.owner_uuid;
    var vmUuid = req.params.vm_uuid;
    var volumeName = req.params.volume_name;

    req.log.debug({
        params: req.params
    }, 'start AddVolumeReservation');

    vasync.pipeline({arg: context, funcs: [
        /*
         * We consider that the volume reservation to be added for a given
         * volume and VM supersedes any previous reservation. So we load those
         * previous reservations first so that we can remove them once the new
         * one is added.
         */
        function getPreviousVolumeReservations(ctx, done) {
            req.log.debug({
                volumeName: volumeName,
                vmUuid: vmUuid
            }, 'Getting existing volume reservations');

            reservationModels.listVolumeReservations({
                volumeName: volumeName,
                vmUuid: vmUuid,
                ownerUuid: ownerUuid
            }, function onGetVolRes(getVolResErr, volRes) {
                if (getVolResErr) {
                    req.log.error({
                        err: getVolResErr,
                        volRes: volRes
                    }, 'Error when getting existing volume reservations');
                } else {
                    req.log.debug({
                        err: getVolResErr,
                        volRes: volRes
                    }, 'Got existing volume reservations');
                }

                ctx.previousVolRes = volRes;
                done(getVolResErr);
            });
        },
        function createReservation(ctx, done) {
            var reservation = {
                owner_uuid: req.params.owner_uuid,
                volume_name: req.params.volume_name,
                vm_uuid: req.params.vm_uuid,
                job_uuid: req.params.job_uuid
            };

            req.log.debug({
                reservation: reservation
            }, 'Creating new volume reservation');

            reservationModels.createVolumeReservation(reservation,
                function onResCreated(resCreationErr, resUuid) {
                    if (resCreationErr) {
                        req.log.error({
                            err: resCreationErr,
                            resUuid: resUuid
                        }, 'Error when creating volume reservation');
                    } else {
                        req.log.debug({
                            err: resCreationErr,
                            resUuid: resUuid
                        }, 'Created volume reservation');
                    }

                    ctx.resUuid = resUuid;
                    done(resCreationErr);
                });
        },
        function deletePreviousVolumeReservations(ctx, done) {
            /*
             * Attempt to cleanup volume reservations for the same volume and
             * VM, because they are superseded by any one that is more recent.
             */
            req.log.debug({
                previousRes: ctx.previousVolRes
            }, 'Deleting previous volume reservations');

            reservationModels.deleteVolumeReservations(ctx.previousVolRes,
                function onDelReservations(delResErr) {
                    if (delResErr) {
                        req.log.error({
                            err: delResErr
                        }, 'Failed to delete previous reservations');
                    } else {
                        req.log.debug('Previous reservations deleted ' +
                            'successfully');
                    }

                    /*
                     * Ignore errors during reservation deletion on purpose, as
                     * this does not prevent the reference between from the VM
                     * to the volume to be registered. The worse case is that
                     * the previous volume reservations are not deleted, and
                     * thus the volume can't be deleted without using the
                     * "force" flag until the stale reservations process reaps
                     * them.
                     */
                    done();
                });
        },
        function loadVolume(ctx, done) {
            req.log.debug({
                volumeName: volumeName,
                ownerUuid: ownerUuid
            }, 'Loading volume');

            volumesModel.listVolumes({
                name: volumeName,
                owner_uuid: ownerUuid,
                state: 'ready'
            }, function onVolumesLoaded(loadVolErr, volumeObjects) {
                var err;
                var volumeObject;

                assert.optionalArrayOfObject(volumeObjects, 'volumeObjects');
                if (volumeObjects !== undefined) {
                    assert.ok(volumeObjects.length <= 1);

                    if (volumeObjects.length > 0) {
                        volumeObject = volumeObjects[0];
                    }
                }

                if (volumeObject !== undefined) {
                    ctx.volumeObject = volumeObject;
                }

                /*
                 * If the volume couldn't be found, that's fine, we'll just
                 * add the reference corresponding to the reservation when
                 * that volume gets created.
                 */
                if (loadVolErr &&
                    loadVolErr.name !== 'ObjectNotFoundError') {
                    req.log.error({
                        err: loadVolErr,
                        volumeName: volumeName,
                        ownerUuid: ownerUuid
                    }, 'Error when loading volume');

                    err = loadVolErr;
                }

                done(err);
            });
        },
        function addReference(ctx, done) {
            var volumeUuid;

            if (ctx.volumeObject === undefined) {
                /*
                 * If the volume for which we're doing a reservation does not
                 * exist, then we'll not add the corresponding reference now.
                 * Instead, we'll add the references that correspond to the
                 * existing reservations when the volume is created.
                 */
                req.log.debug({
                    vmUuid: vmUuid,
                    volumeName: volumeName,
                    ownerUuid: ownerUuid
                }, 'Volume does not exist, not adding actual reference');

                done();
                return;
            }

            volumeUuid = ctx.volumeObject.value.uuid;

            req.log.debug({
                vmUuid: vmUuid,
                volumeUuid: volumeUuid
            }, 'Adding actual volume reference');

            /*
             * A reservation is not a reference in itself, but while it is
             * active we want it to act as a reference so that a "reserved"
             * volume cannot be deleted.
             */
            volumesModel.addReference(vmUuid, volumeUuid,
                function onRefAdded(addRefErr) {
                    if (!addRefErr) {
                        req.log.debug({
                            vmUuid: vmUuid,
                            volumeUuid: volumeUuid
                        }, 'Reference added successfully');

                        ctx.refAdded = true;
                    } else {
                        req.log.error({
                            err: addRefErr,
                            vmUuid: vmUuid,
                            volumeUuid: volumeUuid
                        }, 'Failed to add volume reference');
                    }

                    done(addRefErr);
                });
        },
        function loadRes(ctx, done) {
            assert.uuid(ctx.resUuid, 'ctx.resUuid');
            reservationModels.getVolumeReservation(ctx.resUuid,
                function onGetRes(getResErr, volRes) {
                    if (volRes !== undefined) {
                        ctx.volRes = volRes.value;
                    }

                    done(getResErr);
                });
        }
    ]}, function onAllDone(addVolResErr) {
        if (addVolResErr) {
            cleanupReservationAndRef(function onCleanupDone(cleanupErr) {
                if (cleanupErr) {
                    req.log.error({
                        cleanupErr: cleanupErr,
                        addVolResErr: addVolResErr
                    }, 'Error when cleaning up after reservation error');
                }
                next(addVolResErr);
            });
        } else {
            req.responseReservation = context.volRes;
            next();
        }
    });

    function cleanupReservationAndRef(callback) {
        assert.func(callback, 'callback');

        vasync.parallel({funcs: [
            function deleteRes(done) {
                if (context.resUuid !== undefined) {
                    reservationModels.deleteVolumeReservation(context.resUuid,
                        done);
                } else {
                    done();
                }
            },
            function deleteRef(done) {
                if (context.refAdded === true) {
                    volumesModel.deleteReference(req.params.vm_uuid,
                        req.params.volume_uuid, done);
                } else {
                    done();
                }
            }
        ]}, callback);
    }
}

function validateRemoveVolumeReservation(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var errs = [];
    var validationErrs = [];
    var VALID_PARAM_NAMES = ['uuid', 'owner_uuid'];
    var MANDATORY_PARAM_NAMES = VALID_PARAM_NAMES.slice();

    var mandatoryParamsErrs =
        validationUtils.checkMandatoryParamsPresence(req.params,
            MANDATORY_PARAM_NAMES);
    var invalidParamsErrs =
        validationUtils.checkInvalidParams(req.params, VALID_PARAM_NAMES);

    validationErrs = validationErrs.concat(mandatoryParamsErrs);
    validationErrs = validationErrs.concat(invalidParamsErrs);

    if (req.params.uuid) {
        errs = uuidValidation.validateUuid(req.params.uuid, 'uuid');
        validationErrs = validationErrs.concat(errs);
    }

    if (req.params.owner_uuid) {
        errs = uuidValidation.validateUuid(req.params.owner_uuid, 'owner');
        validationErrs = validationErrs.concat(errs);
    }

    if (validationErrs.length > 0) {
        next(new errors.ValidationError(validationErrs));
        return;
    } else {
        next();
        return;
    }
}

function removeVolumeReservation(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var context = {};
    var err;
    var expectedVolResOwnerUuid = req.params.owner_uuid;
    var volResUuid = req.params.uuid;

    vasync.pipeline({arg: context, funcs: [
        function checkExists(ctx, done) {
            reservationModels.getVolumeReservation(volResUuid,
                function onVolResLoaded(getVolResErr, volResObject) {
                    if (!getVolResErr) {
                        if (volResObject === undefined) {
                            err = new Error('No volume reservation with uuid ' +
                                volResUuid);
                        } else {
                            ctx.volumeReservationObject = volResObject;
                        }
                    } else {
                        req.log.error({err: err},
                            'Error when loading volume reservation object ' +
                                'from moray');

                        if (getVolResErr.name === 'ObjectNotFoundError') {
                            err =
                                new errors.VolumeReservationFoundError(
                                    volResUuid);
                        }
                    }

                    done(err);
                });
        },
        function checkOwner(ctx, done) {
            assert.object(ctx.volumeReservationObject,
                'ctx.volumeReservationObject');

            var checkOwnerErr;
            var volResOwnerUuid = ctx.volumeReservationObject.value.owner_uuid;

            if (volResOwnerUuid !== expectedVolResOwnerUuid) {
                checkOwnerErr = new Error('owner_uuid: '  +
                    expectedVolResOwnerUuid + ' does not match owner_uuid ' +
                    'for volume reservation ' + volResUuid + ' (' +
                    ctx.volumeReservation.value.owner_uuid + ')');
            }

            done(checkOwnerErr);
        },
        function remove(ctx, done) {
            reservationModels.deleteVolumeReservation(req.params.uuid,
                function onResCreated(resDelErr) {
                    done(resDelErr);
                });
        }
    ]}, next);
}

function formatVolumeReservationValue(volumeReservationValue) {
    assert.object(volumeReservationValue, 'volumeReservationValue');

    volumeReservationValue.create_timestamp =
        new Date(volumeReservationValue.create_timestamp).toISOString();
    return volumeReservationValue;
}

function renderVolumeReservation(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    assert.object(req.responseReservation, 'req.responseReservation');

    req.renderedResponse =
        formatVolumeReservationValue(req.responseReservation);

    next();
}

function validateListVolumeReservations(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var errs = [];
    var validationErrs = [];
    var VALID_PARAM_NAMES =
        ['owner_uuid', 'volume_name', 'vm_uuid', 'job_uuid'];
    var MANDATORY_PARAM_NAMES = [];

    var mandatoryParamsErrs =
        validationUtils.checkMandatoryParamsPresence(req.params,
            MANDATORY_PARAM_NAMES);
    var invalidParamsErrs =
        validationUtils.checkInvalidParams(req.params, VALID_PARAM_NAMES);

    validationErrs = validationErrs.concat(mandatoryParamsErrs);
    validationErrs = validationErrs.concat(invalidParamsErrs);

    if (req.params.owner_uuid) {
        errs = uuidValidation.validateUuid(req.params.owner_uuid, 'owner_uuid');
        validationErrs = validationErrs.concat(errs);
    }

    if (req.params.volume_name) {
        errs = volumesValidation.validateVolumeName(req.params.volume_name,
            'volume_name');
            validationErrs = validationErrs.concat(errs);
    }

    if (req.params.vm_uuid) {
        errs = uuidValidation.validateUuid(req.params.vm_uuid, 'vm_uuid');
        validationErrs = validationErrs.concat(errs);
    }

    if (req.params.job_uuid) {
        errs = uuidValidation.validateUuid(req.params.job_uuid, 'job_uuid');
        validationErrs = validationErrs.concat(errs);
    }

    if (validationErrs.length > 0) {
        next(new errors.ValidationError(validationErrs));
        return;
    } else {
        next();
        return;
    }
}

function listVolumeReservations(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.object(res, 'res');
    assert.func(next, 'next');

    reservationModels.listVolumeReservations({
        ownerUuid: req.params.owner_uuid,
        volumeName: req.params.volume_name,
        jobUuid: req.params.job_uuid,
        vmUuid: req.params.vm_uuid
    }, function onListReservations(listResErr, reservations) {
        req.responseReservations =
            reservations.map(function getResObjectValue(resObject) {
                return resObject.value;
            });

        next(listResErr);
    });
}

function formatVolumeReservationsValues(volumeReservationValues) {
    assert.arrayOfObject(volumeReservationValues, 'volumeReservationValues');
    return volumeReservationValues.map(formatVolumeReservationValue);
}

function renderVolumeReservations(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    assert.object(req.responseReservations, 'req.responseReservations');

    req.renderedResponse =
        formatVolumeReservationsValues(req.responseReservations);

    next();
}

function mount(config, server, applicationState) {
    assert.object(config, 'config');
    assert.object(server, 'server');
    assert.object(applicationState, 'applicationState');

    CONFIG = config;
    APPLICATION_STATE = applicationState;

    server.post({
        path: '/volumereservations',
        name: 'AddVolumeReservation',
        version: '1.0.0'
    }, restify.bodyParser(),
        validateAddVolumeReservation, addVolumeReservation,
        renderVolumeReservation,
        renderingMiddlewares.makeSendResponseHandler({
            statusCode: 201
        }));

    server.del({
        path: '/volumereservations/:uuid',
        name: 'RemoveVolumeReservation',
        version: '1.0.0'
    }, restify.queryParser(),
        validateRemoveVolumeReservation, removeVolumeReservation,
        renderingMiddlewares.makeSendResponseHandler({
            statusCode: 204
        }));

    server.get({
        path: '/volumereservations',
        name: 'ListVolumeReservations',
        version: '1.0.0'
    }, restify.queryParser(),
        validateListVolumeReservations, listVolumeReservations,
        renderVolumeReservations,
        renderingMiddlewares.makeSendResponseHandler({
            statusCode: 200
        }));
}

module.exports = {
    mount: mount
};
