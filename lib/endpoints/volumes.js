/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var libuuid = require('libuuid');
var restify = require('restify');
var vasync = require('vasync');

var units = require('../units');
var volumesModel = require('../models/volumes');
var volumeUtils = require('../volumes');
var volumesValidation = require('../validation/volumes');

var NFS_SHARED_VOLUME_ALIAS_PREFIX = 'nfs-shared-volume';

/* JSSTYLED */
var NFS_SHARED_VOLUME_ZONE_USER_SCRIPT = "#!/usr/bin/bash\n#\n# This Source Code Form is subject to the terms of the Mozilla Public\n# License, v. 2.0. If a copy of the MPL was not distributed with this\n# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n#\n\n#\n# Copyright (c) 2014, Joyent, Inc.\n#\n\nexport PS4='[\\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'\n\nset -o xtrace\nset -o errexit\nset -o pipefail\n\n#\n# The presence of the /var/svc/.ran-user-script file indicates that the\n# instance has already been setup (i.e. the instance has booted previously).\n#\n# Upon first boot, run the setup.sh script if present. On all boots including\n# the first one, run the configure.sh script if present.\n#\n\nSENTINEL=/var/svc/.ran-user-script\n\nDIR=/opt/smartdc/boot\n\nif [[ ! -e ${SENTINEL} ]]; then\n    if [[ -f ${DIR}/setup.sh ]]; then\n        ${DIR}/setup.sh 2>&1 | tee /var/svc/setup.log\n    fi\n\n    touch ${SENTINEL}\nfi\n\nif [[ ! -f ${DIR}/configure.sh ]]; then\n    echo \"Missing ${DIR}/configure.sh cannot configure.\"\n    exit 1\nfi\n\nexec ${DIR}/configure.sh\n";

var DEFAULT_NFS_SHARED_VOLUME_PACKAGE_SIZE_IN_MBS = 10 * units.MBYTES_IN_GB;

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

function createVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.params, 'req.params');
    assert.string(req.params.name, 'req.params.name');
    assert.string(req.params.owner_uuid, 'req.params.owner_uuid');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var vmapiClient = req._vmapiClient;
    var volumeUuuid = libuuid.create();
    var validationErrs = [];
    var validationErr;

    validationErr = volumesValidation.validateVolumeName(req.params.name);
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
        uuid: volumeUuuid,
        name: req.params.name,
        owner_uuid: req.params.owner_uuid,
        size: req.params.size,
        networks: req.params.networks,
        type: req.params.type
    };

    var context = {};

    vasync.pipeline({funcs: [
        function checkVolumeNameAvailable(ctx, done) {
            volumesModel.listVolumes({
                name: volumeParams.name,
                owner_uuid: volumeParams.owner_uuid
            }, function onVolumesListed(err, volumes) {
                if (!err && volumes.length > 0) {
                    err = new Error('Volume with name '
                        + volumeParams.name + ' already exists');
                }

                done(err);
            });
        },
        function getBestPackage(ctx, done) {
            var options = {
                log: req.log,
                papiClient: req._papiClient
            };

            _getBestPackage(volumeParams, options,
                function onPackage(err, bestpackage) {
                    ctx.bestPackage = bestpackage;

                    done(err);
                });
        },
        function buildVMPayload(ctx, done) {
            assert.object(ctx.bestPackage, 'ctx.bestPackage');

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

            vmapiClient.createVm({
                payload: ctx.vmPayload,
                sync: true
            }, {
                headers: {'x-request-id': req.getId()}
            }, function onVmCreated(err, vmObj) {
                req.log.debug({vm: vmObj, err: err}, 'VM created');
                ctx.vmUuid = vmObj.vm_uuid;

                done(err);
            });
        },
        function fetchVmObject(ctx, done) {
            assert.string(ctx.vmUuid, 'ctx.vmUuid');

            vmapiClient.getVm({uuid: ctx.vmUuid}, function onGetVm(err, vm) {
                if (!err && vm) {
                    if (!vm.nics || !Array.isArray(vm.nics) ||
                        vm.nics.length === 0) {
                        err = new Error('storage VM has no network interface');
                    }
                }

                ctx.vm = vm;
                done(err);
            });
        },
        function createVolumeModel(ctx, done) {
            assert.object(ctx.vm, 'ctx.vm');

            if (ctx.vm.nics.length < 1) {
                done(new Error('Storage VM ' + ctx.vm.vm_uuid
                    + ' does not have any IP address'));
                return;
            }

            volumesModel.createVolume(volumeParams, ctx.vm,
                function onVolumeCreated(err, volumeUuid) {
                    if (!err) {
                        req.volumeUuid = volumeUuid;
                    }
                    done(err);
                    return;
                });
        }
    ],
    arg: context
    }, next);
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
                vmapiClient.deleteVm({
                    uuid: volume.vm_uuid,
                    owner: volume.owner_uuid,
                    sync: true
                }, next);
            },
            function deleteVolumeModel(args, next) {
                volumesModel.deleteVolume(volume.uuid, next);
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
        if (!err) {
            res.send(204);
        }

        next(err);
    });
}

function getVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(req.query, 'req.query');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeUuid = req.params.uuid;
    var ownerUuid = req.query.owner_uuid;

    volumesModel.loadVolume(volumeUuid, function onVolume(err, volume) {
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
                } else {
                    res.send(200, volume);
                }
            }
        }

        next(err);
    });
}

function loadAndRenderVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    volumesModel.loadVolume(req.volumeUuid,
        function onVolumeLoaded(err, volume) {
            if (err) {
                next(err);
            } else {
                res.send(201, volume);
                next();
            }
        });
}

function renderVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    res.send(200, req.volumes);
    next();
}

function mount(config, server) {
    server.post({
        path: '/volumes',
        name: 'CreateVolume',
        version: '1.0.0'
    }, restify.bodyParser(), createVolume, loadAndRenderVolume);

    server.get({
        path: '/volumes',
        name: 'ListVolumes',
        version: '1.0.0'
    }, restify.queryParser(), listVolumes, renderVolumes);

     server.get({
         path: '/volumes/:uuid',
         name: 'GetVolume',
         version: '1.0.0'
     }, restify.queryParser(), getVolume);

    server.del({
        path: '/volumes/:uuid',
        name: 'DeleteVolume',
        version: '1.0.0'
    }, restify.queryParser(), deleteVolume);
}

module.exports = {
    mount: mount
};
