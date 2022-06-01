<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
    Copyright 2022 MNX Cloud, Inc.
-->

# sdc-volapi

This repository is part of the Triton Data Center project (Triton).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/TritonDataCenter/triton) project page.

The SDC Volumes API (VOLAPI) manages volumes for SDC. Volumes can be used to
store data that can be read and/or written by virtual machines (including Docker
containers, infrastructure containers and hardware virtual machines).

For a complete overview of volapi, please read the
[RFD 26](https://github.com/TritonDataCenter/rfd/blob/master/rfd/0026/README.md)
document.

## Repository

```txt
boot/           Shell scripts for booting and configuring the zone
deps/           Git submodules that contains dependencies that this
                repository uses to perform various tasks, such as code
                linting.
docs/           Project docs (restdown)
lib/            Source files.
node_modules/   Node.js deps, populated at build time.
sapi_manifests/ Service API (SAPI) manifests
smf/manifests   SMF manifests
test/           Test suite (using node-tap)
tools/          Miscellaneous dev/upgrade/deployment tools and data.
Makefile
package.json    npm module info (holds the project version)
README.md
```

## NFS Zone

When a volume is created, volapi will provision a SmartOS zone with a fabric NIC
attached. The zone will be marked with the following property:

```js
vm.internal_metadata['sdc:system_role'] = 'nfsvolumestorage';
```

The NFS volumes (zones) created by volapi come in two different versions.

### Version 1

Version 1 NFS volumes uses a Node.js server to handle the NFS connections.

Version 1 is deprecated and volapi will try to create version 2 volumes
when possible.

### Version 2

Version 2 NFS volumes use the SmartOS builtin NGZ (non global zone) NFS server.

Volumes (zones) created with version 2 will have the following internal_metadata
property set:

```js
vm.internal_metadata['volapi-nfs-version'] = 2;
```

Note that if a version 2 volume cannot be created (due to the requirement of a
newer platform version not being available), then volapi will fallback to
creating a version 1 NFS volume instead.

## Development

### Getting started

#### Requirements

In order to be able to use Docker NFS shared volumes (Docker volumes created
with the `tritonnfs` driver), a [working sdc-docker installation is
required](https://github.com/TritonDataCenter/sdc-docker#installation).

Without installing sdc-docker, it is still possible to use VOLAPI to create and
use volumes, just not through Docker APIs/clients.

#### Installation

1. Install and enable the VOLAPI service by running the following command on
   your DC's headnode:

   ```shell
   sdcadm post-setup volapi
   ```

2. Enable NFS volumes feature flags by running the following commands on your
   DC's headnode:

   ```shell
   # Enables support for creating/managing NFS volumes with the docker API and
   # the docker volume commands
   $ sdcadm experimental nfs-volumes docker

   # Enables support for docker containers to automatically mount NFS volumes
   # at startup time
   $ sdcadm experimental nfs-volumes docker-automount

   # Enables support for creating/managing NFS volumes with CloudAPI
   $ sdcadm experimental nfs-volumes cloudapi

   # Enables support for non-Docker VMs (except KVM VMs) to automatically mount
   # NFS volumes at startup time
   $ sdcadm experimental nfs-volumes cloudapi-automount
   ```

3. Install the latest version of node-triton to get NFS shared volumes support:

   ```shell
   npm install -g triton
   ```

### Contributing changes

Before commiting/pushing run `make prepush` and, if possible, get a code
review.

## Testing

### Running integration tests in COAL

```shell
make test-integration-in-coal
```
