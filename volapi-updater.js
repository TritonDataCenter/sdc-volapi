/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Introduction
 * ============
 *
 * volapi-updater runs as part of a separate SMF service. It performs two tasks:
 *
 * 1. It watches for changes in state for NFS shared volumes' storage VMs, and
 *    update these volumes' properties (state, NFS remote path, etc.) according
 *    to their storage VM's changes. For instance, when a NFS shared volume is
 *    created, its state is 'creating'. As part of the volume creation process,
 *    a storage VM is also created. Once that storage VM changes state to
 *    'running', volapi-updater updates the corresponding volume to be in state
 *    'ready'
 *
 * 2. It keeps volume references consistent. For instance, when a VM that
 *    requires a NFS volume gets destroyed, volapi-updater notices the VM
 *    changes its state to 'destroyed' and removes that VM from the "refs"
 *    property of all volumes that that VM was requiring. It also removes all
 *    the volume reservations associated to that VM.
 *
 *
 * Those two responsiblities are considered as two different logical processes,
 * even though they are performed by the same program, and they share a lot of
 * code.
 *
 * Watching volumes' storage VMs
 * =============================
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
 *
 * Keeping volume references consistent
 * ====================================
 *
 * Keeping volume references consistent involves two separate processes:
 *
 * 1. Processing all entries from the volumes reservations bucket and updating
 *    the volumes reserved and the reservations themselves depending on the
 *    state of the VM that made the reservation.
 *
 * 2. Processing VM changefeed events to update references and reservations when
 *    a VM referencing a volume changes state.
 *
 * Using the volumes reservations bucket
 * -------------------------------------
 *
 * When provisioning a VM that requires a NFS volume (via e.g a "docker run -v
 * volume-name:/mountpoint" command), a volume reservation is created that
 * associates the volumes that are required and the provisioning VM. Creating a
 * volume reservation implicitly creates a reference from the provisioning VM to
 * the volume when the volume is created, and before the VM is provisioned.
 *
 * This serves different purposes:
 *
 * 1. It allows VMs that are provisioning to hold a reference to their required
 *    volumes. Thus, a user cannot delete these volumes even when the VM is not
 *    provisioned. Instead they get a "volume in use" error.
 *
 * 2. It allows volapi-updater to check for VMs that failed to update their
 *    references and clear their reservations via AddReference requests, or
 *    failed to provision and somehow didn't get their state and/or their
 *    provisioning workflow's state updated. volapi-updater is able to
 *    determine, depending on the state of the provisioning workflow, the state
 *    of the VM, and the time at which the provisioning workflow was created
 *    whether it's safe to keep/remove the implicit references and clear the
 *    reservations that were created.
 *
 * Processing changefeed events
 * ----------------------------
 *
 * In addition to going through the volumes reservations table periodically,
 * volapi-updater also uses VMAPI changefeed events to keep the references and
 * volumes reservations consistent with the state of VMs that require volumes.
 *
 * When a VM changes its state, volapi-updater gets a changefeed event. For
 * instance, if the state of that VM is "active" (running or stopped), then
 * volapi-updater makes sure that, if it requires NFS volumes, the volume
 * objects that represent the volumes it requires have that VM's uuid in their
 * "refs" property.
 *
 * When volapi-updater processes a changefeed event and is confident that it can
 * update volume references accordingly, it also clears all volume reservations
 * associated with the VM for which it received a changefeed event, since the
 * purpose of volumes reservations is really to hold a reference to a volume
 * until the state of the VM that reserved it is known.
 *
 * Known issues
 * ------------
 *
 * It is possible for a VM to transition from a state === 'failed' to a state
 * that is considered active. In this case, what would happen is that
 * volapi-updater could get two events, one for when the state changes to
 * 'failed', and another one when the VM transition to an active state.
 *
 * When processing the event corresponding to the VM transitioning to the state
 * 'failed', volapi-updater would remove the VM's uuid from the "refs" property
 * of all volumes that were previously referenced by it. At that point, the
 * owner of the volumes referenced by the VM would be able to delete all these
 * volumes, even though the VM would actually be running on the CN, and would
 * later come back to an active state.
 *
 * This is currently considered to be an acceptable limitation.
 */

var execFile = require('child_process').execFile;
var mod_assert = require('assert-plus');
var mod_backoff = require('backoff');
var mod_bunyan = require('bunyan');
var mod_changefeed = require('changefeed');
var mod_jsprim = require('jsprim');
var mod_restify = require('restify');
var mod_vasync = require('vasync');
var mod_VError = require('verror');
var path = require('path');
var VmapiClient = require('sdc-clients').VMAPI;
var WfClient = require('wf-client');

var configLoader = require('./lib/config-loader');
var mod_volumeUtils = require('./lib/volumes.js');
var models = require('./lib/models');
var reservationModels = require('./lib/models/volume-reservations.js');
var volumeModels = require('./lib/models/volumes.js');
var Moray = require('./lib/moray.js');

function VolumesUpdater(options) {
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

VolumesUpdater.prototype.init = function init(callback) {
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

    function deleteVolume() {
        // When deleting we won't hit an Etag error, so we don't need to load
        // and retry. We can just do the regular retries on transient moray
        // errors.
        volumeModels.deleteVolumeWithRetry(volumeObject.value.uuid, callback);
    }

    if (volumeObject.value.state === 'deleted') {
        // Switching to 'deleted' means removing the entry rather than updating
        // it in Moray.
        deleteVolume();
    } else {
        updateVolume();
    }
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

    log.debug({
        vmChangeEvent: vmChangeEvent
    }, 'Updating volume from VM changefeed event');

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

            if (ctx.volume === undefined || ctx.storageVm === undefined) {
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

    vmapiClient.listVms({
        'tag.smartdc_role': mod_volumeUtils.NFS_SHARED_VOLUME_SMARTDC_ROLE
    }, function onGetAllVolumesVms(getVmsErr, volumeVms) {
        if (getVmsErr) {
            log.error({error: getVmsErr}, 'Error when fetching VMs');
            callback(getVmsErr);
            return;
        } else {
            mod_vasync.forEachParallel({
                func: function _updateVolumeFromVm(vm, done) {
                    updateVolumeFromVm(vm, log, done);
                },
                inputs: volumeVms
            }, function onVolsUpdated(volsUpdateErr) {
                if (volsUpdateErr) {
                    log.error({
                        err: volsUpdateErr
                    }, 'Error when updating volumes');
                } else {
                    log.info('All volumes updated successfully');
                }

                callback(volsUpdateErr);
            });
            return;
        }
    });
}

/*
 * Get the list of VMs that are currently referencing or reserving a volume.
 */
function getAllPotentialRefVms(options, callback) {
    mod_assert.object(options, 'options');
    mod_assert.object(options.log, 'options.log');
    mod_assert.func(callback, 'callback');

    var vmUuidsMap = {};

    mod_vasync.parallel({funcs: [
        function loadVolumeReservations(done) {
            reservationModels.listVolumeReservations(onListVolsRes);

            function onListVolsRes(listErr, reservations) {
                if (!listErr && reservations) {
                    reservations.forEach(function setReservation(res) {
                        vmUuidsMap[res.value.vm_uuid] = true;
                    });
                }

                done(listErr);
            }
        },
        function loadVolumesRefs(done) {
            volumeModels.listVolumesByFilter('(refs=*)',
                function onListVolumes(listErr, volumeObjects) {
                    if (listErr) {
                        done(listErr);
                        return;
                    }

                    mod_assert.optionalArrayOfObject(volumeObjects,
                        'volumeObjects');

                    if (!volumeObjects || volumeObjects.length === 0) {
                        done();
                        return;
                    }

                    volumeObjects.forEach(function processVolumeObj(volumeObj) {
                        var volumeRefs = volumeObj.value.refs;
                        mod_assert.optionalArrayOfUuid(volumeRefs,
                            'volumeRefs');

                        if (!volumeRefs || volumeRefs.length === 0) {
                            return;
                        }

                        volumeRefs.forEach(function setVolRef(vmUuidRef) {
                            vmUuidsMap[vmUuidRef] = true;
                        });
                    });

                    done();
                });
        }
    ]}, function onResAndRefsLoaded(loadErr) {
        var refVms = Object.keys(vmUuidsMap);

        if (loadErr) {
            callback(loadErr);
            return;
        }

        callback(null, refVms);
    });
}

function updateAllVolumesRefs(options, callback) {
    mod_assert.object(options, 'options');
    mod_assert.object(options.vmapiClient, 'options.vmapiClient');
    mod_assert.object(options.log, 'options.log');
    mod_assert.func(callback, 'callback');

    var context = {};
    var log = options.log;

    mod_vasync.pipeline({arg:context, funcs: [
        function getPotentialRefVms(ctx, next) {
            log.info('Getting all VMs that are referencing volumes');

            getAllPotentialRefVms({
                log: options.log
            }, function onGetRefVms(getErr, refVms) {
                if (getErr) {
                    log.error({
                        err: getErr
                    }, 'Error when getting all VMs that are referencing ' +
                        'volumes');
                } else {
                    log.info({
                        vms: refVms
                    }, 'Got all VMs that are referencing volumes');
                }

                ctx.refVms = refVms;
                next(getErr);
            });
        },
        function updateVolumesRefsAndResFromVms(ctx, next) {
            var updateRefsQueue;

            mod_assert.optionalArrayOfUuid(ctx.refVms, 'ctx.refVms');

            log.info({
                vms: ctx.refVms
            }, 'Updating references for referencing VMs');

            if (ctx.refVms && ctx.refVms.length > 0) {
                updateRefsQueue = mod_vasync.queue(updateRefsForVm, 10);

                updateRefsQueue.on('end', function onUpdateRefsQueueEnd() {
                    log.info({
                        vms: ctx.refVms
                    }, 'Done updating references for referencing VMs');
                    next();
                });

                ctx.refVms.forEach(function pushToUpdateRefsQueue(vmUuid) {
                    updateRefsQueue.push(vmUuid);
                });

                updateRefsQueue.close();
            } else {
                log.info('No reference to update');
                next();
            }

            function updateRefsForVm(vmUuid, done) {
                mod_assert.uuid(vmUuid, 'vmUuid');

                updateReferencesAndReservationsForVm(vmUuid, {
                    log: options.log,
                    vmapiClient: options.vmapiClient
                }, done);
            }
        }
    ]}, callback);
}

VolumesUpdater.prototype.start = function start() {
    mod_assert.object(this._changefeedListener, 'this._changefeedListener');

    var self = this;

    self._changefeedListener.register();

    self._changefeedListener.on('bootstrap', function onBootstrap() {
        mod_vasync.parallel({funcs: [
            function updateVolumes(done) {
                self._log.info('Updating all volumes from VMAPI');
                updateAllVolumesFromVmApi(self._vmapiClient, self._log,
                    function onUpdateVolsDone(volsUpdateErr) {
                        if (volsUpdateErr) {
                            self._log.error({error: volsUpdateErr},
                                    'Error when updating all volumes from ' +
                                        'VMAPI');
                        } else {
                            self._log.info('All volumes updated from VMAPI ' +
                                'successfully');
                        }

                        done(volsUpdateErr);
                    });
            },
            function updateVolumesRefsAndRes(done) {
                self._log.info('Updating all volumes references and ' +
                    'reservations');
                updateAllVolumesRefs({
                    vmapiClient: self._vmapiClient,
                    log: self._log
                }, function onUpdateVolRefsAndResDone(updateErr) {
                    if (updateErr) {
                        self._log.error({error: updateErr},
                            'Error when updating all volumes references and ' +
                                'reservations');
                    } else {
                        self._log.info('Updated all volumes references and ' +
                                'reservations successfully');
                    }

                    done(updateErr);
                });
            }
        ]}, function onBootstrapDone(bootstrapErr) {
            if (bootstrapErr) {
                self._log.error({err: bootstrapErr},
                    'Error when updating volumes on bootstrap, retrying...');
                setTimeout(onBootstrap, 2000);
            } else {
                self._log.info('All volumes updated successfully on bootstrap');
                self._startProcessingChangefeedEvents();
            }
        });
    });
};

function updateReferencesAndReservationsForVm(vmUuid, options, callback) {
    mod_assert.uuid(vmUuid, 'vmUuid');
    mod_assert.object(options, 'options');
    mod_assert.object(options.log, 'options.log');
    mod_assert.object(options.vmapiClient, 'options.vmapiClient');
    mod_assert.optionalBool(options.considerProvisioningVmFailed,
        'opts.considerProvisioningVmFailed');
    mod_assert.func(callback, 'callback');

    var considerProvisioningVmFailed = options.considerProvisioningVmFailed;
    var context = {};
    var log = options.log;
    var RETRY_DELAY = 1000;
    var MAX_NB_TRIES = 5;
    var nbTries = 0;
    var vmapiClient = options.vmapiClient;

    function doUpdate() {
        ++nbTries;

        mod_vasync.pipeline({arg: context, funcs: [
            function getVm(ctx, next) {
                var STATES_REQUIRE_REFS_ADD = ['running', 'stopped'];
                var STATES_REQUIRE_REFS_DEL = ['failed', 'destroyed'];

                if (considerProvisioningVmFailed === true) {
                    STATES_REQUIRE_REFS_DEL.push('provisioning');
                }

                log.debug({vm_uuid: vmUuid}, 'Getting VM');

                vmapiClient.getVm({
                    uuid: vmUuid
                }, function onGetVm(getVmErr, vm) {
                    if (getVmErr) {
                        log.error({err: getVmErr}, 'Error when getting VM');
                        next(getVmErr);
                        return;
                    }

                    log.info({vm: vm}, 'Got VM');

                    mod_assert.optionalObject(vm, 'vm');
                    if (vm) {
                        if (STATES_REQUIRE_REFS_ADD.indexOf(vm.state) !== -1) {
                            ctx.shouldAddReferences = true;
                        } else if (STATES_REQUIRE_REFS_DEL.indexOf(vm.state)
                            !== -1) {
                            ctx.shouldDeleteReferences = true;
                        }

                        ctx.vm = vm;
                    } else {
                        ctx.shouldDeleteReferences = true;
                    }

                    next(getVmErr);
                });
            },
            function loadVolumesRefedByVmWithNoVolumesInfo(ctx, next) {
                var listVolumesParams;

                if (ctx.shouldAddReferences !== true &&
                    ctx.shouldDeleteReferences !== true) {
                    log.info({
                        vmUuid: vmUuid
                    }, 'No reference to add or delete, no need to load ' +
                        'volumes refed by absent VM');
                    next();
                    return;
                }

                /*
                 * When the VM for which we update its volume references and
                 * reservations does not exist, or does not have any data about
                 * the volumes it requires, we can't load the volumes that
                 * it might have referenced if and when it existed.
                 *
                 * If we're dealing with a non-existent VM, and since VMAPI
                 * doesn't delete VMs, the VM can only be absent from VMAPI when
                 * we're updating references and reservations as a result of a
                 * workflow failing or being in the state "executing" for too
                 * long, and that somehow the VM object was not created in
                 * VMAPI. So we're in either of two cases:
                 *
                 * 1. The VM actually exists on a CN, and will eventually show
                 *    up in VMAPI because vm-agent will PUT it. References may
                 *    have already been added to some volumes from the
                 *    provisioning workflow. Deleting those references means
                 *    that those volumes could be deleted even though they
                 *    should not be, but it's a compromise that we're willing to
                 *    accept.
                 *
                 * 2. The VM does not exist on a CN, and thus will never show up
                 *    in VMAPI. In this case, it's safe to delete any
                 *    reference left for this VM.
                 *
                 * In both cases, it is fine to delete any reservation.
                 */
                if (ctx.vm !== undefined && ctx.vm.volumes !== undefined) {
                    next();
                    return;
                }

                listVolumesParams = {
                    refs: ctx.vm.uuid
                };

                log.info({
                    params: listVolumesParams
                }, 'Loading volumes referenced by non-existing VM');

                volumeModels.listVolumes(listVolumesParams,
                    function onListVols(listVolsErr, volumeObjects) {
                        if (listVolsErr) {
                            log.error({
                                err: listVolsErr
                            }, 'Error when loading volumes referenced by ' +
                                'non-existing VM');
                        } else {
                            log.info({
                                volumeObjects: volumeObjects
                            }, 'Loaded volumes referenced by non-existing VM');
                        }

                        ctx.volumesToProcess = volumeObjects;

                        next(listVolsErr);
                    });
            },
            function loadVolumesRefedByExistentVm(ctx, next) {
                var requiredVolumes = [];
                var volumeNames;
                var volumeOwnerUuid;

                if (ctx.shouldAddReferences !== true &&
                    ctx.shouldDeleteReferences !== true) {
                    log.info({
                        vmUuid: vmUuid
                    }, 'No reference to add or delete, no need to load ' +
                        'volumes refed by existent VM');
                    next();
                    return;
                }

                if (ctx.vm === undefined ||
                    ctx.vm.volumes === undefined) {
                    next();
                    return;
                }

                volumeNames = ctx.vm.volumes.map(function getVolNames(volume) {
                    mod_assert.string(volume.name, 'volume.name');
                    return volume.name;
                });
                volumeOwnerUuid = ctx.vm.owner_uuid;

                log.info({
                    volumes: ctx.vm.volumes,
                    vm: ctx.vm
                }, 'Loading volumes required by VM');

                mod_vasync.forEachParallel({
                    func: function loadRequiredVolume(volumeName, done) {
                        mod_assert.string(volumeName, 'volumeName');

                        log.info({
                            name: volumeName,
                            ownerUuid: volumeOwnerUuid
                        }, 'Listing volumes');

                        volumeModels.listVolumes({
                            name: volumeName,
                            owner_uuid: volumeOwnerUuid,
                            state: 'ready'
                        }, function onVolumesLoaded(volListErr, volumeObjects) {
                            mod_assert.optionalArrayOfObject(volumeObjects,
                                'volumeObjects');

                            if (volListErr) {
                                log.error({err: volListErr},
                                    'Error when listing volumes required by ' +
                                        'VM');
                                done(volListErr);
                                return;
                            }

                            log.info({volumeObjects: volumeObjects},
                                'Found volumes required by VM');

                            if (volumeObjects === undefined ||
                                volumeObjects.length === 0) {
                                done();
                                return;

                            }

                            if (volumeObjects.length > 1) {
                                done(new Error('Found more than one volume ' +
                                    'with name: ' + volumeName + ' and ' +
                                    'owner_uuid: ' + volumeOwnerUuid));
                                return;
                            }

                            requiredVolumes.push(volumeObjects[0]);

                            done();
                        });
                    },
                    inputs: volumeNames
                }, function onRequiredVolsLoaded(loadErr) {
                    ctx.volumesToProcess = requiredVolumes;
                    next(loadErr);
                });
            },
            function generateRefChanges(ctx, next) {
                mod_assert.optionalArrayOfObject(ctx.volumesToProcess,
                    'ctx.volumesToProcess');

                if (ctx.shouldAddReferences !== true &&
                    ctx.shouldDeleteReferences !== true) {
                    log.info({
                        vmUuid: vmUuid
                    }, 'No reference to add or delete, no need to generate ' +
                        'refs changes');
                    next();
                    return;
                }

                if (!ctx.volumesToProcess) {
                    next();
                    return;
                }

                var volumesToProcess = ctx.volumesToProcess;
                var volumeObjectsToUpdate = [];

                volumesToProcess.forEach(function checkVolumeHasRef(volumeObj) {
                    var refIndex = -1;
                    var volumeRefs;
                    var volumeValue = volumeObj.value;

                    mod_assert.optionalArrayOfUuid(volumeValue.refs,
                        'volumeValue.refs');
                    volumeRefs = volumeValue.refs;

                    if (ctx.shouldAddReferences) {
                        if (volumeRefs === undefined || volumeRefs === null ||
                            volumeRefs.indexOf(vmUuid) === -1) {
                            volumeRefs.push(vmUuid);
                            volumeObjectsToUpdate.push(volumeObj);
                        }
                    } else if (ctx.shouldDeleteReferences) {
                        if (volumeRefs) {
                            refIndex = volumeRefs.indexOf(vmUuid);
                            if (refIndex !== -1) {
                                volumeRefs.splice(refIndex, 1);

                                if (volumeRefs.length === 0) {
                                    delete volumeValue.refs;
                                }

                                volumeObjectsToUpdate.push(volumeObj);
                            }
                        }
                    }
                });

                ctx.volumeObjectsToUpdate = volumeObjectsToUpdate;
                next();
            },
            function updateRefs(ctx, next) {
                mod_assert.optionalArrayOfObject(ctx.volumeObjectsToUpdate,
                    'ctx.volumeObjectsToUpdate');

                if (ctx.shouldAddReferences !== true &&
                    ctx.shouldDeleteReferences !== true) {
                    log.info({
                        vmUuid: vmUuid
                    }, 'No reference to add or delete, no need to update refs');
                    next();
                    return;
                }

                if (!ctx.volumeObjectsToUpdate) {
                    next();
                    return;
                }

                mod_vasync.forEachParallel({
                    func: function updateVolume(volumeObj, done) {
                        volumeModels.updateVolumeWithRetry(volumeObj.value.uuid,
                            volumeObj, function onVolUpdated(volUpdateErr) {
                                if (volUpdateErr &&
                                    volUpdateErr.name === 'EtagConflictError') {
                                    ctx.needRetry = true;
                                }

                                done(volUpdateErr);
                            });
                    },
                    inputs: ctx.volumeObjectsToUpdate
                }, next);
            },
            /*
             * Reservations are cleaned up only if updating references was
             * successful. Otherwise, we might lose some data about provisioning
             * jobs that would still need to be monitored to determine if we
             * need to retry updating references later.
             */
            function cleanupRes(ctx, next) {
                if (ctx.shouldAddReferences !== true &&
                    ctx.shouldDeleteReferences !== true) {
                    log.info({
                        vmUuid: vmUuid
                    }, 'No reference to add or delete, no need to cleanup ' +
                        'reservations');
                    next();
                    return;
                }

                reservationModels.listVolumeReservations({
                    vmUuid: vmUuid
                }, function onReservationsListed(listResErr, reservations) {
                    if (listResErr) {
                        next(listResErr);
                        return;
                    }

                    mod_assert.arrayOfObject(reservations, 'reservations');
                    if (reservations.length > 0) {
                        reservationModels.deleteVolumeReservations(reservations,
                            next);
                    } else {
                        next();
                    }
                });
            }
        ]}, function onUpdateDone(updateErr) {
            if (context.needRetry === true) {
                if (nbTries >= MAX_NB_TRIES) {
                    callback(new Error('Reached max number of tries'));
                    return;
                }

                setTimeout(doUpdate, RETRY_DELAY);
                return;
            }

            callback(updateErr);
        });
    }

    doUpdate();
}

VolumesUpdater.prototype._processVmChangeEvent =
    function _processVmChangeEvent(vmChangeEvent, callback) {
        var self = this;

        var log = self._log;
        var vmUuid = vmChangeEvent.changedResourceId;
        mod_assert.uuid(vmUuid, 'vmUuid');

        log.info({vmChangeEvent: vmChangeEvent},
            'Processing VM change event...');

        mod_vasync.parallel({funcs: [
            function updateVolume(done) {
                updateVolumeFromVmChangeEvent(vmChangeEvent, self._log,
                    self._vmapiClient,
                    function onVolumeUpdate(updateVolErr) {
                        if (updateVolErr) {
                            log.error({
                                error: updateVolErr,
                                changeEvent: vmChangeEvent
                            }, 'Error when updating volume from VM change ' +
                                'event');
                        } else {
                            log.debug({
                                changeEvent: vmChangeEvent
                            }, 'Volume updated successfully');
                        }

                        done(updateVolErr);
                    });
            },
            function updateReferencesAndReservations(done) {
                updateReferencesAndReservationsForVm(vmUuid, {
                    log: self._log,
                    vmapiClient: self._vmapiClient
                }, done);
            }
        ]}, callback);
};

VolumesUpdater.prototype._startProcessingChangefeedEvents =
    function _startProcessingChangefeedEvents() {
        var self = this;

        self._changefeedListener.on('data',
            function processVmChangeEvent(vmChangeEvent) {
                self._log.info({
                    vmChangeEvent: vmChangeEvent
                }, 'Got data event from changefeed');
                self._vmChangeEventsQueue.push(vmChangeEvent);
            });
    };

function startVolumesUpdater(config, log) {
    mod_assert.object(config, 'config');
    mod_assert.object(log, 'log');

    var vmapiClient = new VmapiClient(config.vmapi);
    var volumesUpdater = new VolumesUpdater({
        log: log,
        vmapiClient: vmapiClient,
        changefeedPublisherUrl: config.vmapi.url
    });

    volumesUpdater.init(function onVolsUpdaterInitDone(initUpdaterErr) {
        if (initUpdaterErr) {
            log.error({error: initUpdaterErr},
                'An error was encountered when initializing the volumes ' +
                    'updater, exiting');
            /*
             * Set process.exitCode instead of calling process.exit() to avoid
             * some output from not being written on some versions of node. See
             * e.g https://github.com/nodejs/node/issues/6456 for more context.
             */
            process.exitCode = 1;
        } else {
            log.info('Volumes updater initialized successfully');
            volumesUpdater.start();
        }
    });
}

/*
 * This function checks the status of a job that made a volume reservation, and
 * determines whether it is likely that volume objects may need to be updated.
 */
function checkReservationJob(volumeReservationValue, options, callback) {
    mod_assert.object(volumeReservationValue, 'volumeReservationValue');
    mod_assert.uuid(volumeReservationValue.job_uuid,
        'volumeReservationValue.job_uuid');
    mod_assert.object(options, 'options');
    mod_assert.object(options.log, 'options.log');
    mod_assert.object(options.wfApiClient, 'options.wfApiClient');
    mod_assert.object(options.vmapiClient, 'options.vmapiClient');
    mod_assert.func(callback, 'callback');

    var context = {};
    var log = options.log;
    var reservingVmUuid = volumeReservationValue.vm_uuid;
    var vmapiClient = options.vmapiClient;
    var wfApiClient = options.wfApiClient;

    log.info({
        volumeReservation: volumeReservationValue
    }, 'Starting to check volume reservation');

    mod_vasync.pipeline({arg: context, funcs: [
        function getJob(ctx, next) {
            var jobUuid = volumeReservationValue.job_uuid;

            log.info({jobUuid: jobUuid}, 'Fetching job');

            wfApiClient.getJob(jobUuid, function onGetJob(getJobErr, job) {
                var jobCreationTimeMs;
                var TWO_HOURS_IN_MS = 1000 * 60 * 60 * 2;

                if (getJobErr || job === undefined || job === null) {
                    log.error({err: getJobErr}, 'Could not get job info');

                    next(new mod_VError.VError(getJobErr,
                        'Could not get job info when checking ' +
                            'reservation job'));
                    return;
                }

                log.info({job: job}, 'Fetched job successfully');

                if (job.execution === 'executing') {
                    if (job.created_at !== null && job.created_at !==
                        undefined) {
                        jobCreationTimeMs =
                            new Date(job.created_at).getTime();
                        /*
                         * Wall-clock times comparison is not safe, but this
                         * is the best we can do in Triton as far as I know.
                         * We could do a variety of time consistency checks
                         * (checking the GetJob's response header, etc.),
                         * but it seems currently that the implementation
                         * complexity would outweigh the benefits.
                         */
                        if (Date.now() - jobCreationTimeMs <
                            TWO_HOURS_IN_MS) {
                            /*
                             * If we consider the workflow job hasn't timed
                             * out, and it is still executing, then there's
                             * nothing to do here.
                             */
                            next();
                            return;
                        } else {
                            ctx.considerProvisioningVmFailed = true;
                        }
                    }
                }

                /*
                 * If the VM provisioning job suceeded, we assume it
                 * resulted in the add_volumes_references task of VMAPI's
                 * provisioning workflow adding the relevant references and
                 * cleaning up the relevant reservations, since failing that
                 *  task would make the job as "failed".
                 */
                if (job.execution === 'succeeded') {
                    next();
                    return;
                }

                /*
                 * For any other use case, such as a job with execution
                 * status === 'failed', or a job that has had execution
                 * status === 'running' for too long, we need to cleanup
                 * references and reservations that are now potentially
                 * obsolete.
                 */
                ctx.refreshVmReferencesAndReservations = true;

                next();
            });
        },
        function refreshVmReferencesAndReservations(ctx, next) {
            if (ctx.refreshVmReferencesAndReservations !== true) {
                next();
                return;
            }

            updateReferencesAndReservationsForVm(reservingVmUuid, {
                log: log,
                vmapiClient: vmapiClient,
                considerProvisioningVmFailed: ctx.considerProvisioningVmFailed
            }, next);
        }
    ]}, function onCheckDone(checkErr) {
        var err;

        if (checkErr) {
            log.error({
                err: checkErr,
                volumeReservation: volumeReservationValue
            }, 'Error when checking volume reservation');

            err = new mod_VError.VError(checkErr,
                'Could not check reservation job');
        } else {
            log.info({
                volumeReservation: volumeReservationValue
            }, 'Checked volume reservation successfully');
        }

        callback(err);
    });
}

/*
 * List all reservations from the volumes reservations moray bucket, and check
 * them one by one to determine if some volumes need to be updated.
 */
function pollJobs(options, callback) {
    mod_assert.object(options, 'options');
    mod_assert.object(options.log, 'options.log');
    mod_assert.object(options.vmapiClient, 'options.vmapiClient');
    mod_assert.object(options.wfApiClient, 'options.wfApiClient');

    /*
     * We use a concurrency of 4 so that we can still process multiple
     * reservations in parallel, but we don't want to slam any of the services
     * used in case of a high volume of reservations.
     */
    var CHECK_RESERVATION_JOBS_CONCURRENCY = 4;
    var checkResJobsQueue;
    var log = options.log;
    var vmapiClient = options.vmapiClient;
    var wfApiClient = options.wfApiClient;

    checkResJobsQueue = mod_vasync.queue(checkReservation,
        CHECK_RESERVATION_JOBS_CONCURRENCY);

    checkResJobsQueue.on('end', callback);

    function onResListed(listResErr, res) {
        if (listResErr) {
            log.error({
                err: listResErr
            }, 'Error when listing volume reservations');

            callback(new mod_VError.VError(listResErr, 'Could not check jobs'));
            return;
        }

        log.info({
            reservations: res
        }, 'reservations listed successfully');

        res.forEach(function pushToQueue(reservationObject) {
            checkResJobsQueue.push(reservationObject.value);
        });

        checkResJobsQueue.close();
    }

    function checkReservation(volReservationValue, done) {
        mod_assert.object(volReservationValue, 'volReservationValue');
        mod_assert.func(done, 'done');

        checkReservationJob(volReservationValue, {
            log: log,
            wfApiClient: wfApiClient,
            vmapiClient: vmapiClient
        }, done);
    }

    reservationModels.listVolumeReservations(onResListed);
}

function startJobsWatcher(config, log) {
    mod_assert.object(config, 'config');
    mod_assert.object(log, 'log');

    var CHECK_RESERVATION_JOBS_INTERVAL = 60 * 1000; // 1 minute
    var vmapiClient = new VmapiClient(config.vmapi);
    var wfApiClient;
    var wfApiConfig = mod_jsprim.deepCopy(config.wfapi);

    /*
     * the workflow client seems to _require_ a path property in the config
     * object, so we provide a dummy one. VOLAPI itself does not have any
     * workflow defined in this directory.
     */
    wfApiConfig.path = './foo';
    wfApiConfig.log = log;
    wfApiClient = new WfClient(wfApiConfig);

    function processJobs() {
        log.info('Starting to poll jobs');

        pollJobs({
            log: log,
            vmapiClient: vmapiClient,
            wfApiClient: wfApiClient
        }, function onJobsProcessed(jobsErr) {
            log.info({err: jobsErr}, 'Done polling jobs');

            setTimeout(function checkVolReservationsJobs() {
                processJobs();
            }, CHECK_RESERVATION_JOBS_INTERVAL);
        });
    }

    processJobs();
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
            var modelsInitBackoff = mod_backoff.exponential({
                initialDelay: 100,
                maxDelay: 10000
            });

            modelsInitBackoff.on('ready', function onBackoff(number, delay) {
                models.init(config, {
                    morayClient: morayClient,
                    log: log
                }, function onModelsInitialized(modelsInitErr) {
                    if (modelsInitErr) {
                        log.error({
                            err: modelsInitErr
                        }, 'Error when initializing models, backing off');
                        modelsInitBackoff.backoff();
                    } else {
                        log.info('Models initialized successfully');
                        modelsInitBackoff.reset();
                        next();
                    }
                });
            });

            modelsInitBackoff.backoff();
        }
    ]}, function allDependenciesInitialized(err) {
        /*
         * The "Volumes updater" is an async process that listens to VMAPI's
         * changefeed events and update volume objects accordingly.
         */
        startVolumesUpdater(config, log);
        /*
         * The "jobs watcher" is an async process that polls the volumes
         * reservations moray bucket periodically and updates volumes
         * accordingly. Volumes reservations are created by VM provisioning
         * jobs, and that process primarily checks the state of these jobs to
         * determine what the appropriate action is, hence the name "jobs
         * watcher".
         */
        startJobsWatcher(config, log);
    });
}

main();
