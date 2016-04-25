/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var fs = require('fs');
var ldap = require('ldapjs');
var once = require('once');
var path = require('path');
var sdcClients = require('sdc-clients');
var util = require('util'),
    format = util.format;
var vasync = require('vasync');

var configLoader = require('../../lib/config-loader');
var jsprim = require('jsprim');

var NB_MBS_IN_GB = 1024;
var NFS_SHARED_VOLUMES_PACKAGES_NAME_PREFIX = 'sdc_volume_nfs';
// Sizes are in GBs
var NFS_SHARED_VOLUMES_PKG_SIZES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
    200, 300, 400, 500, 600, 700, 800, 900, 1000];

var LOG = new bunyan({
    name: 'coal-setup',
    level: 'info',
    serializers: bunyan.stdSerializers
});

var UPDATES_IMGAPI_OPTS = {
    url: 'https://updates.joyent.com/',
    proxy: false,
    agent: false,
    log: LOG,
    channel: 'experimental'
};

/**
 * This is the template used for creating package objects for NFS shared
 * volumes. The size and owners' uuid are setup at runtime.
 */
var NFS_SHARED_VOLUMES_PACKAGE_TEMPLATE = {
    active: true,
    cpu_cap: 100,
    max_lwps: 1000,
    max_physical_memory: 1024,
    max_swap: 1024,
    vcpus: 1,
    version: '1.0.0',
    zfs_io_priority: 20,
    default: false
};

function importImage(options, image, callback) {
    assert.object(options, 'options');
    assert.object(image, 'image');
    assert.func(callback, 'callback');

    var imgapiClient = options.imgapiClient;
    imgapiClient.adminImportRemoteImageAndWait(image.uuid,
        'https://updates.joyent.com?channel=experimental', callback);
}

function importImages(options, imagesList, callback) {
    assert.object(options, 'options');
    assert.arrayOfObject(imagesList, 'imagesList');
    assert.func(callback, 'callback');

    vasync.forEachParallel({
        func: importImage.bind(null, {imgapiClient: options.imgapiClient}),
        inputs: imagesList
    }, callback);
}

/**
 * Adds a package using PAPI client "papiClient" for shared NFS volumes of size
 * "size" GBs. Calls "callback" when done with an error object and the newly
 * created package as parameters.
 */
function addSharedVolumePackage(options, packageSettings, callback) {
    assert.object(options, 'options');
    assert.object(packageSettings, 'packageSettings');
    assert.number(packageSettings.size, 'size');
    assert.arrayOfString(packageSettings.owner_uuids,
        'packageSettings.owner_uuids');
    assert.func(callback, 'callback');

    var papiClient = options.papiClient;

    var packageName = [
        NFS_SHARED_VOLUMES_PACKAGES_NAME_PREFIX,
        packageSettings.size
    ].join('_');

    var context = {
        foundPackage: false
    };

    vasync.pipeline({
        funcs: [
            function _findPackage(ctx, next) {
                papiClient.list({name: packageName}, {},
                    function onPackagesListed(err, pkgs) {
                        if (!err && pkgs && pkgs.length > 0) {
                            ctx.foundPackage = true;
                        }

                        next(err);
                    });
            },
            function _addPackage(ctx, next) {
                if (ctx.foundPackage) {
                    next();
                    return;
                }

                var newPackage =
                    jsprim.deepCopy(NFS_SHARED_VOLUMES_PACKAGE_TEMPLATE);
                newPackage.name = packageName;
                newPackage.quota = packageSettings.size * NB_MBS_IN_GB;
                newPackage.owner_uuids = packageSettings.owner_uuids;

                LOG.info({pkg: newPackage}, 'Adding package');

                papiClient.add(newPackage, function onPackageAdded(err, pkg) {
                    if (!err && pkg) {
                        ctx.pkgAdded = pkg;
                        LOG.info({package: pkg}, 'Package added');
                    }

                    next(err);
                });
            }
        ],
        arg: context
    }, function _addSharedVolumePackageDone(err) {
        callback(err, context.pkgAdded);
    });
}

function enableNfsSharedVolumesInDocker(dockerSvcId, options, callback) {
    assert.string(dockerSvcId, 'dockerSvcId');
    assert.object(options, 'options');
    assert.object(options.sapiClient, 'options.sapiClient');
    assert.func(callback, 'callback');

    var sapiClient = options.sapiClient;
    var context = {
        nfsSharedVolumesAlreadyEnabled: false,
        didEnableNfsSharedVolumes: false
    };

    vasync.pipeline({
        funcs: [
            function _checkAlreadyEnabled(ctx, next) {
                sapiClient.getService(dockerSvcId,
                    function _onGetDockerSvc(err, dockerSvc) {
                        var dockerSvcMetadata;
                        if (dockerSvc) {
                            dockerSvcMetadata = dockerSvc.metadata;
                        }

                        if (dockerSvcMetadata.experimental_nfs_shared_volumes) {
                            ctx.nfsSharedVolumesAlreadyEnabled = true;
                        }

                        next(err);
                    });
            },
            function _enableNfsSharedVolumes(ctx, next) {
                if (ctx.nfsSharedVolumesAlreadyEnabled) {
                    next();
                    return;
                }

                sapiClient.updateService(dockerSvcId, {
                    action: 'update',
                    metadata: {
                        experimental_nfs_shared_volumes: true
                    }
                }, function onDockerSvcUpdated(err) {
                    if (!err) {
                        ctx.didEnableNfsSharedVolumes = true;
                    }

                    next(err);
                });
            }
        ],
        arg: context
    }, function _updateDockerServiceDone(err) {
        callback(err, context.didEnableNfsSharedVolumes);
    });
}

function setupVolapi() {
    assert.string(process.env.IMGAPI_IP, 'process.env.IMGAPI_IP');
    assert.string(process.env.CNAPI_IP, 'process.env.CNAPI_IP');
    assert.string(process.env.PAPI_IP, 'process.env.PAPI_IP');
    assert.string(process.env.VMAPI_IP, 'process.env.VMAPI_IP');
    assert.string(process.env.SAPI_IP, 'process.env.SAPI_IP');
    assert.string(process.env.UFDS_IP, 'process.env.UFDS_IP');
    assert.string(process.env.USER_SCRIPT, 'process.env.USER_SCRIPT');

    var updatesImgApiClient = new sdcClients.IMGAPI(UPDATES_IMGAPI_OPTS);
    var localImgApiClient = new sdcClients.IMGAPI({
        url: 'http://' + process.env.IMGAPI_IP,
        agent: false
    });

    var cnapiClient = new sdcClients.CNAPI({
        url: 'http://' + process.env.CNAPI_IP,
        agent: false
    });

    var papiClient = new sdcClients.PAPI({
        url: 'http://' + process.env.PAPI_IP,
        agent: false
    });

    var vmapiClient = new sdcClients.VMAPI({
        url: 'http://' + process.env.VMAPI_IP,
        agent: false
    });

    var sapiClient = new sdcClients.SAPI({
        url: 'http://' + process.env.SAPI_IP,
        agent: false,
        log: LOG
    });

    var ufdsClient = ldap.createClient({
        url: 'ldaps://' + process.env.UFDS_IP + ':636',
        tlsOptions: {
            rejectUnauthorized: false
        }
    });

    var start = Date.now();
    var svcData = {
        name: 'volapi',
        params: {
            package_name: 'sdc_1024',
            billing_id: 'TO_FILL_IN', // filled in from 'package_name'
            image_uuid: 'TO_FILL_IN',
            archive_on_delete: true,
            delegate_dataset: true,
            maintain_resolvers: true,
            networks: [
                {name: 'admin'}
            ],
            firewall_enabled: false,
            tags: {
                smartdc_role: 'volapi',
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: 'volapi',
            SERVICE_DOMAIN: 'TO_FILL_IN',
            'user-script': 'TO_FILL_IN'
        }
    };


    var context = {
        imgsToDownload: [],
        didSomething: false
    };

    vasync.pipeline({arg: context, funcs: [
        function getSdcApplicationUuid(ctx, next) {
            console.log('Getting "sdc" application uuid...');
            sapiClient.listApplications({name: 'sdc'},
                function onListSdcApps(err, apps) {
                    if (!err) {
                        assert.arrayOfObject(apps, 'apps');
                        assert.equal(apps.length, 1);

                        ctx.sdcApplicationUuid = apps[0].uuid;
                    }

                    next(err);
                });
        },

        function _ldapBind(ctx, next) {
            ufdsClient.bind('cn=root', 'secret', next);
        },

        function getAdminuuid(ctx, next) {
            var nextOnce = once(next);
            var ldapSearchOptions = {
                filter: '(&(objectclass=sdcperson)(login=admin))',
                attributes: ['uuid'],
                scope: 'sub'
            };

            ufdsClient.search('ou=users, o=smartdc', ldapSearchOptions,
                function onSearchDone(err, res) {
                    res.on('error', nextOnce);

                    res.on('end', function onEnd(result) {
                        nextOnce(null);
                    });

                    res.on('searchEntry', function onSearchEntry(entry) {
                        ctx.ufdsAdminUuid = entry.object.uuid;
                    });
                });
        },

        function getPkg(ctx, next) {
            console.log('Getting volapi package...');

            var filter = {name: svcData.params.package_name,
                active: true};
            papiClient.list(filter, {}, function (err, pkgs) {
                if (err) {
                    next(err);
                    return;
                } else if (pkgs.length !== 1) {
                    next(new Error({
                        message: format('%d "%s" packages found', pkgs.length,
                            svcData.params.package_name)
                    }));
                    return;
                }
                ctx.volapiPkg = pkgs[0];
                next();
            });
        },

        function ensureSapiMode(_, next) {
            // Bail if SAPI not in 'full' mode.
            console.log('Ensuring SAPI mode...');

            sapiClient.getMode(function (err, mode) {
                if (err) {
                    next(new Error('sapi error:', err));
                } else if (mode !== 'full') {
                    next(new Error(format(
                        'SAPI is not in "full" mode: mode=%s', mode)));
                } else {
                    next();
                }
            });
        },

        function getSvc(ctx, next) {
            console.log('Getting existing volapi service...');

            sapiClient.listServices({
                name: 'volapi',
                application_uuid: ctx.sdcApplicationUuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                } else if (svcs.length) {
                    ctx.volapiSvc = svcs[0];
                }
                next();
            });
        },

        function getVolApiInst(ctx, next) {
            console.log('Getting existing volapi instance...');

            if (!ctx.volapiSvc) {
                next();
                return;
            }
            var filter = {
                service_uuid: ctx.volapiSvc.uuid
            };
            sapiClient.listInstances(filter, function (err, insts) {
                if (err) {
                    next(new Error('sapi error:', err));
                    return;
                } else if (insts && insts.length) {
                    // Note this doesn't handle multiple insts.
                    ctx.volapiInst = insts[0];
                    vmapiClient.getVm({
                        uuid: ctx.volapiInst.uuid
                    }, function (vmErr, volapiVm) {
                        if (vmErr) {
                            next(vmErr);
                            return;
                        }
                        ctx.volapiVm = volapiVm;
                        next();
                    });
                } else {
                    next();
                }
            });
        },

        function getLatestVolApiImage(ctx, next) {
            console.log('Getting latest volapi image...');

            var filter = {name: 'volapi'};
            updatesImgApiClient.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.volapiImg = images[images.length - 1];
                    next();
                } else {
                    next(new Error('no "volapi" image found'));
                }
            });
        },

        function haveLatestVolApiImageAlready(ctx, next) {
            console.log('Checking if latest volapi image is already imported...');

            localImgApiClient.getImage(ctx.volapiImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.volapiImg);
                } else if (err) {
                    next(err);
                    return;
                }
                next();
            });
        },

        function getLatestDockerApiImage(ctx, next) {
            console.log('Getting latest sdc-docker image...');

            var filter = {name: 'docker'};
            updatesImgApiClient.listImages(filter, function (err, images) {
                if (err) {
                    next(err);
                } else if (images && images.length) {
                    // TODO presuming sorted
                    ctx.dockerImg = images[images.length - 1];
                    next();
                } else {
                    next(new Error('no "docker" image found'));
                }
            });
        },

        function haveLatestDockerApiImageAlready(ctx, next) {
            console.log('Checking if latest sdc-docker image is imported...');

            localImgApiClient.getImage(ctx.volapiImg.uuid,
                    function (err, img_) {
                if (err && err.body && err.body.code === 'ResourceNotFound') {
                    ctx.imgsToDownload.push(ctx.dockerImg);
                } else if (err) {
                    next(err);
                    return;
                }
                next();
            });
        },

        function _importImages(ctx, next) {
            console.log('Importing images...');

            if (ctx.imgsToDownload.length === 0) {
                next();
                return;
            }

            importImages({imgapiClient: localImgApiClient},
                ctx.imgsToDownload, next);
        },

        function createVolApiSvc(ctx, next) {
            if (ctx.volapiSvc) {
                next();
                return;
            }

            var domain = 'coal.joyent.us';
            var svcDomain = svcData.name + '.' + domain;

            console.log('Creating "volapi" service');
            ctx.didSomething = true;

            svcData.params.image_uuid = ctx.volapiImg.uuid;
            svcData.metadata['user-script'] = process.env.USER_SCRIPT;
            svcData.metadata['SERVICE_DOMAIN'] = svcDomain;
            svcData.params.billing_id = ctx.volapiPkg.uuid;
            delete svcData.params.package_name;

            sapiClient.createService('volapi', ctx.sdcApplicationUuid, svcData,
                function (err, svc) {
                    if (err) {
                        next(new Error('sapi error:' + err));
                        return;
                    }
                    ctx.volapiSvc = svc;
                    LOG.info({svc: svc}, 'created volapi svc');
                    next();
                });
        },

        function getHeadnode(ctx, next) {
            cnapiClient.listServers({
                headnode: true
            }, function (err, servers) {
                if (err) {
                    next(new Error('cnapi error:' + err));
                    return;
                }
                ctx.headnode = servers[0];
                next();
                return;
            });
        },
        function createVolApiInst(ctx, next) {
            if (ctx.volapiInst) {
                next();
                return;
            }

            console.log('Creating "volapi" instance');
            ctx.didSomething = true;

            var instOpts = {
                params: {
                    alias: 'volapi0',
                    server_uuid: ctx.headnode.uuid
                }
            };
            sapiClient.createInstance(ctx.volapiSvc.uuid, instOpts,
                    function (err, inst) {
                if (err) {
                    next(new Error('sapi error:' + err));
                    return;
                }
                console.log('Created VM %s (%s)', inst.uuid,
                    inst.params.alias);
                ctx.newVolApiInst = inst;
                next();
            });
        },
        function addSharedVolumesPackages(ctx, next) {
            function createPackageSettings(packageSize) {
                assert.number(packageSize, 'packageSize');
                assert.ok(packageSize > 0);

                return {
                    size: packageSize,
                    owner_uuids: [ctx.ufdsAdminUuid]
                };
            }

            var packagesSettings =
                NFS_SHARED_VOLUMES_PKG_SIZES.map(createPackageSettings);

            vasync.forEachParallel({
                func: addSharedVolumePackage.bind(null, {
                    papiClient: papiClient
                }),
                inputs: packagesSettings
            }, function sharedVolumesPackagesAdded(err, results) {
                if (err) {
                    LOG.error({error: err}, 'Error when adding packages');
                }

                var addedPackageNames = [];

                results.operations.forEach(function addPkgName(operation) {
                    if (operation.result) {
                        addedPackageNames.push(operation.result.name);
                    }
                });

                if (addedPackageNames.length > 0) {
                    console.log('Added NFS shared volumes packages:\n'
                        + addedPackageNames.join('\n'));

                    ctx.didSomething = true;
                }

                next(err);
            });
        },
        function getDockerServiceUuid(ctx, next) {
            sapiClient.listServices({
                name: 'docker',
                application_uuid: ctx.sdcApplicationUuid
            }, function (svcErr, svcs) {
                if (svcErr) {
                    next(svcErr);
                    return;
                } else if (svcs.length) {
                    ctx.dockerSvc = svcs[0];
                }

                next();
            });
        },
        function enableNfSharedVolumes(ctx, next) {
            function _nfsSharedVolumesEnabled(err, didEnable) {
                if (didEnable) {
                    console.log('Set experimental_nfs_shared_volumes=true on '
                        + 'Docker service');
                    ctx.didSomething = true;
                }

                next(err);
            }

            enableNfsSharedVolumesInDocker(ctx.dockerSvc.uuid, {
                sapiClient: sapiClient
            }, _nfsSharedVolumesEnabled);
        },
        function done(ctx, next) {
            if (ctx.didSomething) {
                console.log('Setup "volapi" (%ds)',
                    Math.floor((Date.now() - start) / 1000));
            } else {
                console.log('"volapi" is already set up');
            }

            next();
        }
    ]}, function _setupVolapiDone(err) {
        if (err) {
            console.error('Error:', err);
        }

        updatesImgApiClient.close();
        localImgApiClient.close();
        cnapiClient.close();
        vmapiClient.close();
        sapiClient.close();
        papiClient.close();
        ufdsClient.destroy();
    });
}

setupVolapi();
