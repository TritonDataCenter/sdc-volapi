<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2016, Joyent, Inc.
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

```
$ git clone git@github.com:joyent/sdc-volapi.git
$ cd sdc-volapi
$ sh tools/setup/coal-setup.sh
```

## Contributing changes

Before commiting/pushing run `make prepush` and, if possible, get a code
review.

# Testing

## Running integration tests in COAL

    make test-integration-in-coal



