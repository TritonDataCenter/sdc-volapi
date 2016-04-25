#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: '\
        '${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail

TOP=$(cd $(dirname $0)/../../; pwd)

export USER_SCRIPT=$(ssh coal cat /opt/smartdc/sdcadm/etc/setup/user-script)
export VMAPI_IP=$(ssh coal vmadm list -o alias,nics.0.ip | grep vmapi | \
    tr -s ' ' | cut -d ' ' -f 2)
export CNAPI_IP=$(ssh coal vmadm list -o alias,nics.0.ip | grep cnapi | \
    tr -s ' ' | cut -d ' ' -f 2)
export SAPI_IP=$(ssh coal vmadm list -o alias,nics.0.ip | grep sapi | \
    tr -s ' ' | cut -d ' ' -f 2)
export PAPI_IP=$(ssh coal vmadm list -o alias,nics.0.ip | grep papi | \
    tr -s ' ' | cut -d ' ' -f 2)
export IMGAPI_IP=$(ssh coal vmadm list -o alias,nics.0.ip | grep imgapi | \
    tr -s ' ' | cut -d ' ' -f 2)
export UFDS_IP=$(ssh coal vmadm list -o alias,nics.0.ip | grep ufds | \
    tr -s ' ' | cut -d ' ' -f 2)

node ${TOP}/tools/setup/coal-setup.js

echo "Restarting sdc-docker to account for configuration changes..."
ssh coal /opt/smartdc/bin/sdc-login -l docker svcadm restart config-agent
ssh coal /opt/smartdc/bin/sdc-login -l docker svcadm restart docker
echo "sdc-docker restarted!"