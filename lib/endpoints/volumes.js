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
var libuuid = require('libuuid');
var path = require('path');
var restify = require('restify');
var vasync = require('vasync');

var errors = require('../errors');
var units = require('../units');
var volumesModel = require('../models/volumes');
var volumeUtils = require('../volumes');
var volumesValidation = require('../validation/volumes');

var NFS_SHARED_VOLUME_ALIAS_PREFIX = 'nfs-shared-volume';

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
    var payload = {
        billing_id: billingPackage.uuid,
        // alias is of the form nfs-shared-volume-${volume-uuid} to allow
        // for easier troubleshooting on the CN, while still allowing for
        // unique aliases.
        alias: [NFS_SHARED_VOLUME_ALIAS_PREFIX, volumeParams.uuid].join('-'),
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

function _setStorageVm(volumeObject, storageVm) {
    assert.object(volumeObject, 'volumeObject');
    assert.object(storageVm, 'storageVm');

    var storageVmUuid = storageVm.uuid;
    var storageVmIp;
    var remoteNfsPath;
    var fsPath = path.join(volumeUtils.NFS_SHARED_VOLUME_EXPORTS_BASEDIR,
        volumeUtils.NFS_SHARED_VOLUME_EXPORTS_DIRNAME);

    if (storageVm.nics.length >= 1) {
         storageVmIp = storageVm.nics[0].ip;
     }

     remoteNfsPath = storageVmIp + ':' + fsPath;
     volumeObject.filesystem_path = remoteNfsPath;

    volumeObject.vm_uuid = storageVmUuid;

    if (storageVm.state !== 'running' || storageVmIp === undefined) {
        volumeObject.state = 'failed';
    } else {
        volumeObject.state = 'ready';
    }
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
        next(new Error('Invalid creation parameters: ' + validationErrs));
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
                state: 'ready'
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
                payload: ctx.vmPayload,
                sync: true
            }, {
                headers: {'x-request-id': req.getId()}
            }, function onVmCreated(err, vmObj) {
                if (err) {
                    req.log.error({err: err}, 'Error when creating storage VM');
                } else {
                    req.log.debug({vm: vmObj, err: err}, 'Storage VM created');
                    ctx.vmUuid = vmObj.vm_uuid;
                }

                done(err);
            });
        },
        function fetchVmObject(ctx, done) {
            assert.string(ctx.vmUuid, 'ctx.vmUuid');

            req.log.debug({vmUuid: ctx.vmUuid}, 'Fetching storage VM object');

            vmapiClient.getVm({uuid: ctx.vmUuid}, function onGetVm(err, vm) {
                if (!err && vm) {
                    if (!vm.nics || !Array.isArray(vm.nics) ||
                        vm.nics.length === 0) {
                        err = new Error('storage VM has no network interface');
                    }
                }

                ctx.storageVm = vm;
                done(err);
            });
        },
        function updateVolume(ctx, done) {
            assert.object(ctx.storageVm, 'ctx.storageVm');

            req.log.debug({volumeObject: ctx.volume}, 'Updating volume object');

            _setStorageVm(ctx.volume, ctx.storageVm);

            // At this point, the only valid states for the newly created volume
            // are 'ready' and 'failed'.
            assert.ok(ctx.volume.state === 'ready' ||
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


function listVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.query, 'req.query');
    assert.object(res, 'res');
    assert.func(next, 'next');

    volumesModel.listVolumes({
        owner_uuid: req.query.owner_uuid,
        name: req.query.name,
        filter: req.query.filter
    }, function onListVolumes(err, volumes) {
        req.volumes = volumes;
        next(err);
    });

}

function _deleteVolume(volume, options, callback) {
    assert.object(options, 'options');
    assert.object(options.vmapiClient, 'vmapiClient');
    assert.object(volume, 'volume');
    assert.func(callback, 'callback');

    var vmapiClient = options.vmapiClient;

    vasync.pipeline({
        funcs: [
            function deleteStorageVm(args, next) {
                if (volume.vm_uuid === undefined) {
                    next();
                    return;
                }

                vmapiClient.deleteVm({
                    uuid: volume.vm_uuid,
                    owner: volume.owner_uuid,
                    sync: true
                }, next);
            },
            function deleteVolumeModel(args, next) {
                var deletedVolume = jsprim.deepCopy(volume);
                deletedVolume.state = 'deleted';
                volumesModel.updateVolume(volume.uuid, deletedVolume, next);
            }
        ]
    }, callback);
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
            function removeVolume(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');

                req.log.debug({volume: ctx.volume}, 'Remove volume');

                var volume = ctx.volume;
                var vmapiClient = req._vmapiClient;

                _deleteVolume(volume, {
                    vmapiClient: vmapiClient
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
        },
        function _getStorageVmStatus(ctx, done) {
            assert.object(ctx.volume, 'ctx.volume');

            var volume = ctx.volume;
            var volumeReady = volume && volume.state === 'ready';

            if (!volumeReady) {
                // If the volume is not in state 'ready', then its storage VM
                // state is irrelevant, so there's no need to retrieve it.
                done();
            } else {
                req._vmapiClient.getVm({
                    uuid: ctx.volume.vm_uuid
                }, function onGetVm(err, storageVm) {
                    var storageVmRunning = storageVm &&
                        storageVm.state === 'running';
                    if (err || !storageVmRunning) {
                        // If there was an error in retrieving the storage VM,
                        // or if that storage is not running, the volume cannot
                        // be accessed by other VMs, so its state is considered
                        // to be 'failed'.
                        ctx.volume.state = 'failed';
                    }

                    // Errors in getting the storage VM object should not be
                    // propagated to clients, because the existence of a storage
                    // VM is an implementation detail.
                    done();
                });
            }
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
    }, restify.queryParser(), listVolumes, renderVolumes,
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
