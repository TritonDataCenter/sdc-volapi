<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2017, Joyent, Inc.
-->

# sdc-volapi

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

The SDC Volumes API (VOLAPI) manages volumes for SDC. Volumes can be used to
store data that can be read and/or written by virtual machines (including Docker
containers, infrastructure containers and hardware virtual machines).

# Repository
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


# Development

## Getting started

### Requirements

In order to be able to use Docker NFS shared volumes (Docker volumes created
with the `tritonnfs` driver), a [working sdc-docker installation is
required](https://github.com/joyent/sdc-docker#installation).

Without installing sdc-docker, it is still possible to use VOLAPI to create and
use volumes, just not through Docker APIs/clients.

### Installation

1. Checkout VOLAPI's source code:

  ```
  $ git clone git@github.com:joyent/sdc-volapi.git
  $ cd sdc-volapi
  ```

2. Install and enable the VOLAPI service:

  ```
  $ sh tools/setup/setup.sh $DC_NAME
  ```

  where `$DC_NAME` is the name of the datacenter in which the VOLAPI service
  should be installed. By default, the installation process will use `coal` as
  the datacenter name.

3. Install the latest version of node-triton to get NFS shared volumes support:

   ```
   $ npm install -g triton
   ```

#### Disclaimer

Running `tools/setup/setup.sh` goes through all the steps necessary to enable
support for NFS shared volumes in any datacenter (including COAL). It updates
other core Triton services, such as sdc-docker, to different versions from
feature branches that include changes needed to support shared volumes
management. It also adds packages into PAPI and services into SAPI, among other
things.

As a result, when enabling this new service in COAL, it is no longer possible to
update services that play a role in supporting NFS shared volumes as usual. For
instance, updating the Docker API to the latest development version from the
master branch would break support for `tritonnfs` volumes.

The feature branches of all the repositories that are used to support the
Volumes API are regularly rebased on top of the current development (master)
branch, but not immediately. Thus, running this script is not recommended when
the ability to use latest development features of Triton is needed at all times.

There is also not automated procedure for uninstalling support for the Volumes
API, and going back to using the latest development branch (master) for all
Triton repositories.

In other words, __use at your own risk__.

## Contributing changes

Before commiting/pushing run `make prepush` and, if possible, get a code
review.

# Testing

## Running integration tests in COAL

    make test-integration-in-coal



