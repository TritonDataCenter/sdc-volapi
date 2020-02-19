#!/usr/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'

set -o xtrace
set -o errexit
set -o pipefail

#
# The presence of the /var/svc/.ran-user-script file indicates that the
# instance has already been setup (i.e. the instance has booted previously).
#
# This userscript supports both the old (version 1 node NFS server) and the
# new (version 2 in-zone SmartOS NFS server) versions.
#
# For version 1, upon first boot, run the setup.sh script if present. On all
# boots including the first one, run the configure.sh script if present.
#
# For version 2, upon first boot, enable the bind service and then enable the
# zfs NFS share.
#

SENTINEL=/var/svc/.ran-user-script

DIR=/opt/smartdc/boot

if [[ ! -e ${SENTINEL} ]]; then
    if [[ -f ${DIR}/setup.sh ]]; then
        # This is version 1.
        ${DIR}/setup.sh 2>&1 | tee /var/svc/setup.log
    else
        # This is version 2.
        /usr/sbin/svcadm enable bind
        /usr/sbin/zfs set sharenfs='anon=0,root_mapping=nobody' "zones/$(/usr/bin/zonename)/data"
    fi

    touch ${SENTINEL}
fi

if [[ -f ${DIR}/configure.sh ]]; then
    # This is version 1.
    exec ${DIR}/configure.sh
fi
