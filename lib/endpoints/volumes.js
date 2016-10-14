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

function _getImage(volumeParams, options, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var imgapiClient = options.imgapiClient;
    assert.object(imgapiClient, 'imgapiClient');

    imgapiClient.listImages({
        name: 'nfsserver'
    }, function onListImagesDone(err, images) {
        var bestImage;

        if (!err) {
            if (images.length < 1) {
                err = new Error('Could not find image');
            } else {
                bestImage = images[0];
            }
        }
        callback(err, bestImage);
    });
}

function _buildStorageVMPayload(volumeParams, billingPackage, options, cb) {
    assert.object(volumeParams, 'volumeParams');
    assert.object(billingPackage, 'billingPackage');
    assert.string(billingPackage.uuid, 'billingPackage.uuid');
    assert.object(options, 'options');
    assert.func(cb, 'cb');

    var nfsExportsDirName = volumeUtils.NFS_SHARED_VOLUME_EXPORTS_DIRNAME;
    // alias is of the form VOLUME-PREFIX-${volume-uuid} to allow for easier
    // troubleshooting on the CN, while still allowing for unique aliases.
    var volumeAlias = [
        volumeUtils.NFS_SHARED_VOLUME_VM_ALIAS_PREFIX,
        volumeParams.uuid
    ].join('-');

    var payload = {
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

    _getImage(volumeParams, options, function onImage(err, image) {
        if (image) {
            payload.image_uuid = image.uuid;
        }

        cb(err, payload);
    });
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

function _setStorageVmUuid(volumeObject, storageVmUuid) {
    assert.object(volumeObject, 'volumeObject');
    assert.uuid(storageVmUuid, 'storageVmUuid');

    assert.strictEqual(volumeObject.vm_uuid, undefined);

    volumeObject.vm_uuid = storageVmUuid;
}

function createVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.string(req.params.name, 'req.params.name');
    assert.string(req.params.owner_uuid, 'req.params.owner_uuid');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var vmapiClient = req._vmapiClient;
    var volumeUuid = libuuid.create();
    var validationErrs = [];
    var validationErr;
    var ownerUuid = req.params.owner_uuid;
    var volumeName = req.params.name;

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
                    done(new Error('Could not acquire ticket, ticket is not '
                        + 'active and instead is: ' + ticket.status));
                    return;
                }

                req.log.debug({ticket: ticket},
                    'Volume creation ticket acquired');

                ctx.ticket = ticket;
                done();
            });
        },
        function checkExistentReadyVolume(ctx, done) {
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

            volumesModel.createVolume(volumeParams, done);
        },
        function loadVolume(ctx, done) {
            req.log.debug({volumeUuid: volumeUuid}, 'Loading volume object');

            volumesModel.loadVolume(volumeUuid,
                function onVolumeLoaded(err, loadedVolume) {
                    ctx.volume = loadedVolume;
                    done(err);
                });
        },
        function getBestPackage(ctx, done) {
            var options = {
                log: req.log,
                papiClient: req._papiClient
            };

            req.log.debug({volumeParams: volumeParams},
                'Finding most suitable package');

            _getBestPackage(volumeParams, options,
                function onPackage(err, bestpackage) {
                    ctx.bestPackage = bestpackage;

                    done(err);
                });
        },
        function buildVMPayload(ctx, done) {
            assert.object(ctx.bestPackage, 'ctx.bestPackage');

            req.log.debug({volumeParams: volumeParams}, 'Building VM payload');

            var options = {
                papiClient: req._papiClient,
                imgapiClient: req._imgapiClient,
                vmapiClient: req._vmapiClient,
                log: req.log
            };
            _buildStorageVMPayload(volumeParams, ctx.bestPackage, options,
                function onVmPayload(err, vmPayload) {
                    ctx.vmPayload = vmPayload;

                    done(err);
                });
        },
        function createStorageVM(ctx, done) {
            assert.object(ctx.vmPayload, 'ctx.vmPayload');

            req.log.debug({vmPayload: ctx.vmPayload}, 'Creating storage VM');

            vmapiClient.createVm({
                payload: ctx.vmPayload
            }, {
                headers: {'x-request-id': req.getId()}
            }, function onVmCreated(vmCreationErr, vmCreationObj) {
                if (vmCreationErr) {
                    req.log.error({error: vmCreationErr},
                        'Error when creating storage VM');
                } else {
                    req.log.debug({
                        vmCreation: vmCreationObj,
                        error: vmCreationErr
                    }, 'Storage VM created');

                    ctx.storageVmUuid = vmCreationObj.vm_uuid;
                }

                done(vmCreationErr);
            });
        },
        function updateVolume(ctx, done) {
            assert.uuid(ctx.storageVmUuid, 'ctx.storageVmUuid');

            req.log.debug({volumeObject: ctx.volume}, 'Updating volume object');

            _setStorageVmUuid(ctx.volume, ctx.storageVmUuid);

            // At this point, the only valid states for the newly created volume
            // are 'creating' and 'failed'.
            assert.ok(ctx.volume.state === 'creating' ||
                ctx.volume.state === 'failed');

            if (ctx.bestPackage) {
                ctx.volume.size = ctx.bestPackage.quota;
            }

            volumesModel.updateVolume(volumeUuid, ctx.volume, done);
        }
    ],
    arg: context
    }, function onVolumeCreated(err, results) {
        req.volume = context.volume;

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
            function checkVolumesExist(ctx, done) {
                req.log.debug({uuid: volumeUuid}, 'Checks volume exists');
                volumesModel.loadVolume(volumeUuid,
                    function onVolumesLoaded(err, volume) {
                        if (!err && !volume) {
                            err = new Error('No volume with uuid '
                                + volumeUuid + ' could be found');
                        }

                        ctx.volume = volume;
                        done(err);
                    });
            },
            function acquireVolumeTicket(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');

                var volume = ctx.volume;
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
                assert.object(ctx.volume, 'ctx.volume');

                req.log.debug({volume: ctx.volume},
                    'Check volume is not currently mounted');

                var volume = ctx.volume;
                var err;

                if (volume.users && volume.users.length > 0) {
                    err = new Error('Volume with uuid ' + volumeUuid
                        + ' is currently used');
                }

                done(err);
            },
            function checkOwnedByProperOwner(ctx, done) {
                var volume = ctx.volume;
                var err;

                if (ownerUuid !== undefined && volume &&
                    volume.owner_uuid !== ownerUuid) {
                    err = new Error('Volume ' + volume.uuid
                        + ' is not owned by owner ' + ownerUuid);
                }

                done(err);
            },
            function getStorageVm(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');

                ctx.storageVmNeedsDeletion = true;

                req.log.debug({volume: ctx.volume},
                    'Loading volume\'s storage VM');

                var volume = ctx.volume;
                if (volume.vm_uuid === undefined) {
                    req.log.debug({volume: volume},
                        'No storage VM for this volume, skipping loading it');
                    ctx.storageVmNeedsDeletion = false;
                    done();
                    return;
                }

                req._vmapiClient.getVm({
                    uuid: volume.vm_uuid
                }, function onGetStorageVm(getVmErr, vm) {
                    if (getVmErr) {
                        req.log.debug({error: getVmErr},
                            'Error when loading storage VM');
                        done(getVmErr);
                        return;
                    }

                    if (vm.state === 'destroyed') {
                        ctx.storageVmNeedsDeletion = false;
                    }

                    ctx.storageVm = vm;
                    done();
                });
            },
            function markVolumeAsDeleted(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                var volume = ctx.volume;

                if (!ctx.storageVmNeedsDeletion) {
                    volume.state = 'deleted';
                    volumesModel.updateVolume(volume.uuid, volume, done);
                } else {
                    done();
                }
            },
            function markVolumeAsDeleting(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                if (!ctx.storageVmNeedsDeletion) {
                    done();
                    return;
                }

                var volume = ctx.volume;

                req.log.debug({volume: ctx.volume},
                    'Marking volume as deleting');

                volume.state = 'deleting';
                volumesModel.updateVolume(volume.uuid, volume, done);
            },
            function deleteStorageVm(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');
                assert.optionalObject(ctx.storageVm, 'ctx.storageVm');
                assert.bool(ctx.storageVmNeedsDeletion,
                    'ctx.storageVmNeedsDeletion');

                if (!ctx.storageVmNeedsDeletion) {
                    done();
                    return;
                }

                req.log.debug({
                    volume: ctx.volume,
                    storageVm: ctx.storageVm
                }, 'Deleting storage VM');

                var volume = ctx.volume;
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

function getVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.query, 'req.query');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeUuid = req.params.uuid;
    var ownerUuid = req.query.owner_uuid;

    var context = {};

    vasync.pipeline({funcs: [
        function _loadVolumeModel(ctx, done) {
            volumesModel.loadVolume(volumeUuid, function onVolume(err, volume) {
                ctx.volume = volume;

                if (!err) {
                    if (!volume) {
                        err = new Error('Could not find volume with uuid: '
                            + volumeUuid);
                    } else {
                        if (ownerUuid !== undefined &&
                            volume.owner_uuid !== ownerUuid) {
                            err = new Error('owner_uuid'  + ownerUuid
                                + ' does not match owner_uuid for volume '
                                + volumeUuid);
                        }
                    }
                }

                done(err);
            });
        }
    ],
    arg: context
    }, function allDone(err, results) {
        req.volume = context.volume;
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

function makeSendResponseHandler(options) {
    assert.object(options, 'options');

    var statusCode = options.statusCode || 200;

    return function sendResponseHandler(req, res, next) {
        assert.object(req.renderedResponse, 'req.renderedResponse');

        res.send(statusCode, req.renderedResponse);
        next();
    };
}
function mount(config, server) {
    server.post({
        path: '/volumes',
        name: 'CreateVolume',
        version: '1.0.0'
    }, restify.bodyParser(), createVolume, renderVolume,
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
     }, restify.queryParser(), getVolume, renderVolume,
        makeSendResponseHandler({
            statusCode: 200
        }));

    server.del({
        path: '/volumes/:uuid',
        name: 'DeleteVolume',
        version: '1.0.0'
    }, restify.queryParser(), deleteVolume,
        function renderDeletedVolume(req, res, next) {
            // Explicitly send an empty response
            req.renderedResponse = {};
            next();
        },
        makeSendResponseHandler({
            statusCode: 204
        }));
}

module.exports = {
    mount: mount
};
