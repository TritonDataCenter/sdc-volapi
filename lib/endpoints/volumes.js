/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var krill = require('krill');
var libuuid = require('libuuid');
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');

var errors = require('../errors');
var networksValidation = require('../validation/networks');
var predicateValidation = require('../validation/predicate');
var units = require('../units');
var volumesModel = require('../models/volumes');
var volumeUtils = require('../volumes');
var volumesValidation = require('../validation/volumes');

var CONFIG;
var APPLICATION_STATE;

/* JSSTYLED */
var NFS_SHARED_VOLUME_ZONE_USER_SCRIPT = "#!/usr/bin/bash\n#\n# This Source Code Form is subject to the terms of the Mozilla Public\n# License, v. 2.0. If a copy of the MPL was not distributed with this\n# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n#\n\n#\n# Copyright (c) 2014, Joyent, Inc.\n#\n\nexport PS4='[\\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'\n\nset -o xtrace\nset -o errexit\nset -o pipefail\n\n#\n# The presence of the /var/svc/.ran-user-script file indicates that the\n# instance has already been setup (i.e. the instance has booted previously).\n#\n# Upon first boot, run the setup.sh script if present. On all boots including\n# the first one, run the configure.sh script if present.\n#\n\nSENTINEL=/var/svc/.ran-user-script\n\nDIR=/opt/smartdc/boot\n\nif [[ ! -e ${SENTINEL} ]]; then\n    if [[ -f ${DIR}/setup.sh ]]; then\n        ${DIR}/setup.sh 2>&1 | tee /var/svc/setup.log\n    fi\n\n    touch ${SENTINEL}\nfi\n\nif [[ ! -f ${DIR}/configure.sh ]]; then\n    echo \"Missing ${DIR}/configure.sh cannot configure.\"\n    exit 1\nfi\n\nexec ${DIR}/configure.sh\n";

var DEFAULT_NFS_SHARED_VOLUME_PACKAGE_SIZE_IN_MBS = 10 * units.MIBS_IN_GB;
assert.number(DEFAULT_NFS_SHARED_VOLUME_PACKAGE_SIZE_IN_MBS,
    'DEFAULT_NFS_SHARED_VOLUME_PACKAGE_SIZE_IN_MBS');

var VOLUME_TICKETS_SCOPE = 'nfs_volume';

function _selectBestPackage(requestedSize, packagesList, options, callback) {
    assert.number(requestedSize, 'requestedSize');
    assert.arrayOfObject(packagesList, 'packagesList');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(callback, 'callback');

    var bestPackage;
    var err;
    var log = options.log;

    packagesList.forEach(function updateBestPackage(candidatePackage) {
        var candidateIsLargeEnough = candidatePackage.quota
            >= requestedSize;
        var candidateSmallerThanBest = bestPackage === undefined ||
            candidatePackage.quota < bestPackage.quota;
        var candidateFitsBetter = candidateIsLargeEnough &&
            (bestPackage === undefined || candidateSmallerThanBest);

        log.debug({package: candidatePackage}, 'considering package...');
        if (candidateFitsBetter) {
            log.debug({
                package: candidatePackage,
                oldBestFit: bestPackage
            }, 'package is better fit than current best fit');
            bestPackage = candidatePackage;
        }
    });

    if (bestPackage === undefined) {
        err = new Error('Could not find package');
    }

    callback(err, bestPackage);
}

function _getBestPackage(volumeParams, options, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(callback, 'callback');

    var log = options.log;
    var papiClient = options.papiClient;
    assert.object(papiClient, 'papiClient');

    var requestedSize = volumeParams.size;

    if (requestedSize === undefined) {
        requestedSize = DEFAULT_NFS_SHARED_VOLUME_PACKAGE_SIZE_IN_MBS;
    }

    var context = {};
    vasync.pipeline({
        funcs: [
            function getNfsSharedVolumesPackages(ctx, next) {
                papiClient.list({}, {
                    name: 'sdc_volume_nfs*'
                }, function onListDone(err, pkgs, count) {
                    ctx.nfsSharedVolumesPkgs = pkgs;
                    next(err);
                });
            },
            function selectBestPackage(ctx, next) {
                _selectBestPackage(requestedSize, ctx.nfsSharedVolumesPkgs,
                    options, function onBestPackageSelected(err, bestPackage) {
                        if (bestPackage !== undefined) {
                            log.debug({package: bestPackage},
                                'Best package found');
                        } else {
                            log.debug('Could not find best package');
                        }

                        ctx.bestPackage = bestPackage;
                        next(err);
                    });
            }
        ],
        arg: context
    }, function onBestPackageSelect(err) {
        callback(err, context.bestPackage);
    });
}

function _buildStorageVMPayload(volumeParams, storageVmUuid, imageUuid,
    billingPackage) {
    assert.object(volumeParams, 'volumeParams');
    assert.uuid(storageVmUuid, 'storageVmUuid');
    assert.uuid(imageUuid, 'imageUuid');
    assert.object(billingPackage, 'billingPackage');
    assert.string(billingPackage.uuid, 'billingPackage.uuid');

    var nfsExportsDirName = volumeUtils.NFS_SHARED_VOLUME_EXPORTS_DIRNAME;
    // alias is of the form VOLUME-PREFIX-${volume-uuid} to allow for easier
    // troubleshooting on the CN, while still allowing for unique aliases.
    var volumeAlias = [
        volumeUtils.NFS_SHARED_VOLUME_VM_ALIAS_PREFIX,
        volumeParams.uuid
    ].join('-');

    var payload = {
        uuid: storageVmUuid,
        image_uuid: imageUuid,
        billing_id: billingPackage.uuid,
        alias: volumeAlias,
        brand: 'joyent-minimal',
        customer_metadata: {
            'export-volumes': '["' + nfsExportsDirName + '"]',
            'user-script': NFS_SHARED_VOLUME_ZONE_USER_SCRIPT
        },
        // Use a delegate dataset so that data is not lost if the storage
        // VM is lost.
        delegate_dataset: true,
        owner_uuid: volumeParams.owner_uuid,
        tags: {
            smartdc_role: 'nfsserver'
        }
    };

    if (volumeParams.networks !== undefined) {
        payload.networks = volumeParams.networks;
    }

    return payload;
}

function _acquireVolumeTicket(ticketId, options, callback) {
    assert.string(ticketId, 'ticketId');
    assert.object(options, 'options');
    assert.object(options.cnapiClient, 'options.cnapiClient');
    assert.object(options.log, 'options.log');
    assert.func(callback, 'callback');

    var cnapiClient = options.cnapiClient;
    var ticketParams = {
        scope: VOLUME_TICKETS_SCOPE,
        id: ticketId,
        // 10 minutes
        expires_at: (new Date(Date.now() + 600 * 1000).toString())
    };
    var log = options.log;

    log.debug({ticketParams: ticketParams}, 'Acquiring volume ticket');

    cnapiClient.listServers({
        headnode: true
    }, function onListHeadnode(listHeadnodeErr, servers) {
        assert.optionalArrayOfObject(servers, 'servers');

        if (!servers || servers.length === 0) {
            callback(new Error('Headnode server not found in CNAPI'));
            return;
        }

        if (servers.length > 1) {
            callback(new Error('More than one headnode server found in CNAPI'));
            return;
        }

        var headnodeUuid = servers[0].uuid;
        assert.string(headnodeUuid, 'headnodeUuid');

        cnapiClient.waitlistTicketCreate(headnodeUuid, ticketParams,
            function onTicketCreated(ticketCreationErr, ticket) {
                if (ticketCreationErr) {
                    callback(ticketCreationErr);
                    return;
                }

                cnapiClient.waitlistTicketWait(ticket.uuid,
                    function onTicketReleasedOrExpired(err) {
                        cnapiClient.waitlistTicketGet(ticket.uuid, callback);
                    });
            });
    });
}

function _releaseVolumeTicket(ticket, options, callback) {
    assert.object(ticket, 'ticket');
    assert.object(options, 'options');
    assert.object(options.cnapiClient, 'options.cnapiClient');
    assert.object(options.log, 'options.log');
    assert.func(callback, 'callback');

    var cnapiClient = options.cnapiClient;
    var log = options.log;

    log.debug({ticket: ticket}, 'Releasing volume ticket');

    cnapiClient.waitlistTicketRelease(ticket.uuid, callback);
}

function _isTransientLoadVolumeErr(volumeLoadError) {
    assert.object(volumeLoadError, 'volumeLoadError');

    return [
        'BucketNotFoundError',
        'ObjectNotFoundError',
        'NoDatabaseError'
    ].indexOf(volumeLoadError.name) === -1;
}

function _releaseTicketAndSendResponse(ticket, req, res, next, error) {
    assert.object(ticket, 'ticket');
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');
    assert.optionalObject(error, 'error');

    if (ticket !== undefined) {
        _releaseVolumeTicket(ticket, {
            cnapiClient: req._cnapiClient,
            log: req.log
        }, function onTicketReleased() {
            /*
             * We explicitly ignore errors when releasing volume tickets,
             * because there's not much we can do in that case.
             */
            next(error);
        });
    } else {
        next(error);
    }
}

function createVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var networkValidationErrs;
    var ownerUuid = req.params.owner_uuid;
    var validationErr;
    var validationErrs = [];
    var vmapiClient = req._vmapiClient;
    var volumeName = req.params.name;
    var volumeUuid = libuuid.create();

    validationErr = volumesValidation.validateOwnerUuid(req.params.owner_uuid);
    if (validationErr !== undefined) {
        validationErrs.push(validationErr);
    }

    if (req.params.size !== undefined) {
        validationErr = volumesValidation.validateVolumeSize(req.params.size);
        if (validationErr !== undefined) {
            validationErrs.push(validationErr);
        }
    }

    validationErr = volumesValidation.validateVolumeName(volumeName);
    if (validationErr !== undefined) {
        validationErrs.push(validationErr);
    }

    validationErr = volumesValidation.validateVolumeType(req.params.type);
    if (validationErr !== undefined) {
        validationErrs.push(validationErr);
    }

    if (!Array.isArray(req.params.networks)) {
        validationErrs.push(new Error('networks must be an array'));
    } else {
        networkValidationErrs =
            req.params.networks
                .map(networksValidation.validateNetwork)
                .filter(function filterErrors(error) {
                    return error !== undefined;
                });
        if (networkValidationErrs.length > 0) {
            validationErrs = validationErrs.concat(networkValidationErrs);
        }
    }

    if (validationErrs.length > 0) {
        next(new errors.ValidationError(validationErrs));
        return;
    }

    req.log.debug({params: req.params}, 'createVolume');

    var volumeParams = {
        uuid: volumeUuid,
        name: volumeName,
        owner_uuid: ownerUuid,
        networks: req.params.networks,
        type: req.params.type,
        size: req.params.size
    };

    var context = {};

    vasync.pipeline({funcs: [
        function acquireVolumeTicket(ctx, done) {
            var ticketId = ownerUuid + '-' + volumeName;

            _acquireVolumeTicket(ticketId, {
                cnapiClient: req._cnapiClient,
                log: req.log
            }, function onTicketAcquired(acquireTicketErr, ticket) {
                var err = acquireTicketErr;

                ctx.ticket = ticket;

                if (!ticket) {
                    err =
                        new Error('missing ticket after trying to acquire it');
                    done(new errors.InternalError(err, 'Error'));
                    return;
                }

                if (ticket && ticket.status !== 'active') {
                    err = new Error('Could not acquire ticket, ticket is not '
                        + 'active and instead is: ' + ticket.status);
                    done(new errors.InternalError(err));
                    return;
                }

                if (err) {
                    done(new errors.InternalError(err,
                        'Error when acquiring volume ticket'));
                } else {
                    req.log.debug({ticket: ticket},
                        'Volume creation ticket acquired');
                    done();
                }
            });
        },
        function checkDuplicateVolume(ctx, done) {
            req.log.debug({name: volumeParams.name},
                'Checking if volume with same name already exists');

            volumesModel.listVolumes({
                name: volumeParams.name,
                owner_uuid: volumeParams.owner_uuid,
                predicate: krill.createPredicate({
                    or: [
                        {eq: ['state', 'ready']},
                        {eq: ['state', 'creating']}
                    ]
                })
            }, function onVolumesListed(err, volumes) {
                if (!err && volumes.length > 0) {
                    err =
                        new errors.VolumeAlreadyExistsError(volumeParams.name);
                }

                done(err);
            });
        },
        function createVolumeModel(ctx, done) {
            assert.object(ctx.ticket, 'ctx.ticket');

            req.log.debug({volumeParams: volumeParams},
                'Creating volume model');

            volumesModel.createVolume(volumeParams,
                function onVolumeModelCreated(volumeCreationErr) {
                    var err;

                    if (volumeCreationErr) {
                        err = new errors.InternalError(volumeCreationErr,
                            'Error when creating volume model');
                    }

                    done(err);
                });
        },
        function loadNewVolume(ctx, done) {
            req.log.debug({volumeUuid: volumeUuid}, 'Loading volume object');

            function doLoadVolume() {
                volumesModel.loadVolume(volumeUuid,
                    function onVolumeLoaded(loadVolumeErr, loadedVolume) {
                        var err;

                        if (loadVolumeErr &&
                            _isTransientLoadVolumeErr(loadVolumeErr)) {
                            setTimeout(1000, doLoadVolume);
                            return;
                        }

                        if (!loadVolumeErr && loadedVolume) {
                            ctx.volumeObject = loadedVolume;
                        }

                        if (loadVolumeErr) {
                            err = new errors.InternalError(loadVolumeErr,
                                'Error when loading volume model');
                        }

                        done(err);
                    });
            }

            doLoadVolume();
        },
        function getBestPackage(ctx, done) {
            var options = {
                log: req.log,
                papiClient: req._papiClient
            };

            req.log.debug({volumeParams: volumeParams},
                'Finding most suitable package');

            _getBestPackage(volumeParams, options,
                function onPackage(getPackageErr, bestPackage) {
                    var err;

                    if (!getPackageErr && bestPackage) {
                        ctx.volumeObject.value.size = bestPackage.quota;
                    }

                    ctx.bestPackage = bestPackage;

                    if (getPackageErr) {
                        err = new errors.InternalError(getPackageErr,
                            'Error when getting best package for volume');
                    }

                    done(err);
                });
        },
        /*
         * In order to avoid concurrent updates racing (recording the storage
         * VM's uuid in Moray and recording the storage VM's state changes in
         * Moray), we create the storage VM's uuid in advance so that we can
         * record it in moray _before_ starting the VM creation process.
         */
        function recordStorageVmUuid(ctx, done) {
            var storageVmUuid = libuuid.create();
            var volume = context.volumeObject.value;

            ctx.storageVmUuid = volume.vm_uuid = storageVmUuid;

            volumesModel.updateVolumeWithRetry(volume.uuid,
                context.volumeObject, done);
        },
        function createStorageVM(ctx, done) {
            assert.object(volumeParams, 'volumeParams');
            assert.uuid(CONFIG.nfsServerImageUuid, 'CONFIG.nfsServerImageUuid');
            assert.object(ctx.bestPackage, 'ctx.bestPackage');
            assert.uuid(ctx.storageVmUuid, 'ctx.storageVmUuid');

            var storageVmPayload =
                _buildStorageVMPayload(volumeParams, ctx.storageVmUuid,
                    CONFIG.nfsServerImageUuid,
                    ctx.bestPackage);
            req.log.debug({vmPayload: storageVmPayload}, 'Creating storage VM');

            vmapiClient.createVm({
                payload: storageVmPayload
            }, {
                headers: {'x-request-id': req.getId()}
            }, function onVmCreated(vmCreationErr, vmCreationObj) {
                var err;

                if (vmCreationErr) {
                    req.log.error({error: vmCreationErr},
                        'Error when creating storage VM');
                } else {
                    req.log.debug({
                        vmCreation: vmCreationObj,
                        error: vmCreationErr
                    }, 'Storage VM created');
                }

                if (vmCreationErr) {
                    err = new errors.InternalError(vmCreationErr,
                        'Error when creating storage VM');
                }

                done(err);
            });
        }
    ],
    arg: context
    }, function onVolumeCreated(volumeCreationErr, results) {
        var ticket = context.ticket;
        var volume;
        var volumeObject = context.volumeObject;

        if (volumeCreationErr && volumeObject) {
            /*
             * If we have a volume object and the volume creation failed, it
             * means we at least got to the point of creating a model
             * object, but scheduling the storage VM creation failed. As a
             * result, the volapi-updater process will never update the
             * volume's state (since no VM associated with this volume will
             * change state), and thus it is safe to update the object in
             * moray without using an etag.
             */
            volume = volumeObject.value;
            volume.state = 'failed';

            volumesModel.updateVolumeWithRetry(volume.uuid, volumeObject,
            function onVolStateUpdated(volumeUpdateErr, updatedVolumeValue) {
                var responseErr;

                req.responseVolume = updatedVolumeValue;

                if (!volumeUpdateErr) {
                    responseErr = volumeCreationErr;
                } else {
                    if (volumeUpdateErr.name === 'EtagConflictError') {
                        /*
                         * Since scheduling the creation of the storage VM
                         * failed, and there's a ticket active on this volume,
                         * we don't expect any concurrent update to have been
                         * performed on the volume. As a result, any etag
                         * conflict error is unexpected and is a programming
                         * error. Even if at the time the response is received
                         * by the moray client, a significant part of the state
                         * that led to this error is lost, we might be able to
                         * gather some valuable information from a core dump, so
                         * we throw an error.
                         */
                        throw new Error('unexpected etag conflict when ' +
                            'updating volume state');
                    } else {
                        /*
                         * Any other error is also considered to be an
                         * operational error that is not worth retrying, so we
                         * send it along with the response.
                         */
                        responseErr = new errors.InternalError(volumeUpdateErr,
                            'Error when updating volume in moray');
                    }
                }

                if (!volumeCreationErr && !volumeUpdateErr) {
                    res.status = 202;
                }

                if (ticket) {
                    _releaseTicketAndSendResponse(ticket, req, res, next,
                        responseErr);
                } else {
                    next(responseErr);
                }
            });
        } else {
            /*
             * If we don't have a volume object, or if we don't have a volume
             * creation error object, it means the whole volume creation process
             * failed before a volume model object could be created or that it
             * succeeded. In the former case, there's nothing to update and we
             * can directly return the associated error. In the latter, the
             * volapi-updater process will take care of updating the newly
             * created volume's state and we can directly return the current
             * representation for the newly created volume object.
             */
            if (volumeObject) {
                req.responseVolume = volumeObject.value;
            }

            if (ticket) {
                _releaseTicketAndSendResponse(ticket, req, res, next,
                    volumeCreationErr);
            } else {
                next(volumeCreationErr);
            }
        }
    });
}

function validateGetVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var validationErr;
    var validationErrs = [];
    var VALID_PARAM_NAMES = ['owner_uuid', 'uuid'];
    var MANDATORY_PARAM_NAMES = ['uuid'];

    var mandatoryParamsErrs = checkMandatoryParamsPresence(req.params,
        MANDATORY_PARAM_NAMES);
    var invalidParamsErrs = checkInvalidParams(req.params, VALID_PARAM_NAMES);

    validationErrs = validationErrs.concat(mandatoryParamsErrs);
    validationErrs = validationErrs.concat(invalidParamsErrs);

    if (req.params.uuid) {
        validationErr = volumesValidation.validateVolumeUuid(req.params.uuid);
        if (validationErr !== undefined) {
            validationErrs.push(validationErr);
        }
    }

    if (req.params.owner_uuid) {
        validationErr =
            volumesValidation.validateOwnerUuid(req.params.owner_uuid);
        if (validationErr !== undefined) {
            validationErrs.push(validationErr);
        }
    }

    if (validationErrs.length > 0) {
        next(new errors.ValidationError(validationErrs));
        return;
    } else {
        next();
        return;
    }
}

function getVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    req.responseVolume = req.loadedVolumeObject.value;
    next();
}

function validateListVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var errs = [];
    var validationErr;
    var predicateValidationErr;

    if (req.query.predicate) {
        predicateValidationErr =
            predicateValidation.validatePredicate(req.query.predicate);
    }

    assert.optionalObject(predicateValidationErr, predicateValidationErr);
    if (predicateValidationErr !== undefined) {
        errs.push(predicateValidationErr);
    }

    if (errs.length > 0) {
        validationErr = next(new Error('Invalid list parameters: '
            + errs));
    }

    next(validationErr);
}

function listVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.query, 'req.query');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var predicate;

    if (req.query.predicate) {
        predicate = krill.createPredicate(JSON.parse(req.query.predicate));
    }

    volumesModel.listVolumes({
        owner_uuid: req.query.owner_uuid,
        name: req.query.name,
        predicate: predicate
    }, function onListVolumes(err, volumes) {
        req.volumes = volumes;
        next(err);
    });
}

function _getVolumeReferences(volumeObject, options, callback) {
    assert.object(volumeObject, 'volumeObject');
    assert.object(options, 'options');
    assert.object(options.vmapiClient, 'options.vmapiClient');
    assert.func(callback, 'callback');

    var vmapiClient = options.vmapiClient;
    var predicate = {
        and: [
            { and: [
                { ne: ['state', 'destroyed'] },
                { ne: ['state', 'failed'] }
            ] },
            { eq: ['required_nfs_volumes', volumeObject.value.name] }
        ]
    };

    vmapiClient.listVms({
        predicate: JSON.stringify(predicate)
    }, function vmsListed(err, vms) {
        var references;

        assert.optionalArrayOfObject(vms, 'vms');

        if (vms) {
            references = vms.map(function getVmURL(vm) {
                assert.object(vm, 'vm');
                return vm.uuid;
            });
        }

        callback(err, references);
    });
}

function getVolumeReferences(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.loadedVolumeObject, 'req.loadedVolumeObject');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeObject = req.loadedVolumeObject;
    _getVolumeReferences(volumeObject, {
        vmapiClient: req._vmapiClient
    }, function volumeRefsListed(err, volumeRefs) {
        req.volumeReferences = volumeRefs;
        next(err);
    });
}

function deleteVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.loadedVolumeObject, 'req.loadedVolumeObject');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeUuid = req.params.uuid;
    var ownerUuid = req.query.owner_uuid;
    var context = {};

    req.log.debug({uuid: volumeUuid}, 'Start deleting volume');

    vasync.pipeline({
        funcs: [
            function acquireVolumeTicket(ctx, done) {
                var volume = req.loadedVolumeObject.value;
                var volumeName = volume.name;
                var ticketId = ownerUuid + '-' + volumeName;

                _acquireVolumeTicket(ticketId, {
                    cnapiClient: req._cnapiClient,
                    log: req.log
                }, function onTicketAcquired(err, ticket) {
                    if (err) {
                        done(new Error('Error when acquiring ticket: ' + err));
                        return;
                    }

                    if (!ticket) {
                        done(new Error('Error when acquiring ticket'));
                        return;
                    }

                    if (ticket.status !== 'active') {
                        done(new Error('Could not acquire ticket, ticket is ' +
                            'not active and instead is: ' + ticket.status));
                        return;
                    }

                    req.log.debug({ticket: ticket},
                        'Volume deletion ticket acquired');

                    ctx.ticket = ticket;
                    done();
                });
            },
            function checkVolumeUnused(ctx, done) {
                req.log.debug({volumeObject: req.loadedVolumeObject},
                    'Check volume is not currently required by any VM');

                var err;
                var volumeObject = req.loadedVolumeObject;
                var volumeName = volumeObject.value.name;

                _getVolumeReferences(volumeObject, {
                        vmapiClient: req._vmapiClient
                    },
                    function referencesListed(listRefsErr, references) {
                        assert.optionalArrayOfString(references, 'references');

                        if (listRefsErr) {
                            req.log.error({error: listRefsErr},
                                'Error when listing volume references');
                            done(listRefsErr);
                        } else {
                            req.log.debug({references: references},
                                'references found');

                            if (references && references.length > 0) {
                                err = new errors.VolumeInUseError(volumeName);
                            }

                            done(err);
                        }
                    });
            },
            function getStorageVm(ctx, done) {
                var volume = req.loadedVolumeObject.value;
                /*
                 * By default, we consider that the storage VM associated with
                 * the volume being deleted doesn't need to be deleted. We'll
                 * consider it to need to be deleted only if the storage VM can
                 * be found and fetched from VMAPI.
                 */
                ctx.storageVmNeedsDeletion = false;

                req.log.debug({volume: volume}, 'Loading volume\'s storage VM');

                if (volume.vm_uuid === undefined) {
                    req.log.debug({volume: volume},
                        'No storage VM for this volume, skipping loading it');
                    done();
                    return;
                }

                req._vmapiClient.getVm({
                    uuid: volume.vm_uuid
                }, function onGetStorageVm(getVmErr, vm) {
                    if (getVmErr) {
                        if (getVmErr.statusCode === 404) {
                            /*
                             * We couldn't find the storage VM associated with
                             * that VM. It is not considered to be an error, as
                             * it could happen e.g if the volume creation
                             * process did not create the VM properly, and it
                             * doesn't prevent the volume from being considered
                             * deleted.
                             */
                            req.log.info({vm_uuid: volume.vm_uuid},
                                'Could not find VM, skipping VM deletion');
                            done();
                            return;
                        } else {
                            req.log.error({error: getVmErr},
                                'Error when loading storage VM');
                            done(getVmErr);
                            return;
                        }
                    }

                    if (vm.state !== 'destroyed') {
                        ctx.storageVmNeedsDeletion = true;
                        ctx.storageVm = vm;
                    }

                    done();
                });
            },
            function markVolumeAsDeleted(ctx, done) {
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                var volumeObject = req.loadedVolumeObject;

                if (!ctx.storageVmNeedsDeletion) {
                    volumeObject.value.state = 'deleted';
                    volumesModel.updateVolumeWithRetry(volumeObject.value.uuid,
                        volumeObject, done);
                } else {
                    done();
                }
            },
            function markVolumeAsDeleting(ctx, done) {
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                if (!ctx.storageVmNeedsDeletion) {
                    done();
                    return;
                }

                var volumeObject = req.loadedVolumeObject;

                req.log.debug({volumeObject: req.loadedVolumeObject},
                    'Marking volume as deleting');

                volumeObject.value.state = 'deleting';
                volumesModel.updateVolumeWithRetry(volumeObject.value.uuid,
                    volumeObject, done);
            },
            function deleteStorageVm(ctx, done) {
                assert.optionalObject(ctx.storageVm, 'ctx.storageVm');
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                var volume = req.loadedVolumeObject.value;

                if (!ctx.storageVmNeedsDeletion) {
                    done();
                    return;
                }

                req.log.debug({
                    volume: volume,
                    storageVm: ctx.storageVm
                }, 'Deleting storage VM');

                assert.uuid(volume.vm_uuid, 'volume.vm_uuid');

                req._vmapiClient.deleteVm({
                    uuid: volume.vm_uuid,
                    owner: volume.owner_uuid
                }, done);
            }
        ],
        arg: context
    }, function allDone(err) {
        if (context.ticket !== undefined) {
            _releaseVolumeTicket(context.ticket, {
                cnapiClient: req._cnapiClient,
                log: req.log
            }, function onTicketReleased() {
                // We explicitly ignore errors when releasing volume tickets,
                // because there's not much we can do in that case. Instead, we
                // propagate the error that happened in the vasync pipeline if
                // there's one.
                next(err);
            });
        } else {
            next(err);
        }
    });
}

function loadVolumeObject(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.uuid(req.params.uuid, 'req.params.uuid');
    assert.optionalUuid(req.params.owner_uuid, 'req.params.owner_uuid');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeUuid = req.params.uuid;
    var ownerUuid = req.params.owner_uuid;

    req.log.debug({uuid: volumeUuid}, 'Loading volume');

    volumesModel.loadVolume(volumeUuid,
        function onVolumesLoaded(err, volumeObject) {
            if (!err) {
                if (!volumeObject) {
                    err = new Error('No volume with uuid ' + volumeUuid
                        + ' could be found');
                } else {
                    if (ownerUuid !== undefined &&
                        volumeObject.value.owner_uuid !== ownerUuid) {
                        err = new Error('owner_uuid: '  + ownerUuid
                            + ' does not match owner_uuid for volume '
                            + volumeUuid + ' ('
                            + volumeObject.value.owner_uuid + ')');
                    } else {
                        req.loadedVolumeObject = volumeObject;
                    }
                }
            } else {
                req.log.error({err: err},
                    'Error when loading volume object from moray');

                if (err.name === 'ObjectNotFoundError') {
                    err = new errors.VolumeNotFoundError(volumeUuid);
                }
            }

            next(err);
        });
}

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

function validateUpdateVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var validationErr;
    var validationErrs = [];
    var VALID_PARAM_NAMES = ['name', 'owner_uuid', 'uuid'];
    var MANDATORY_PARAM_NAMES = ['uuid'];

    var mandatoryParamsErrs = checkMandatoryParamsPresence(req.params,
        MANDATORY_PARAM_NAMES);
    var invalidParamsErrs = checkInvalidParams(req.params, VALID_PARAM_NAMES);

    validationErrs = validationErrs.concat(mandatoryParamsErrs);
    validationErrs = validationErrs.concat(invalidParamsErrs);

    if (req.params.uuid) {
        validationErr = volumesValidation.validateVolumeUuid(req.params.uuid);
        if (validationErr !== undefined) {
            validationErrs.push(validationErr);
        }
    }

    if (req.params.owner_uuid) {
        validationErr =
            volumesValidation.validateOwnerUuid(req.params.owner_uuid);
        if (validationErr !== undefined) {
            validationErrs.push(validationErr);
        }
    }

    if (req.params.name) {
        validationErr = volumesValidation.validateVolumeName(req.params.name);
        if (validationErr !== undefined) {
            validationErrs.push(validationErr);
        }
    }

    if (validationErrs.length > 0) {
        next(new errors.ValidationError(validationErrs));
        return;
    } else {
        next();
        return;
    }
}

function updateVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.loadedVolumeObject, 'req.loadedVolumeObject');
    assert.object(req.params, 'req.params');
    assert.uuid(req.params.uuid, 'req.params.uuid');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var context = {};
    var ownerUuid = req.loadedVolumeObject.owner_uuid;
    var newVolumeName = req.params.name;

    vasync.pipeline({funcs: [
        function acquireVolumeTicket(ctx, done) {
            /*
             * We want to acquire a ticket so that another volume with the same
             * name as the name we're renaming this volume to is not created,
             * and we don't end up with two volumes with the same name. If the
             * update request doesn't change the volume's name, there's no need
             * to acquire a ticket.
             */
            if (newVolumeName === undefined) {
                done();
                return;
            }

            var ticketId = ownerUuid + '-' + newVolumeName;

            _acquireVolumeTicket(ticketId, {
                cnapiClient: req._cnapiClient,
                log: req.log
            }, function onTicketAcquired(acquireTicketErr, ticket) {
                var err = acquireTicketErr;

                ctx.ticket = ticket;

                if (!ticket) {
                    err =
                        new Error('missing ticket after trying to acquire it');
                    done(new errors.InternalError(err, 'Error'));
                    return;
                }

                if (ticket && ticket.status !== 'active') {
                    err = new Error('Could not acquire ticket, ticket is not '
                        + 'active and instead is: ' + ticket.status);
                    done(new errors.InternalError(err));
                    return;
                }

                if (err) {
                    done(new errors.InternalError(err,
                        'Error when acquiring volume ticket'));
                } else {
                    req.log.debug({ticket: ticket},
                        'Volume creation ticket acquired');
                    done();
                }
            });
        },
        function checkDuplicateVolume(ctx, done) {
            /*
             * If the volume name is not being changed, there's no point in
             * checking wether the new name is already used by an existing
             * volume for the volume's owner.
             */
            if (newVolumeName === undefined) {
                done();
                return;
            }

            req.log.debug({newVolumeName: newVolumeName},
                'Checking if volume with same name already exists');

            volumesModel.listVolumes({
                name: newVolumeName,
                owner_uuid: ownerUuid,
                predicate: krill.createPredicate({
                    or: [
                        {eq: ['state', 'ready']},
                        {eq: ['state', 'creating']}
                    ]
                })
            }, function onVolumesListed(err, volumes) {
                if (!err && volumes.length > 0) {
                    err =
                        new errors.VolumeAlreadyExistsError(newVolumeName);
                }

                done(err);
            });
        },
        function checkVolumeUnused(ctx, done) {
            /*
             * If the volume name is not being changed, there's no point in
             * checking wether the volume is referenced by a VM.
             */
            if (newVolumeName === undefined) {
                done();
                return;
            }

            req.log.debug({volumeObject: req.loadedVolumeObject},
                'Check volume is not currently required by any VM');

            var err;
            var volumeObject = req.loadedVolumeObject;
            var volumeName = volumeObject.value.name;

            _getVolumeReferences(volumeObject, {
                    vmapiClient: req._vmapiClient
                },
                function referencesListed(listRefsErr, references) {
                    assert.optionalArrayOfString(references, 'references');

                    if (listRefsErr) {
                        req.log.error({error: listRefsErr},
                            'Error when listing volume references');
                        done(listRefsErr);
                    } else {
                        req.log.debug({references: references},
                            'references found');

                        if (references && references.length > 0) {
                            err = new errors.VolumeInUseError(volumeName);
                        }

                        done(err);
                    }
                });
            },
        function changeVolume(ctx, done) {
            var volumeObject = req.loadedVolumeObject;

            volumeObject.value.name = req.params.name;
            volumesModel.updateVolumeWithRetry(volumeObject.value.uuid,
                volumeObject, done);
        }
    ],
    arg: context
    }, function onVolumeNameUpdated(err) {
        if (context.ticket !== undefined) {
            _releaseVolumeTicket(context.ticket, {
                cnapiClient: req._cnapiClient,
                log: req.log
            }, function onTicketReleased() {
                // We explicitly ignore errors when releasing volume tickets,
                // because there's not much we can do in that case. Instead, we
                // propagate the error that happened in the vasync pipeline if
                // there's one.
                next(err);
            });
        } else {
            next(err);
        }
    });
}

function renderVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    assert.object(req.responseVolume, 'req.responseVolume');

    req.renderedResponse = req.responseVolume;
    next();
}

function renderVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    assert.object(req.volumes, 'req.volumes');

    req.renderedResponse = req.volumes.map(function getVolumeValue(volObject) {
        assert.object(volObject, 'volObject');
        return volObject.value;
    });

    next();
}

function renderVolumeReferences(req, res, next) {
    var volumeReferences;

    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    assert.object(req.volumeReferences, 'req.volumeReferences');
    volumeReferences = req.volumeReferences;
    req.renderedResponse = volumeReferences;

    next();
}

function makeSendResponseHandler(options) {
    assert.object(options, 'options');

    var statusCode = options.statusCode || 200;

    return function sendResponseHandler(req, res, next) {
        assert.optionalObject(req.renderedResponse, 'req.renderedResponse');

        res.send(statusCode, req.renderedResponse);
        next();
    };
}

function checkNfsServerImgImported(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    if (APPLICATION_STATE.nfsServerImageImported !== true) {
        next(new Error('nfsserver image not yet imported'));
    } else {
        next();
    }
}

function mount(config, server, applicationState) {
    assert.object(config, 'config');
    assert.object(server, 'server');
    assert.object(applicationState, 'applicationState');

    CONFIG = config;
    APPLICATION_STATE = applicationState;

    server.post({
        path: '/volumes',
        name: 'CreateVolume',
        version: '1.0.0'
    }, checkNfsServerImgImported,
        restify.bodyParser(),
        createVolume, renderVolume,
        makeSendResponseHandler({
            statusCode: 201
        }));

    server.get({
        path: '/volumes',
        name: 'ListVolumes',
        version: '1.0.0'
    }, restify.queryParser(), validateListVolumes, listVolumes, renderVolumes,
        makeSendResponseHandler({
            statusCode: 200
        }));

     server.get({
         path: '/volumes/:uuid',
         name: 'GetVolume',
         version: '1.0.0'
     }, restify.queryParser(), validateGetVolume, loadVolumeObject, getVolume,
        renderVolume,
        makeSendResponseHandler({
            statusCode: 200
        }));

    server.del({
        path: '/volumes/:uuid',
        name: 'DeleteVolume',
        version: '1.0.0'
    }, restify.queryParser(), loadVolumeObject, deleteVolume,
        function renderDeletedVolume(req, res, next) {
            /*
             * It seems we need to explicitly send an empty response for some
             * HTTP clients to be able to determine that there's nothing to
             * read.
             */
            req.renderedResponse = {};
            next();
        },
        makeSendResponseHandler({
            statusCode: 204
        }));

    server.get({
         path: '/volumes/:uuid/references',
         name: 'GetVolumeReferences',
         version: '1.0.0'
     }, restify.queryParser(), loadVolumeObject, getVolumeReferences,
        renderVolumeReferences, makeSendResponseHandler({
            statusCode: 200
        }));

    server.post({
        path: '/volumes/:uuid',
        name: 'UpdateVolume',
        version: '1.0.0'
    }, restify.bodyParser(), validateUpdateVolume, loadVolumeObject,
        /*
         * We purposedly do _not_ render the volume, as we would need to either:
         *
         * 1. render the original volume, which is not useful when we try to
         * update (change) it.
         *
         * 2. render the result of the update, which would require to load the
         * volume object from moray, adding more latency to the request's
         * response.
         *
         * Instead, we reply with a 204 HTTP status code (no content) and
         * clients can send a GetVolume request if/when they want to get the
         * representation of the modified volume.
         */
        updateVolume, makeSendResponseHandler({
            statusCode: 204
        }));
}

module.exports = {
    mount: mount
};
