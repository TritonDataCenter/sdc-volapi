/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var jsprim = require('jsprim');
var krill = require('krill');
var libuuid = require('libuuid');
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');

var errors = require('../errors');
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
    assert.func(callback, 'callback');

    var bestPackage;
    var err;

    packagesList.forEach(function updateBestPackage(candidatePackage) {
        var candidateIsLargeEnough = candidatePackage.quota
            >= requestedSize;
        var candidateSmallerThanBest = bestPackage === undefined ||
            candidatePackage.quota < bestPackage.quota;
        var candidateFitsBetter = candidateIsLargeEnough &&
            (bestPackage === undefined || candidateSmallerThanBest);

        if (candidateFitsBetter) {
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

    var papiClient = options.papiClient;
    assert.object(papiClient, 'papiClient');

    var requestedSize;

    try {
        requestedSize = volumeUtils.parseVolumeSize(volumeParams.size);
    } catch (parseVolumeSizeErr) {
        callback(parseVolumeSizeErr);
        return;
    }

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

function _buildStorageVMPayload(volumeParams, imageUuid, billingPackage) {

    assert.uuid(imageUuid, 'imageUuid');
    assert.object(volumeParams, 'volumeParams');
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
        uuid: libuuid.create(),
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
        networks: volumeParams.networks,
        owner_uuid: volumeParams.owner_uuid,
        tags: {
            smartdc_role: 'nfsserver'
        }
    };

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

function _isTransientVolumeUpdateError(volumeUpdateError) {
    assert.object(volumeUpdateError, 'volumeUpdateError');

    return [
        'BucketNotFoundError',
        'NoDatabaseError',
        'UniqueAttributeError',
        'InvalidIndexTypeError'
    ].indexOf(volumeUpdateError.name) === -1;
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

function _updateVolume(volume, options, callback) {
    if (typeof (options) === 'function') {
        callback = options;
        options = {};
    }

    assert.object(volume, 'volume');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(callback, 'callback');

    var log = options.log;
    var MAX_NB_VOLUME_UPDATE_TRIES = 10;
    var nbVolumeUpdateTries = 0;
    var RETRY_DELAY = 1000;

    function doUpdateVolume() {
        if (nbVolumeUpdateTries > MAX_NB_VOLUME_UPDATE_TRIES) {
            callback(new Error('Could not update volume after volume ' +
                'creation'));
            return;
        }

        ++nbVolumeUpdateTries;

        volumesModel.updateVolume(volume.uuid, volume, {
            etag: volume._etag
        }, function onVolumeUpdated(volumeUpdateErr) {
            if (volumeUpdateErr) {
                if (_isTransientVolumeUpdateError(volumeUpdateErr)) {
                    /*
                     * Updating the volume's state in moray failed but could
                     * eventually succeed if we retry, so we schedule a retry to
                     * happen later.
                     */
                    log.error({error: volumeUpdateErr},
                        'Got transient error when updating volume object, ' +
                            'retrying...');
                    setTimeout(RETRY_DELAY, doUpdateVolume);
                } else if (volumeUpdateErr.name === 'EtagConflictError') {
                    /*
                     * The volume being created was updated by another client,
                     * so we need to re-fetch the object to determine the state
                     * of the volume and what is the correct response.
                     */
                    log.error({error: volumeUpdateErr},
                        'Got etag conflict error when updating volume ' +
                            'object, reloading volume...');
                    volumesModel.loadVolume(volume.uuid,
                        function onVolumeLoaded(loadVolumeErr, loadedVolume) {
                            var err;

                            if (loadVolumeErr) {
                                if (_isTransientLoadVolumeErr(loadVolumeErr)) {
                                    log.error({error: loadVolumeErr},
                                        'Got transient error when reloading ' +
                                        'volume, retrying the whole update ' +
                                        'volume process...');
                                    setTimeout(RETRY_DELAY, doUpdateVolume);
                                } else {
                                    throw new Error('Non-transient error ' +
                                        'when  loading volume');
                                }

                                return;
                            }

                            if (loadedVolume === undefined) {
                                /*
                                 * A volume was created, but can't be loaded,
                                 * retry the update.
                                 */
                                log.error('loaded volume is undefined, ' +
                                    'retrying the whole update volume ' +
                                    'process...');
                                setTimeout(RETRY_DELAY, doUpdateVolume);
                            }

                            if (loadVolume.state !== volume.state) {
                                if (loadedVolume.state === 'failed') {
                                    /*
                                     * The volume was marked with state =
                                     * 'failed' by another client/process, so we
                                     * don't know why it's in that state.
                                     */
                                    err = new Error('Unknown error');
                                } else if (loadedVolume.state === 'ready') {
                                    if (!options.vmCreationPossiblyScheduled) {
                                        throw new Error('Invalid ' +
                                            'transition from state: ' +
                                            volume.state + ' to state: ' +
                                            loadedVolume.state +
                                            ' when VM creation not ' +
                                            'scheduled');
                                    }
                                }
                            }

                            callback(err, loadedVolume);
                        });
                } else {
                    throw new Error('Non-transient error when updating ' +
                        'volume');
                }
            } else {
                callback(null, volume);
            }
        });
    }

    doUpdateVolume();
}

function createVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.string(req.params.name, 'req.params.name');
    assert.string(req.params.owner_uuid, 'req.params.owner_uuid');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var ownerUuid = req.params.owner_uuid;
    var validationErrs = [];
    var validationErr;
    var vmapiClient = req._vmapiClient;
    var volumeName = req.params.name;
    var volumeUuid = libuuid.create();

    validationErr = volumesValidation.validateVolumeSize(req.params.size);
    if (validationErr !== undefined) {
        validationErrs.push(validationErr);
    }

    validationErr = volumesValidation.validateVolumeName(volumeName);
    if (validationErr !== undefined) {
        validationErrs.push(validationErr);
    }

    validationErr = volumesValidation.validateVolumeType(req.params.type);
    if (validationErr !== undefined) {
        validationErrs.push(validationErr);
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
        type: req.params.type
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
        function checkExistentVolume(ctx, done) {
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
                            ctx.volume = loadedVolume;
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
                        ctx.volume.size = bestPackage.quota;
                    }

                    ctx.bestPackage = bestPackage;

                    if (getPackageErr) {
                        err = new errors.InternalError(getPackageErr,
                            'Error when getting best package for volume');
                    }

                    done(err);
                });
        },
        function createStorageVM(ctx, done) {
            assert.object(volumeParams, 'volumeParams');
            assert.uuid(CONFIG.nfsServerImageUuid, 'CONFIG.nfsServerImageUuid');
            assert.object(ctx.bestPackage, 'ctx.bestPackage');

            var storageVmPayload =
                _buildStorageVMPayload(volumeParams, CONFIG.nfsServerImageUuid,
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

                if (!vmCreationErr || vmCreationErr.code !== 409) {
                    ctx.volume.vm_uuid = storageVmPayload.uuid;
                    ctx.vmCreationPossiblyScheduled = true;
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
        var vmCreationPossiblyScheduled = context.vmCreationPossiblyScheduled;
        var volume = context.volume;

        if (volumeCreationErr && volume) {
            volume.state = 'failed';
        }

        /*
         * If we have a volume object, it means we at least got to the point of
         * creating a model object. So regardless of the whole volume creation
         * being successful or not, we need to update that object so that its
         * properties are up to date (e.g status and vm_uuid).
         *
         * If we don't have a volume object, it means the whole volume creation
         * process failed before a volume model object could be created. Thus,
         * there's nothing to update and we can directly return the associated
         * error.
         */
        if (volume) {
            /*
             * Since the storage VM creation process is asynchronous from the
             * volume creation process, at this point, the only valid states for
             * the newly created volume are 'creating' and 'failed'.
             */
            assert.ok(volume.state === 'creating' || volume.state === 'failed');
            _updateVolume(volume, {
                log: req.log,
                vmCreationPossiblyScheduled: vmCreationPossiblyScheduled
            }, function onVolumeUpdated(volumeUpdateErr, updatedVolume) {
                var responseErr;

                req.volume = updatedVolume;

                if (!volumeUpdateErr) {
                    responseErr = volumeCreationErr;
                } else {
                    responseErr = new errors.InternalError(volumeUpdateErr,
                        'Error when updating volume in moray');
                }

                if (!volumeCreationErr && !volumeUpdateErr) {
                    res.status = 202;
                }

                _releaseTicketAndSendResponse(ticket, req, res, next,
                    responseErr);
            });
        } else {
            assert.object(volumeCreationErr, 'volumeCreationErr');

            _releaseTicketAndSendResponse(ticket, req, res, next,
                volumeCreationErr);
        }
    });
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

function _getVolumeReferences(volume, options, callback) {
    assert.object(volume, 'volume');
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
            { eq: ['required_nfs_volumes', volume.name] }
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
    assert.object(req.volume, 'req.volume');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volume = req.volume;
    _getVolumeReferences(volume, {
        vmapiClient: req._vmapiClient
    }, function volumeRefsListed(err, volumeRefs) {
        req.volumeReferences = volumeRefs;
        next(err);
    });
}

function deleteVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeUuid = req.params.uuid;
    var ownerUuid = req.query.owner_uuid;
    var context = {};

    req.log.debug({uuid: volumeUuid}, 'Start deleting volume');

    vasync.pipeline({
        funcs: [
            function acquireVolumeTicket(ctx, done) {
                assert.object(req.volume, 'req.volume');

                var volume = req.volume;
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
                assert.object(req.volume, 'req.volume');

                req.log.debug({volume: req.volume},
                    'Check volume is not currently required by any VM');

                var volume = req.volume;
                var err;

                _getVolumeReferences(volume, {
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
                                err = new errors.VolumeInUseError(volume.name);
                            }

                            done(err);
                        }
                    });
            },
            function checkOwnedByProperOwner(ctx, done) {
                var volume = req.volume;
                var err;

                if (ownerUuid !== undefined && volume &&
                    volume.owner_uuid !== ownerUuid) {
                    err = new Error('Volume ' + volume.uuid
                        + ' is not owned by owner ' + ownerUuid);
                }

                done(err);
            },
            function getStorageVm(ctx, done) {
                assert.object(req.volume, 'req.volume');

                /*
                 * By default, we consider that the storage VM associated with
                 * the volume being deleted doesn't need to be deleted. We'll
                 * consider it to need to be deleted only if the storage VM can
                 * be found and fetched from VMAPI.
                 */
                ctx.storageVmNeedsDeletion = false;

                req.log.debug({volume: req.volume},
                    'Loading volume\'s storage VM');

                var volume = req.volume;
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
                assert.object(req.volume, 'req.volume');
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                var volume = req.volume;

                if (!ctx.storageVmNeedsDeletion) {
                    volume.state = 'deleted';
                    volumesModel.updateVolume(volume.uuid, volume, done);
                } else {
                    done();
                }
            },
            function markVolumeAsDeleting(ctx, done) {
                assert.object(req.volume, 'req.volume');
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                if (!ctx.storageVmNeedsDeletion) {
                    done();
                    return;
                }

                var volume = req.volume;

                req.log.debug({volume: req.volume},
                    'Marking volume as deleting');

                volume.state = 'deleting';
                volumesModel.updateVolume(volume.uuid, volume, done);
            },
            function deleteStorageVm(ctx, done) {
                assert.object(req.volume, 'req.volume');
                assert.optionalObject(ctx.storageVm, 'ctx.storageVm');
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                if (!ctx.storageVmNeedsDeletion) {
                    done();
                    return;
                }

                req.log.debug({
                    volume: req.volume,
                    storageVm: ctx.storageVm
                }, 'Deleting storage VM');

                var volume = req.volume;
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

function loadVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.uuid(req.params.uuid, 'req.params.uuid');
    assert.optionalUuid(req.params.owner_uuid, 'req.params.owner_uuid');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeUuid = req.params.uuid;
    var ownerUuid = req.params.owner_uuid;

    req.log.debug({uuid: volumeUuid}, 'Loading volume');

    volumesModel.loadVolume(volumeUuid, function onVolumesLoaded(err, volume) {
        if (!err) {
            if (!volume) {
                err = new Error('No volume with uuid ' + volumeUuid
                    + ' could be found');
            } else {
                if (ownerUuid !== undefined &&
                    volume.owner_uuid !== ownerUuid) {
                    err = new Error('owner_uuid'  + ownerUuid
                        + ' does not match owner_uuid for volume '
                        + volumeUuid);
                } else {
                    req.volume = volume;
                }
            }
        }

        next(err);
    });
}

function renderVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    assert.object(req.volume, 'req.volume');

    req.renderedResponse = req.volume;
    next();
}

function renderVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    assert.object(req.volumes, 'req.volumes');

    req.renderedResponse = req.volumes;
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
        assert.object(req.renderedResponse, 'req.renderedResponse');

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
     }, restify.queryParser(), loadVolume, renderVolume,
        makeSendResponseHandler({
            statusCode: 200
        }));

    server.del({
        path: '/volumes/:uuid',
        name: 'DeleteVolume',
        version: '1.0.0'
    }, restify.queryParser(), loadVolume, deleteVolume,
        function renderDeletedVolume(req, res, next) {
            // Explicitly send an empty response
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
     }, restify.queryParser(), loadVolume, getVolumeReferences,
        renderVolumeReferences, makeSendResponseHandler({
            statusCode: 200
        }));
}

module.exports = {
    mount: mount
};
