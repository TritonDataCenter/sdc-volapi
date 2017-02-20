/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Introduction
 * ------------
 *
 * volapi-updater runs as part of a separate SMF service. Its role is to watch
 * for changes in state for NFS shared volumes' storage VMs, and update these
 * volumes' state according to their storage VM's state changes.
 *
 * For instance, when a NFS shared volume is created, its state is 'creating'.
 * As part of the volume creation process, a storage VM is also created. Once
 * that storage VM changes state to 'running', volapi-updater updates the
 * corresponding volume to be in state 'ready'
 *
 * Changefeed usage
 * ----------------
 *
 * volapi-updater uses changefeed to listen for VMAPI state change events. Every
 * time an event is published by VMAPI's changefeed publisher, volapi-updater
 * checks if that event is associated to a VM that acts as a storage VM for a
 * NFS shared volume. If it is, then volapi-updater determines what the new
 * volume's state should be based on the current volume's state and the current
 * storage VM's state, and then write that new volume state to moray.
 *
 * Events ordering concerns
 * ------------------------
 *
 * Because changefeed only provide notifications when a VM's state changed (not
 * the data that changed), and that there's no guarantee on the order of
 * delivery for events, it is necessary for volapi-updater to serialize the
 * operation of updating volumes' state in order to avoid races and ending up
 * with an incorrect state for volumes.
 *
 * Following is a diagram that illustrates this type of race:
 *
 * SC-VM-R -> GETVM-1 -> SC-VM-S -> GETVM-2 -> RCV-GETVM-2 -> RCV-GETVM-1
 *                                                 |              |
 *                                            [VM stopped]    [VM running]
 *
 * Where "SC" means "State change", "R" means "Running", "S" means "Stopped",
 * "RCV" means "Received".
 *
 * The diagram above represents two state changes for the same VM. The first one
 * ("SC-VM-R") represents an event that represents a state change to the
 * "running" state.
 *
 * "GETVM-1" means that we send a GetVm request to VMAPI to get the actual VM
 * state from VMAPI (it's not included in the event published by changefeed).
 *
 * Then "SC-VM-S" represents an event that represents a state change to the
 * "stopped" state.
 *
 * "GETVM-2" means that we send a second GetVm request to VMAPI to get the
 * actual VM state from VMAPI (it's not included in the event published by
 * changefeed).
 *
 * Finally, we get a response from the _second_ GetVm request (RCV-GETVM-2)
 * _before_ receiving the response from the _first_ GetVm request. In other
 * words, we first process that the VM is in a state "stopped", and then
 * "running". As a result, we consider that the current state of that VM is
 * "running", when in reality it's stopped.
 *
 * By processing only one state change event at a time, we can serialize this
 * pipeline and transform the above diagram to the following:
 *
 * SC-VM-R -> GETVM-1 -> SC-VM-S -> RCV-GETVM-1 -> GETVM-2 -> RCV-GETVM-2
 *                                      |                         |
 *                                  [VM running]              [VM stopped]
 *
 * We end up with the correct end state for the storage VM: stopped.
 *
 * Suboptimal serialization to prevent races
 * -----------------------------------------
 *
 * Currently, volapi-updater serializes all state change events _for all VMs_,
 * which is suboptimal. If a significant number of different VMs change state at
 * the same time, actually updating the state of the associate volumes could be
 * delayed significantly.
 *
 * Ideally, we would serialize updates only per VM. This is an improvement that
 * still needs to be implemented.
 *
 * Dealing with concurrent volume state updates
 * --------------------------------------------
 *
 * Contrary to sdc-volapi's API server, volapi-updater doesn't use CNAPI
 * waitlist tickets, or any kind of locking mechanism that would make it not
 * update a given volume's state while another operation on that volume that is
 * holding a lock (such as the sequence of operations performed by a
 * DeleteVolume request) is ongoing.
 *
 * This is fine because the only other operations that can change the state of a
 * volume are:
 *
 * - CreateVolume
 * - DeleteVolume
 *
 * However, the implementation of these operations is designed to not run
 * concurrently with a volume state update performed by volapi-updater as a
 * result of a VM change event.
 *
 * CreateVolume and DeleteVolume always schedule a storage VM creation _after_
 * they wrote the latest possible volume state update to moray.
 *
 * volapi-updater still uses an etag to not overwrite other changes made to
 * volume objects, such as when a volume's name is updated. In this case, an
 * etag conflict error would result in volapi-updater reloading the volume, and
 * retrying to update its state.
 */

var execFile = require('child_process').execFile;
var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_changefeed = require('changefeed');
var mod_restify = require('restify');
var mod_vasync = require('vasync');
var mod_VError = require('verror');
var path = require('path');
var VmapiClient = require('sdc-clients').VMAPI;

var configLoader = require('./lib/config-loader');
var mod_volumeUtils = require('./lib/volumes.js');
var volumeModels = require('./lib/models/volumes.js');
var Moray = require('./lib/moray.js');

function VmsUpdater(options) {
    this._changefeedListener = null;

    mod_assert.object(options, 'options');

    mod_assert.optionalObject(options.log, 'options.log');
    this._log = options.log || mod_bunyan.createLogger({
        name: 'vms-updater',
        level: 'info',
        stream: process.stderr
    });

    mod_assert.object(options.vmapiClient, 'options.vmapiClient');
    this._vmapiClient = options.vmapiClient;

    mod_assert.string(options.changefeedPublisherUrl,
        'options.changefeedPublisherUrl');
    this._changefeedPublisherUrl = options.changefeedPublisherUrl;

    this._vmChangeEventsQueue =
        mod_vasync.queue(this._processVmChangeEvent.bind(this), 1);
}

function getInstanceUuid(callback) {
    mod_assert.func(callback, 'callback');

    execFile('/usr/bin/zonename', [],
        function onZonenameDone(error, stdout, stderr) {
            var instanceUuid;

            if (!error) {
                instanceUuid = stdout.toString().trim();
            }

            callback(error, instanceUuid);
        });
}

VmsUpdater.prototype.init = function init(callback) {
    mod_assert.func(callback, 'callback');

    var self = this;
    var context = {};

    mod_vasync.pipeline({funcs: [
        function doGetInstanceUuid(ctx, next) {
            self._log.debug('Getting instance UUID...');

            getInstanceUuid(function gotInstanceUuid(err, instanceUuid) {
                self._log.debug({
                    error: err,
                    instanceUuid: instanceUuid
                }, 'Got instance UUID');

                ctx.instanceUuid = instanceUuid;
                next(err);
            });
        },
        function initChangefeedListener(ctx, next) {
            mod_assert.uuid(ctx.instanceUuid, 'ctx.instanceUuid');

            var options = {
                backoff: {
                    maxTimeout: Infinity,
                    minTimeout: 10,
                    retries: Infinity
                },
                log: self._log,
                url: self._changefeedPublisherUrl,
                instance: ctx.instanceUuid,
                service: 'volapi',
                changeKind: {
                    resource: 'vm',
                    subResources: ['state', 'nics', 'destroyed']
                }
            };

            self._changefeedListener = mod_changefeed.createListener(options);

            next();
        }
    ], arg: context
    }, function onInitDone(err) {
        var initErr;

        if (err) {
            initErr = new mod_VError.VError(err,
                'Error when initializing VMs updater');
        }

        callback(initErr);
    });
};

function updateVolumeStateFromStorageVm(volume, storageVm) {
    mod_assert.object(volume, 'volume');
    mod_assert.object(storageVm, 'storageVm');

    if (storageVm.state === 'running') {
        if (volume.state === 'creating' || volume.state === 'failed') {
            volume.state = 'ready';
        }
    } else if (storageVm.state === 'destroyed') {
        if (volume.state === 'creating') {
            volume.state = 'failed';
        } else if (volume.state === 'deleting') {
            volume.state = 'deleted';
        } else if (volume.state !== 'deleted') {
            volume.state = 'failed';
        }
    } else if (storageVm.state === 'failed') {
        volume.state = 'failed';
    } else if (storageVm.state === 'stopped') {
        if (volume.state !== 'deleting') {
            volume.state = 'failed';
        }
    }
}

function updateVolumeNfsPathFromStorageVm(volume, storageVm) {
    mod_assert.object(volume, 'volume');
    mod_assert.object(storageVm, 'storageVm');

    var fsPath = path.join(mod_volumeUtils.NFS_SHARED_VOLUME_EXPORTS_BASEDIR,
        mod_volumeUtils.NFS_SHARED_VOLUME_EXPORTS_DIRNAME);
    var remoteNfsPath;
    var storageVmIp;

    if (storageVm.nics && storageVm.nics.length >= 1) {
        storageVmIp = storageVm.nics[0].ip;
        remoteNfsPath = storageVmIp + ':' + fsPath;
        volume.filesystem_path = remoteNfsPath;
    }
}

function updateVolumeFromStorageVm(volumeObject, storageVm, callback) {
    mod_assert.object(volumeObject, 'volumeObject');
    mod_assert.object(storageVm, 'storageVm');
    mod_assert.func(callback, 'callback');

    updateVolumeStateFromStorageVm(volumeObject.value, storageVm);
    updateVolumeNfsPathFromStorageVm(volumeObject.value, storageVm);

    function updateVolume() {
        volumeModels.updateVolumeWithRetry(volumeObject.value.uuid,
            volumeObject,
            function onVolUpdated(volUpdateErr) {
                if (volUpdateErr && volUpdateErr.name === 'EtagConflictError') {
                    volumeModels.loadVolume(volumeObject.value.uuid,
                        function onReloaded(loadVolErr, reloadedVolumeObject) {
                            if (loadVolErr) {
                                callback(loadVolErr);
                                return;
                            }

                            setTimeout(function retryUpdateVolume() {
                                updateVolumeFromStorageVm(reloadedVolumeObject,
                                    storageVm, callback);
                            }, 2000);
                            return;
                        });
                } else {
                    callback(volUpdateErr);
                    return;
                }
            });
    }

    updateVolume();
}

function updateVolumeFromVm(vm, log, callback) {
    mod_assert.object(vm, 'vm');
    mod_assert.object(log, 'log');
    mod_assert.func(callback, 'callback');

    var vmUuid = vm.uuid;
    mod_assert.uuid(vmUuid, 'vmUuid');

    var context = {};

    mod_vasync.pipeline({funcs: [
        function getVolumeForVm(ctx, next) {
            volumeModels.listVolumes({
                vm_uuid: vmUuid
            }, function onListVolumes(err, volumes) {
                mod_assert.optionalArrayOfObject(volumes, 'volumes');

                if (volumes && volumes.length > 0) {
                    log.debug({volumes: volumes},
                        'VM is used as volume storage');

                    mod_assert.ok(volumes.length <= 1);
                    ctx.volume = volumes[0];
                } else {
                    log.debug('VM is not used as volume storage');
                }

                next(err);
            });
        },
        function updateVolume(ctx, next) {
            if (ctx.volume === undefined) {
                next();
                return;
            } else {
                updateVolumeFromStorageVm(ctx.volume, vm, next);
            }
        }
    ], arg: context}, callback);
}

function updateVolumeFromVmChangeEvent(vmChangeEvent, log, vmapiClient,
    callback) {
    mod_assert.object(vmChangeEvent, 'vmChangeEvent');
    mod_assert.object(log, 'log');
    mod_assert.object(vmapiClient, 'vmapiClient');
    mod_assert.func(callback, 'callback');

    mod_assert.object(vmChangeEvent, 'vmChangeEvent');

    log.debug({
        event: vmChangeEvent
    }, 'Processing change event');

    var vmUuid = vmChangeEvent.changedResourceId;
    mod_assert.uuid(vmUuid, 'vmUuid');

    var context = {};
    mod_vasync.pipeline({funcs: [
        function checkVmIsForVolumeStorage(ctx, next) {
            log.debug('Checking if VM is used for volume storage...');

            volumeModels.listVolumes({
                vm_uuid: vmUuid
            }, function onListVolumes(err, volumes) {
                mod_assert.optionalArrayOfObject(volumes, 'volumes');

                if (volumes) {
                    log.debug({
                        volumes: volumes
                    }, 'VM is used as volume storage');

                    mod_assert.ok(volumes.length <= 1);
                    if (volumes.length > 0) {
                        ctx.volume = volumes[0];
                    }
                } else {
                    log.debug('VM is not used as volume storage');
                }

                next(err);
            });
        },
        function getVmFromVmapi(ctx, next) {
            mod_assert.optionalObject(ctx.volume, 'ctx.volume');

            if (ctx.volume === undefined) {
                next();
                return;
            }

            log.debug('Getting storage VM from VMAPI...');

            vmapiClient.getVm({
                uuid: vmUuid
            }, function onGetVm(getVmErr, vm) {
                log.debug({
                    error: getVmErr,
                    vm: vm
                }, 'Got storage VM');

                ctx.storageVm = vm;
                next(getVmErr);
            });
        },
        function updateVolume(ctx, next) {
            mod_assert.optionalObject(ctx.volume, 'ctx.volume');

            if (ctx.volume === undefined) {
                next();
                return;
            }

            mod_assert.optionalObject(ctx.storageVm, 'ctx.storageVm');
            if (ctx.storageVm === undefined) {
                next();
                return;
            }

            log.debug({
                volume: ctx.volume,
                storageVm: ctx.storageVm
            }, 'Updating volume from storage VM...');

            updateVolumeFromStorageVm(ctx.volume, ctx.storageVm,
                function onVolumeUpdated(err) {
                    if (err) {
                        log.error({
                            erorr: err,
                            volume: ctx.volume,
                            storageVm: ctx.storageVm
                        },
                        'Error when updating volume with storage vm');
                    } else {
                        log.info({
                            storageVm: ctx.storageVm,
                            volume: ctx.volume
                        }, 'Successfully updated volume with storage ' +
                                'vm');
                    }

                    next(err);
                });
        }
    ], arg: context
    }, callback);
}

function updateAllVolumesFromVmApi(vmapiClient, log, callback) {
    mod_assert.object(vmapiClient, 'vmapiClient');
    mod_assert.object(log, 'log');
    mod_assert.func(callback, 'callback');

    log.info('Updating all volumes from VMAPI...');

    vmapiClient.listVms({
        /*
         * We should list VMs using an indexed property that indicates that a
         * given VM acts as a host for a NFS shared volume, but there's no such
         * thing available yet, so instead we rely on the alias that uses a
         * common prefix for NFS shared volumes VMs.
         */
        alias: mod_volumeUtils.NFS_SHARED_VOLUME_VM_ALIAS_PREFIX
    }, function onGetAllVolumesVms(getVmsErr, volumeVms) {
        if (getVmsErr) {
            log.error({error: getVmsErr},
                'Error when fetching VMs during bootstrap');
            callback(getVmsErr);
            return;
        } else {
            mod_vasync.forEachParallel({
                func: function _updateVolumeFromVm(vm, done) {
                    updateVolumeFromVm(vm, log, done);
                },
                inputs: volumeVms
            }, callback);
            return;
        }
    });
}

VmsUpdater.prototype.start = function start() {
    mod_assert.object(this._changefeedListener, 'this._changefeedListener');

    var self = this;

    self._changefeedListener.register();

    self._changefeedListener.on('bootstrap',
        function _updateAllVolumesFromVmApi() {
            updateAllVolumesFromVmApi(self._vmapiClient, self._log,
                function onAllVolumesUpdated(err) {
                    if (err) {
                        self._log.error({error: err}, 'Error when updating ' +
                            'volumes on bootstrap, retrying...');
                        setTimeout(_updateAllVolumesFromVmApi, 2000);
                    } else {
                        self._log.info('All volumes updated successfully on ' +
                            'bootstrap');
                        self._startProcessingChangefeedEvents();
                    }
                });
        });
};

VmsUpdater.prototype._processVmChangeEvent =
    function _processVmChangeEvent(vmChangeEvent, callback) {
        var self = this;

        self._log.info({vmChangeEvent: vmChangeEvent},
            'Process VM change event...');

        updateVolumeFromVmChangeEvent(vmChangeEvent, self._log,
            self._vmapiClient, function onVmChangeEventHandled(err) {
                if (err) {
                    self._log.error({
                        error: err,
                        event: vmChangeEvent
                    }, 'Error when processing changefeed event');
                } else {
                    self._log.debug({
                        event: vmChangeEvent
                    }, 'Changefeed event processed successfully');
                }

                callback(err);
            });
};

VmsUpdater.prototype._startProcessingChangefeedEvents =
    function _startProcessingChangefeedEvents() {
        var self = this;

        self._changefeedListener.on('data',
            function processVmChangeEvent(vmChangeEvent) {
                self._vmChangeEventsQueue.push(vmChangeEvent);
            });
    };

function startVmsUpdater(config, log) {
    mod_assert.object(config, 'config');
    mod_assert.object(log, 'log');

    var vmapiClient = new VmapiClient(config.vmapi);
    var vmsUpdater = new VmsUpdater({
        log: log,
        vmapiClient: vmapiClient,
        changefeedPublisherUrl: config.vmapi.url
    });

    vmsUpdater.init(function onVmsUpdateInitDone(initUpdaterErr) {
        if (initUpdaterErr) {
            log.error({error: initUpdaterErr},
                'An error was encountered when initializing the VMs updater, ' +
                    'exiting');
            /*
             * Set process.exitCode instead of calling process.exit() to avoid
             * some output from not being written on some versions of node. See
             * e.g https://github.com/nodejs/node/issues/6456 for more context.
             */
            process.exitCode = 1;
        } else {
            log.info('VMS updater initialized successfully');
            vmsUpdater.start();
        }
    });
}

function main() {
    var config = configLoader.loadConfigSync();
    var log = new mod_bunyan.createLogger({
        name: 'volapi-updater',
        level: config.logLevel || 'debug',
        serializers: mod_bunyan.stdSerializers
    });
    var morayClient;

    mod_vasync.pipeline({funcs: [
        function connectToMoray(arg, next) {
            morayClient = new Moray(config.moray);
            morayClient.connect();
            morayClient.on('connect', next);
        },
        function initModels(arg, next) {
            volumeModels.init(config, {
                morayClient: morayClient,
                log: log
            }, next);
        }
    ]}, function allDependenciesInitialized(err) {
        startVmsUpdater(config, log);
    });
}

main();