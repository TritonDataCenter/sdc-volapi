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

function _getVolumePackage(volumeParams, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.func(callback, 'callback');
}

function _buildVMPayload(volumeParams, callback) {
    assert.object(volumeParams, 'volumeParams');
    assert.func(callback, 'callback');

    var nfsExportsDirName = volumeUtils.NFS_SHARED_VOLUME_EXPORTS_DIRNAME;

    callback(null, {
        alias: [NFS_SHARED_VOLUME_ALIAS_PREFIX, libuuid.create()].join('-'),
        billing_id: '8b059463-0e72-4602-f456-c355223cd4af',
        brand: 'joyent-minimal',
        customer_metadata: {
            'export-volumes': '["' + nfsExportsDirName + '"]',
            'user-script': NFS_SHARED_VOLUME_ZONE_USER_SCRIPT
        },
        // Use a delegate dataset so that data is not lost if the storage
        // VM is lost.
        delegate_dataset: true,
        image_uuid: '46ab74aa-ec11-11e5-aff0-5fe5d3487342',
        networks: [ {uuid: '62374303-b852-4c37-90b0-af941358b186'} ],
        owner_uuid: volumeParams.owner_uuid,
        tags: {
            smartdc_role: 'nfsserver'
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

    req.log.debug({params: req.params}, 'createVolume');
    var volumeParams = {
        name: req.params.name,
        owner_uuid: req.params.owner_uuid
    };

    if (req.params.DriverOpts) {
        volumeParams.size = req.params.DriverOpts.size;
        volumeParams.network = req.params.DriverOpts.network;
    }

    vasync.waterfall([
        function buildVMPayload(done) {
            _buildVMPayload(volumeParams, done);
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

function loadAndRenderVolume(req, res, next) {
    assert.object(req, 'req');
    assert.object(res, 'res');
    assert.func(next, 'next');

    req.log.debug('renderVolume');

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
}

module.exports = {
    mount: mount
};
