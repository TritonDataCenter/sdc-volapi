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

var volumesModel = require('../models/volumes');
var volumeUtils = require('../volumes');

var NFS_SHARED_VOLUME_ALIAS_PREFIX = 'nfs-shared-volume';

/* JSSTYLED */
var NFS_SHARED_VOLUME_ZONE_USER_SCRIPT = "#!/usr/bin/bash\n#\n# This Source Code Form is subject to the terms of the Mozilla Public\n# License, v. 2.0. If a copy of the MPL was not distributed with this\n# file, You can obtain one at http://mozilla.org/MPL/2.0/.\n#\n\n#\n# Copyright (c) 2014, Joyent, Inc.\n#\n\nexport PS4='[\\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'\n\nset -o xtrace\nset -o errexit\nset -o pipefail\n\n#\n# The presence of the /var/svc/.ran-user-script file indicates that the\n# instance has already been setup (i.e. the instance has booted previously).\n#\n# Upon first boot, run the setup.sh script if present. On all boots including\n# the first one, run the configure.sh script if present.\n#\n\nSENTINEL=/var/svc/.ran-user-script\n\nDIR=/opt/smartdc/boot\n\nif [[ ! -e ${SENTINEL} ]]; then\n    if [[ -f ${DIR}/setup.sh ]]; then\n        ${DIR}/setup.sh 2>&1 | tee /var/svc/setup.log\n    fi\n\n    touch ${SENTINEL}\nfi\n\nif [[ ! -f ${DIR}/configure.sh ]]; then\n    echo \"Missing ${DIR}/configure.sh cannot configure.\"\n    exit 1\nfi\n\nexec ${DIR}/configure.sh\n";

var MBYTES_IN_GB = 1024;

var DEFAULT_NFS_SHARED_VOLUME_PACKAGE_SIZE_IN_MBS = 10 * MBYTES_IN_GB;

function _parseVolumeSize(size) {
    assert.optionalString(size, 'size');

    var MULTIPLIERS_TABLE = {
        g: MBYTES_IN_GB,
        GB: MBYTES_IN_GB,
        m: 1,
        MB: 1
    };

    var multiplierSymbol, multiplier;
    var baseValue;

    if (size === undefined) {
        return undefined;
    }

    var matches = size.match(/(\d+)(g|m|k|GB|MB|KB)/);
    if (matches) {
        multiplierSymbol = matches[2];
        multiplier = MULTIPLIERS_TABLE[multiplierSymbol];
        baseValue = Number(matches[1]);
        if (isNaN(baseValue) || multiplier === undefined) {
            throw new Error('size ' + size + ' is not a valid volume size');
        } else {
            return baseValue * multiplier;
        }
    } else {
        throw new Error('size ' + size + ' is not a valid volume size');
    }
}

function _selectBestPackage(volumeParams, packagesList, options, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.arrayOfObject(packagesList, 'packagesList');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var bestPackage;
    var err;
    var requestedSize;

    try {
        requestedSize = _parseVolumeSize(volumeParams.size);
    } catch (parseVolumeSizeErr) {
        return callback(parseVolumeSizeErr);
    }

    if (requestedSize === undefined) {
        requestedSize = DEFAULT_NFS_SHARED_VOLUME_PACKAGE_SIZE_IN_MBS;
    }

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

function _getPackage(volumeParams, options, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(callback, 'callback');

    var papiClient = options.papiClient;
    assert.object(papiClient, 'papiClient');

    var context = {};
    vasync.pipeline({
        funcs: [
            function getNfsSharedVolumesPackages(ctx, next) {
                papiClient.list({}, {
                    name: 'nfs_shared_volume*'
                }, function onListDone(err, pkgs, count) {
                    ctx.nfsSharedVolumesPkgs = pkgs;
                    next(err);
                });
            },
            function selectBestPackage(ctx, next) {
                _selectBestPackage(volumeParams, ctx.nfsSharedVolumesPkgs,
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

function _buildStorageVMPayload(volumeParams, options, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.object(options, 'options');
    assert.func(callback, 'callback');

    var nfsExportsDirName = volumeUtils.NFS_SHARED_VOLUME_EXPORTS_DIRNAME;
    var payload = {
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

    vasync.parallel({
        funcs: [
            _getPackage.bind(null, volumeParams, options),
            _getImage.bind(null, volumeParams, options)
        ]
    }, function (err, results) {
        if (err) {
            callback(err);
        } else {
            var billingPackage = results.operations[0].result;
            var image = results.operations[1].result;

            payload.billing_id = billingPackage.uuid;
            payload.image_uuid = image.uuid;

            callback(null, payload);
        }
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

    req.log.debug({params: req.params}, 'createVolume');
    var volumeParams = {
        uuid: volumeUuuid,
        name: req.params.name,
        owner_uuid: req.params.owner_uuid,
        size: req.params.size,
        networks: req.params.networks
    };

    vasync.waterfall([
        function buildVMPayload(done) {
            var options = {
                papiClient: req._papiClient,
                imgapiClient: req._imgapiClient,
                vmapiClient: req._vmapiClient,
                log: req.log
            };
            _buildStorageVMPayload(volumeParams, options, done);
        },
        function createStorageVM(vmPayload, done) {
            vmapiClient.createVm({
                payload: vmPayload,
                sync: true
            }, {
                headers: {'x-request-id': req.getId()}
            }, function onVmCreated(err, vmObj) {
                req.log.debug({vm: vmObj, err: err}, 'VM created');
                return done(err, vmObj.vm_uuid);
            });
        },
        function createVolumeModel(vmUuid, done) {
            volumesModel.createVolume(volumeParams, vmUuid,
                function onVolumeCreated(err, volumeUuid) {
                    if (!err) {
                        req.volumeUuid = volumeUuid;
                    }
                    done(err);
                    return;
                });
        }
    ], function allDone(err) {
        next(err);
        return;
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

function deleteVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    var volumeName = decodeURIComponent(req.params[0]);
    var context = {};

    vasync.pipeline({
        funcs: [
            function checkVolumeExists(ctx, done) {
                volumesModel.listVolumes({name: volumeName},
                    function onVolumesListed(err, volumes) {
                        if (!err) {
                            assert.arrayOfObject(volumes, 'volumes');
                            assert.ok(volumes.length <= 1,
                                'there should be at most 1 volume with name '
                                    + volumeName);
                            ctx.volume = volumes[0];
                        }

                        done(err);
                    });
            },
            function checkVolumeUnused(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');

                var volume = ctx.volume;
                if (volume.users && volume.users.length > 0) {
                    done(new Error('Volume is used'));
                } else {
                    done();
                }
            },
            function removeVolumeVm(ctx, done) {
                assert.object(ctx.volume, 'ctx.volume');

                var volume = ctx.volume;
                var vmapiClient = req._vmapiClient;

                vmapiClient.deleteVm({
                    uuid: volume.vm_uuid,
                    sync: true
                }, done);
            },
            function removeVolumeObject(ctx, done) {
                volumesModel.deleteVolume(ctx.volume.uuid, done);
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

function loadAndRenderVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    volumesModel.loadVolume(req.volumeUuid,
        function onVolumeLoaded(err, volume) {
            res.send(201, volume);
            return next();
        });
}

function renderVolumes(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    res.send(200, req.volumes);
}

function mount(config, server) {
    server.post({path: '/volumes', name: 'CreateVolume'}, restify.bodyParser(),
        createVolume, loadAndRenderVolume);

    server.get({path: '/volumes', name: 'ListVolumes'}, restify.queryParser(),
        listVolumes, renderVolumes);

    server.del({path: /volumes\/([^\/]+)$/, name: 'DeleteVolume'},
        deleteVolume);
}

module.exports = {
    mount: mount
};
